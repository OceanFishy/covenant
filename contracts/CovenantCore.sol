// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IMorpho, IOracle, MarketParams, Market, Position} from "./interfaces/IMorpho.sol";
import {IAavePool} from "./interfaces/IAave.sol";
import {IAaveV4Spoke} from "./interfaces/IAaveV4.sol";

/// @title CovenantCore
/// @notice The execution engine shared by the deployed Executor ({CovenantExecutor}) and the
/// EIP-7702 delegate ({CovenantDelegate}): it runs an ordered list of calls, fills in amounts
/// at execution time ("patches"), wraps nested calls in a Morpho Blue flash loan, and checks
/// every call against an allowlist of (target, selector) rules. A rule can also require that
/// given argument words equal the owner or this contract (receivers / onBehalf), and that an
/// ERC-20 transfer/approve recipient is allowlisted for that token. The Pendle router and
/// markets are never allowlisted, so Pendle assets can only be minted and redeemed.
///
/// Where the allowlist lives, who the owner is and what "the plan's own balance" means are
/// left to the two concrete contracts.
abstract contract CovenantCore {
    // ---------------------------------------------------------------- types

    enum Source {
        BALANCE, // args: (address token, address account): balanceOf(account)
        MORPHO_COLLATERAL, // args: (bytes32 id, address user)
        MORPHO_BORROW_SHARES, // args: (bytes32 id, address user)
        MORPHO_DEBT_ASSETS, // args: (bytes32 id, address user), rounded up; accrue interest first
        OWNED, // args: (address token): what the plan itself holds of `token` (see {_owned})
        AAVE_V4_DEBT // args: (address spoke, uint256 reserveId, address user): drawn + premium debt
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

    IMorpho public immutable morpho;
    IAavePool public immutable aavePool;

    bool internal transient executing;

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
    error BalanceTooHigh(address token, uint256 balance, uint256 max);
    error DebtRemaining(bytes32 id, uint256 borrowShares);
    error HealthTooLow(bytes32 id, uint256 health, uint256 min);
    error AaveHealthTooLow(address user, uint256 health, uint256 min);
    error AaveV4HealthTooLow(address spoke, address user, uint256 health, uint256 min);
    error AaveV4DebtRemaining(address spoke, uint256 reserveId, uint256 debt);

    constructor(IMorpho morpho_, IAavePool aavePool_) {
        morpho = morpho_;
        aavePool = aavePool_;
    }

    // ---------------------------------------------------------------- hooks

    function _ruleOf(address target, bytes4 selector) internal view virtual returns (uint256);
    function _isRecipient(address token, address recipient) internal view virtual returns (bool);
    function _storeRule(address target, bytes4 selector, uint256 rule) internal virtual;
    function _storeRecipient(address token, address recipient, bool allowed) internal virtual;

    /// The owner's address: receivers / onBehalf words may be the owner or this contract.
    function _owner() internal view virtual returns (address);

    /// What the plan itself holds of `token` (Source.OWNED, {assertMinOwned}).
    function _owned(address token) internal view virtual returns (uint256);

    /// Called after a call passed {_check} and right before it runs.
    function _beforeCall(address target, bytes memory data) internal virtual {}

    // ---------------------------------------------------------------- execution

    /// @notice Morpho Blue flash loan callback. `data` is abi.encode(token, Call[]).
    /// Only accepted from Morpho while a plan is running.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        if (!executing) revert NotExecuting();

        (address token, Call[] memory inner) = abi.decode(data, (address, Call[]));
        _run(inner);
        // Morpho pulls the loan back with transferFrom after this returns.
        _beforeCall(token, abi.encodeCall(IERC20.approve, (address(morpho), assets)));
        _approve(token, address(morpho), assets);
    }

    function _run(Call[] memory calls) internal {
        for (uint256 i; i < calls.length; ++i) {
            Call memory c = calls[i];
            _applyPatches(c);
            _check(c.target, c.data);
            _beforeCall(c.target, c.data);

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
        if (source == Source.OWNED) return _owned(abi.decode(args, (address)));
        if (source == Source.AAVE_V4_DEBT) {
            (address spoke, uint256 reserveId, address debtor) = abi.decode(args, (address, uint256, address));
            return IAaveV4Spoke(spoke).getUserTotalDebt(reserveId, debtor);
        }
        (bytes32 id, address user) = abi.decode(args, (bytes32, address));
        Position memory pos = morpho.position(id, user);
        if (source == Source.MORPHO_COLLATERAL) return pos.collateral;
        if (source == Source.MORPHO_BORROW_SHARES) return pos.borrowShares;
        return _debtAssets(id, pos.borrowShares);
    }

    function _check(address target, bytes memory data) internal view {
        bytes4 selector = bytes4(data);
        uint256 rule = _ruleOf(target, selector);
        if (data.length < 4 || rule & ALLOWED == 0) revert CallNotAllowed(target, selector);

        address owner_ = _owner();
        if (rule & RECIPIENT_CHECK != 0) {
            address to = _argAddress(target, selector, data, 0);
            if (to != owner_ && !_isRecipient(target, to)) revert RecipientNotAllowed(target, to);
        }

        uint256 words = (rule & ~RECIPIENT_CHECK) >> 1;
        for (uint256 i; words != 0; ++i) {
            if (words & 1 != 0) {
                address a = _argAddress(target, selector, data, i);
                if (a != owner_ && a != address(this)) revert ArgNotSelfOrOwner(target, selector, i);
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

    /// @notice The plan holds at least `min` of `token` ({_owned}): e.g. a swap's output, or what
    /// you receive. Equals `assertMinBalance(token, this, min)` on the deployed Executor.
    function assertMinOwned(address token, uint256 min) external view {
        uint256 bal = _owned(token);
        if (bal < min) revert BalanceTooLow(token, bal, min);
    }

    /// @notice E.g. `assertMaxBalance(variableDebtToken, owner, 0)`: no Aave debt left in that asset.
    function assertMaxBalance(address token, address account, uint256 max) external view {
        uint256 bal = IERC20(token).balanceOf(account);
        if (bal > max) revert BalanceTooHigh(token, bal, max);
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

    /// @param minHealth Minimum Aave v3 health factor in WAD (1e18 = liquidation threshold).
    /// A user with no debt has type(uint256).max, so this always passes for them.
    function assertMinAaveHealth(address user, uint256 minHealth) external view {
        (,,,,, uint256 h) = aavePool.getUserAccountData(user);
        if (h < minHealth) revert AaveHealthTooLow(user, h, minHealth);
    }

    /// @param minHealth Minimum Aave v4 health factor on `spoke` in WAD (1e18 = liquidation
    /// threshold). A user with no debt there has type(uint256).max.
    function assertMinAaveV4Health(address spoke, address user, uint256 minHealth) external view {
        uint256 h = IAaveV4Spoke(spoke).getUserAccountData(user).healthFactor;
        if (h < minHealth) revert AaveV4HealthTooLow(spoke, user, h, minHealth);
    }

    function assertNoAaveV4Debt(address spoke, uint256 reserveId, address user) external view {
        uint256 debt = IAaveV4Spoke(spoke).getUserTotalDebt(reserveId, user);
        if (debt != 0) revert AaveV4DebtRemaining(spoke, reserveId, debt);
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

    // ---------------------------------------------------------------- allowlist

    /// Guards are view functions on this contract, callable from plans.
    function _allowGuards() internal {
        _setRule(address(this), CovenantCore.assertMinBalance.selector, ALLOWED);
        _setRule(address(this), CovenantCore.assertMinOwned.selector, ALLOWED);
        _setRule(address(this), CovenantCore.assertMaxBalance.selector, ALLOWED);
        _setRule(address(this), CovenantCore.assertNoDebt.selector, ALLOWED);
        _setRule(address(this), CovenantCore.assertMinHealth.selector, ALLOWED);
        _setRule(address(this), CovenantCore.assertMinAaveHealth.selector, ALLOWED);
        _setRule(address(this), CovenantCore.assertMinAaveV4Health.selector, ALLOWED);
        _setRule(address(this), CovenantCore.assertNoAaveV4Debt.selector, ALLOWED);
    }

    function _setRules(RuleInit[] memory rules_, RecipientInit[] memory recipients_) internal {
        for (uint256 i; i < rules_.length; ++i) {
            _setRule(rules_[i].target, rules_[i].selector, rules_[i].rule);
        }
        for (uint256 i; i < recipients_.length; ++i) {
            _setRecipient(recipients_[i].token, recipients_[i].recipient, true);
        }
    }

    function _setRule(address target, bytes4 selector, uint256 rule) internal {
        _storeRule(target, selector, rule);
        emit RuleSet(target, selector, rule);
    }

    function _setRecipient(address token, address recipient, bool allowed) internal {
        _storeRecipient(token, recipient, allowed);
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
        if (amount != 0) _callToken(token, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    /// Accepts tokens that return nothing (e.g. USDT) as well as those returning true.
    function _callToken(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) {
            revert TransferFailed(token);
        }
    }
}
