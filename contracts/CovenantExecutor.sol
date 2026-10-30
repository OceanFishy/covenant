// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IMorpho, IOracle, MarketParams, Market, Position} from "./interfaces/IMorpho.sol";

/// @title CovenantExecutor
/// @notice Personal, non-upgradeable executor that runs an ordered list of calls in one
/// transaction on behalf of a single owner (a Ledger EOA). Amounts can be filled in at
/// execution time ("patches"), and a Morpho Blue flash loan can wrap a nested call list.
///
/// Every call is checked against an owner-managed allowlist of (target, selector) rules.
/// A rule can also require that given argument words equal the owner or this contract
/// (receivers / onBehalf), and that an ERC-20 transfer/approve recipient is allowlisted
/// for that token. The Pendle router and markets are never allowlisted, so Pendle assets
/// can only be minted and redeemed, never traded.
contract CovenantExecutor {
    // ---------------------------------------------------------------- types

    enum Source {
        BALANCE, // args: (address token, address account)
        MORPHO_COLLATERAL, // args: (bytes32 id, address user)
        MORPHO_BORROW_SHARES, // args: (bytes32 id, address user)
        MORPHO_DEBT_ASSETS // args: (bytes32 id, address user), rounded up; accrue interest first
    }

    struct Patch {
        uint32 offset; // byte offset in `data` of the uint256 word to overwrite (>= 4)
        Source source;
        bytes args;
        uint32 bps; // scale, 10_000 = 100%
    }

    struct Call {
        address target;
        bytes data;
        Patch[] patches;
    }

    struct RuleInit {
        address target;
        bytes4 selector;
        uint256 rule;
    }

    struct RecipientInit {
        address token;
        address recipient;
    }

    // ---------------------------------------------------------------- rules

    /// Bit 0: the call is allowed.
    uint256 public constant ALLOWED = 1;
    /// Bit 255: argument word 0 must be an allowlisted recipient for `target` (or the owner).
    uint256 public constant RECIPIENT_CHECK = 1 << 255;
    // Bits 1..254: bit (i + 1) set means argument word i must be the owner or this contract.

    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    uint256 private constant WAD = 1e18;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    address public immutable owner;
    IMorpho public immutable morpho;

    mapping(address target => mapping(bytes4 selector => uint256 rule)) public rules;
    mapping(address token => mapping(address recipient => bool)) public allowedRecipient;

    bool private transient executing;

    // ---------------------------------------------------------------- events / errors

    event Executed(bytes32 indexed planHash, uint256 calls);
    event RuleSet(address indexed target, bytes4 indexed selector, uint256 rule);
    event RecipientSet(address indexed token, address indexed recipient, bool allowed);

    error NotOwner();
    error NotMorpho();
    error Reentrant();
    error NotExecuting();
    error CallNotAllowed(address target, bytes4 selector);
    error ArgNotSelfOrOwner(address target, bytes4 selector, uint256 word);
    error RecipientNotAllowed(address token, address recipient);
    error BadPatch(uint256 offset);
    error CallFailed(uint256 index, address target, bytes reason);
    error TransferFailed(address token);
    error BalanceTooLow(address token, uint256 balance, uint256 min);
    error DebtRemaining(bytes32 id, uint256 borrowShares);
    error HealthTooLow(bytes32 id, uint256 health, uint256 min);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, IMorpho morpho_, RuleInit[] memory rules_, RecipientInit[] memory recipients_) {
        owner = owner_;
        morpho = morpho_;

        // Guards are view functions on this contract, callable from plans.
        _setRule(address(this), CovenantExecutor.assertMinBalance.selector, ALLOWED);
        _setRule(address(this), CovenantExecutor.assertNoDebt.selector, ALLOWED);
        _setRule(address(this), CovenantExecutor.assertMinHealth.selector, ALLOWED);

        for (uint256 i; i < rules_.length; ++i) {
            _setRule(rules_[i].target, rules_[i].selector, rules_[i].rule);
        }
        for (uint256 i; i < recipients_.length; ++i) {
            _setRecipient(recipients_[i].token, recipients_[i].recipient, true);
        }
    }

    // ---------------------------------------------------------------- execution

    /// @notice Runs `calls` in order, then sends this contract's full balance of each
    /// `sweep` token to the owner. Reverts entirely if any call or guard fails.
    function execute(Call[] memory calls, address[] calldata sweep, bytes32 planHash) external onlyOwner {
        if (executing) revert Reentrant();
        executing = true;

        _run(calls);

        for (uint256 i; i < sweep.length; ++i) {
            uint256 bal = IERC20(sweep[i]).balanceOf(address(this));
            if (bal != 0) _safeTransfer(sweep[i], owner, bal);
        }

        executing = false;
        emit Executed(planHash, calls.length);
    }

    /// @notice Morpho Blue flash loan callback. `data` is abi.encode(token, Call[]).
    /// Only accepted from Morpho while `execute` is running.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        if (!executing) revert NotExecuting();

        (address token, Call[] memory inner) = abi.decode(data, (address, Call[]));
        _run(inner);

        // Morpho pulls the loan back with transferFrom after this returns.
        _approve(token, address(morpho), assets);
    }

    function _run(Call[] memory calls) internal {
        for (uint256 i; i < calls.length; ++i) {
            Call memory c = calls[i];
            _applyPatches(c);
            _check(c.target, c.data);

            (bool ok, bytes memory ret) = c.target.call(c.data);
            if (!ok) revert CallFailed(i, c.target, ret);
        }
    }

    function _applyPatches(Call memory c) internal view {
        bytes memory data = c.data;
        for (uint256 j; j < c.patches.length; ++j) {
            Patch memory p = c.patches[j];
            if (p.offset < 4 || uint256(p.offset) + 32 > data.length) revert BadPatch(p.offset);

            uint256 value = _resolve(p.source, p.args);
            if (p.bps != 10_000) value = value * p.bps / 10_000;

            uint256 offset = p.offset;
            assembly ("memory-safe") {
                mstore(add(add(data, 32), offset), value)
            }
        }
    }

    function _resolve(Source source, bytes memory args) internal view returns (uint256) {
        if (source == Source.BALANCE) {
            (address token, address account) = abi.decode(args, (address, address));
            return IERC20(token).balanceOf(account);
        }
        (bytes32 id, address user) = abi.decode(args, (bytes32, address));
        Position memory pos = morpho.position(id, user);
        if (source == Source.MORPHO_COLLATERAL) return pos.collateral;
        if (source == Source.MORPHO_BORROW_SHARES) return pos.borrowShares;
        return _debtAssets(id, pos.borrowShares);
    }

    function _check(address target, bytes memory data) internal view {
        bytes4 selector = bytes4(data);
        uint256 rule = rules[target][selector];
        if (data.length < 4 || rule & ALLOWED == 0) revert CallNotAllowed(target, selector);

        if (rule & RECIPIENT_CHECK != 0) {
            address to = _argAddress(target, selector, data, 0);
            if (to != owner && !allowedRecipient[target][to]) revert RecipientNotAllowed(target, to);
        }

        uint256 words = (rule & ~RECIPIENT_CHECK) >> 1;
        for (uint256 i; words != 0; ++i) {
            if (words & 1 != 0) {
                address a = _argAddress(target, selector, data, i);
                if (a != owner && a != address(this)) revert ArgNotSelfOrOwner(target, selector, i);
            }
            words >>= 1;
        }
    }

    function _argAddress(address target, bytes4 selector, bytes memory data, uint256 i)
        internal
        pure
        returns (address)
    {
        if (data.length < 4 + 32 * (i + 1)) revert ArgNotSelfOrOwner(target, selector, i);
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(add(data, 36), mul(i, 32)))
        }
        if (word >> 160 != 0) revert ArgNotSelfOrOwner(target, selector, i);
        return address(uint160(word));
    }

    // ---------------------------------------------------------------- guards

    function assertMinBalance(address token, address account, uint256 min) external view {
        uint256 bal = IERC20(token).balanceOf(account);
        if (bal < min) revert BalanceTooLow(token, bal, min);
    }

    function assertNoDebt(bytes32 id, address user) external view {
        uint256 shares = morpho.position(id, user).borrowShares;
        if (shares != 0) revert DebtRemaining(id, shares);
    }

    /// @param minHealth Minimum health factor in WAD (1e18 = liquidation threshold).
    function assertMinHealth(bytes32 id, address user, uint256 minHealth) external view {
        uint256 h = healthFactor(id, user);
        if (h < minHealth) revert HealthTooLow(id, h, minHealth);
    }

    /// @notice Health factor in WAD, using the market's last-accrued totals.
    /// Returns type(uint256).max when there is no debt.
    function healthFactor(bytes32 id, address user) public view returns (uint256) {
        Position memory pos = morpho.position(id, user);
        uint256 debt = _debtAssets(id, pos.borrowShares);
        if (debt == 0) return type(uint256).max;

        MarketParams memory params = morpho.idToMarketParams(id);
        uint256 price = IOracle(params.oracle).price();
        uint256 maxBorrow = uint256(pos.collateral) * price / ORACLE_PRICE_SCALE * params.lltv / WAD;
        return maxBorrow * WAD / debt;
    }

    /// @notice Debt in loan-token units (rounded up) from the market's last-accrued totals.
    function debtOf(bytes32 id, address user) external view returns (uint256) {
        return _debtAssets(id, morpho.position(id, user).borrowShares);
    }

    function _debtAssets(bytes32 id, uint256 shares) internal view returns (uint256) {
        if (shares == 0) return 0;
        Market memory m = morpho.market(id);
        uint256 num = shares * (uint256(m.totalBorrowAssets) + VIRTUAL_ASSETS);
        uint256 den = uint256(m.totalBorrowShares) + VIRTUAL_SHARES;
        return (num + den - 1) / den;
    }

    // ---------------------------------------------------------------- admin

    function setRule(address target, bytes4 selector, uint256 rule) external onlyOwner {
        _setRule(target, selector, rule);
    }

    function setRecipient(address token, address recipient, bool allowed) external onlyOwner {
        _setRecipient(token, recipient, allowed);
    }

    /// @notice Sends any tokens left in this contract to the owner.
    function rescue(address token) external onlyOwner {
        if (executing) revert Reentrant();
        _safeTransfer(token, owner, IERC20(token).balanceOf(address(this)));
    }

    function _setRule(address target, bytes4 selector, uint256 rule) internal {
        rules[target][selector] = rule;
        emit RuleSet(target, selector, rule);
    }

    function _setRecipient(address token, address recipient, bool allowed) internal {
        allowedRecipient[token][recipient] = allowed;
        emit RecipientSet(token, recipient, allowed);
    }

    // ---------------------------------------------------------------- token helpers

    function _safeTransfer(address token, address to, uint256 amount) internal {
        _callToken(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// Resets a non-zero allowance first: USDT reverts on approving non-zero to non-zero.
    function _approve(address token, address spender, uint256 amount) internal {
        if (IERC20(token).allowance(address(this), spender) != 0) {
            _callToken(token, abi.encodeCall(IERC20.approve, (spender, 0)));
        }
        _callToken(token, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    /// Accepts tokens that return nothing (e.g. USDT) as well as those returning true.
    function _callToken(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) {
            revert TransferFailed(token);
        }
    }
}
