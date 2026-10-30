// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantCore} from "./CovenantCore.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IAavePool} from "./interfaces/IAave.sol";

/// @title CovenantDelegate
/// @notice The Covenant engine ({CovenantCore}) as EIP-7702 delegation code: your EOA itself
/// runs plans, so nothing is pulled, approved to an Executor or swept back, Morpho and Aave see
/// your address as the caller, and protocols that check the caller (e.g. Re's KYC) see you.
///
/// Code at a delegated EOA runs in the EOA's context and anyone can call it, so:
/// - Everything that acts is self-only: `msg.sender == address(this)`, i.e. a transaction you
///   send to your own address. Morpho's flash callback is accepted only while a plan runs.
/// - The allowlist lives in the EOA's storage under an ERC-7201 namespace and is written by
///   {CovenantDelegateMainnet-initialize} (and self-only setters), never by a constructor.
/// - A plan only spends what it is given. `execute` snapshots the wallet's balance of every
///   `tracked` token; a plan gets access to existing funds only through `allot(token, amount)`
///   calls (the 7702 counterpart of the Executor's pulls), Source.OWNED / {assertMinOwned}
///   see only allotted funds plus what the plan brought in, and at the end every tracked
///   balance must still be at least its snapshot minus the allotments.
/// - Allowances a plan grants (ERC-20 approve calls, the flash-loan repayment) are put back
///   to their previous value at the end, so none outlives the transaction.
/// - Being a wallet, it accepts ETH, ERC-721/1155 safe transfers, and ERC-1271 signatures
///   made by the EOA's own key.
abstract contract CovenantDelegate is CovenantCore {
    /// @custom:storage-location erc7201:covenant.delegate.v1
    struct Layout {
        mapping(address target => mapping(bytes4 selector => uint256 rule)) rules;
        mapping(address token => mapping(address recipient => bool)) recipients;
        uint256 configVersion;
    }

    /// keccak256(abi.encode(uint256(keccak256("covenant.delegate.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LAYOUT_SLOT = 0x7742a91c428d5f4d0ae4f71fc9890b6a2b35ca8734e78b55f6c273de2642f600;
    /// Transient: per tracked token, (snapshot − allotted) + 1; zero means "not tracked".
    bytes32 private constant FLOOR_NS = keccak256("covenant.delegate.floor");
    /// Transient: list of (token, spender, previous allowance) granted during the plan.
    bytes32 private constant GRANTS_NS = keccak256("covenant.delegate.grants");

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    error NotSelf();
    error NotTracked(address token);
    error AllotTooLarge(address token, uint256 amount, uint256 available);
    error Overspent(address token, uint256 balance, uint256 floor);

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(IMorpho morpho_, IAavePool aavePool_) CovenantCore(morpho_, aavePool_) {}

    // ---------------------------------------------------------------- execution

    /// @notice Runs `calls` from your own address. `tracked` lists every token the plan may
    /// touch in your wallet (see the contract notes). Reverts entirely if any call or guard
    /// fails, or if the plan spent more of a tracked token than it allotted.
    function execute(Call[] memory calls, address[] calldata tracked, bytes32 planHash) external onlySelf {
        if (executing) revert Reentrant();
        executing = true;

        for (uint256 i; i < tracked.length; ++i) {
            _tstore(_floorSlot(tracked[i]), IERC20(tracked[i]).balanceOf(address(this)) + 1);
        }

        _run(calls);
        _restoreAllowances();

        for (uint256 i; i < tracked.length; ++i) {
            bytes32 slot = _floorSlot(tracked[i]);
            uint256 marked = _tload(slot);
            if (marked == 0) continue; // listed twice, already checked
            uint256 floor = marked - 1;
            uint256 bal = IERC20(tracked[i]).balanceOf(address(this));
            if (bal < floor) revert Overspent(tracked[i], bal, floor);
            _tstore(slot, 0);
        }

        executing = false;
        emit Executed(planHash, calls.length);
    }

    /// @notice Lets the running plan use `amount` of `token` already in your wallet. Called
    /// from a plan (target = your address), like the Executor's pull from your wallet.
    function allot(address token, uint256 amount) external onlySelf {
        if (!executing) revert NotExecuting();
        bytes32 slot = _floorSlot(token);
        uint256 marked = _tload(slot);
        if (marked == 0) revert NotTracked(token);
        if (amount > marked - 1) revert AllotTooLarge(token, amount, marked - 1);
        _tstore(slot, marked - amount);
    }

    // ---------------------------------------------------------------- allowlist

    function rules(address target, bytes4 selector) external view returns (uint256) {
        return _layout().rules[target][selector];
    }

    function allowedRecipient(address token, address recipient) external view returns (bool) {
        return _layout().recipients[token][recipient];
    }

    /// @notice Version of the allowlist written by the last `initialize` (0: never initialized).
    function configVersion() external view returns (uint256) {
        return _layout().configVersion;
    }

    function setRule(address target, bytes4 selector, uint256 rule) external onlySelf {
        _setRule(target, selector, rule);
    }

    function setRecipient(address token, address recipient, bool allowed) external onlySelf {
        _setRecipient(token, recipient, allowed);
    }

    /// Writes the guards, `allot` and the given allowlist, and records `version`.
    function _initialize(RuleInit[] memory rules_, RecipientInit[] memory recipients_, uint256 version) internal {
        _allowGuards();
        _setRule(address(this), CovenantDelegate.allot.selector, ALLOWED);
        _setRules(rules_, recipients_);
        _layout().configVersion = version;
    }

    // ---------------------------------------------------------------- wallet

    receive() external payable {}

    /// @notice ERC-1271: a signature is valid if your own key made it (65-byte r‖s‖v, low s).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        if (uint256(s) > HALF_N) return 0xffffffff;
        address signer = ecrecover(hash, v, r, s);
        return signer != address(0) && signer == address(this) ? ERC1271_MAGIC : bytes4(0xffffffff);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// @notice ERC-165 (for ERC-165 itself, ERC-721 and ERC-1155 receivers).
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x150b7a02 || id == 0x4e2312e0;
    }

    // ---------------------------------------------------------------- hooks

    function _ruleOf(address target, bytes4 selector) internal view override returns (uint256) {
        return _layout().rules[target][selector];
    }

    function _isRecipient(address token, address recipient) internal view override returns (bool) {
        return _layout().recipients[token][recipient];
    }

    function _storeRule(address target, bytes4 selector, uint256 rule) internal override {
        _layout().rules[target][selector] = rule;
    }

    function _storeRecipient(address token, address recipient, bool allowed) internal override {
        _layout().recipients[token][recipient] = allowed;
    }

    /// The EOA is both the owner and the executor.
    function _owner() internal view override returns (address) {
        return address(this);
    }

    /// What the plan brought in plus what it allotted: balance − (snapshot − allotted).
    function _owned(address token) internal view override returns (uint256) {
        uint256 marked = _tload(_floorSlot(token));
        if (marked == 0) revert NotTracked(token);
        uint256 bal = IERC20(token).balanceOf(address(this));
        return bal > marked - 1 ? bal - (marked - 1) : 0;
    }

    /// Records the allowance an approve is about to replace, once per (token, spender).
    function _beforeCall(address target, bytes memory data) internal override {
        if (bytes4(data) != IERC20.approve.selector) return;
        address spender = _argAddress(target, IERC20.approve.selector, data, 0);
        bytes32 seen = keccak256(abi.encode(GRANTS_NS, target, spender));
        if (_tload(seen) != 0) return;
        _tstore(seen, 1);

        uint256 n = _tload(GRANTS_NS);
        bytes32 base = _grantSlot(n);
        uint256 previous = IERC20(target).allowance(address(this), spender);
        _tstore(base, uint256(uint160(target)));
        _tstore(bytes32(uint256(base) + 1), uint256(uint160(spender)));
        _tstore(bytes32(uint256(base) + 2), previous);
        _tstore(GRANTS_NS, n + 1);
        // Your wallet may already allow this spender (e.g. USDT to Morpho), and USDT rejects
        // approving non-zero over non-zero: clear it; it is put back after the plan.
        if (previous != 0) _callToken(target, abi.encodeCall(IERC20.approve, (spender, 0)));
    }

    function _restoreAllowances() private {
        uint256 n = _tload(GRANTS_NS);
        for (uint256 i; i < n; ++i) {
            bytes32 base = _grantSlot(i);
            address token = address(uint160(_tload(base)));
            address spender = address(uint160(_tload(bytes32(uint256(base) + 1))));
            uint256 previous = _tload(bytes32(uint256(base) + 2));
            if (IERC20(token).allowance(address(this), spender) != previous) _approve(token, spender, previous);
            _tstore(keccak256(abi.encode(GRANTS_NS, token, spender)), 0);
        }
        _tstore(GRANTS_NS, 0);
    }

    // ---------------------------------------------------------------- storage helpers

    function _layout() private pure returns (Layout storage l) {
        assembly ("memory-safe") {
            l.slot := LAYOUT_SLOT
        }
    }

    function _floorSlot(address token) private pure returns (bytes32) {
        return keccak256(abi.encode(FLOOR_NS, token));
    }

    function _grantSlot(uint256 i) private pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(GRANTS_NS))) + 3 * i);
    }

    function _tload(bytes32 slot) private view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _tstore(bytes32 slot, uint256 v) private {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }
}
