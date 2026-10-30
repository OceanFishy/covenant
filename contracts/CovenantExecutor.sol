// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantCore} from "./CovenantCore.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IAavePool} from "./interfaces/IAave.sol";

/// @title CovenantExecutor
/// @notice Personal, non-upgradeable executor that runs an ordered list of calls in one
/// transaction on behalf of a single owner (a Ledger EOA); see {CovenantCore} for the engine.
/// Plans pull what they need from the owner (one-time approvals), work with it here, and
/// every listed leftover is swept back to the owner at the end. Aave v3 positions are reached
/// through the same allowlist; their live amounts (aToken and variable debt token balances)
/// are read with the BALANCE patch source.
///
/// The allowlist is owner-managed and stored here (rules at slot 0, recipients at slot 1).
contract CovenantExecutor is CovenantCore {
    address public immutable owner;

    mapping(address target => mapping(bytes4 selector => uint256 rule)) public rules;
    mapping(address token => mapping(address recipient => bool)) public allowedRecipient;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        IMorpho morpho_,
        IAavePool aavePool_,
        RuleInit[] memory rules_,
        RecipientInit[] memory recipients_
    ) CovenantCore(morpho_, aavePool_) {
        owner = owner_;
        _allowGuards();
        _setRules(rules_, recipients_);
    }

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

    // ---------------------------------------------------------------- hooks

    function _ruleOf(address target, bytes4 selector) internal view override returns (uint256) {
        return rules[target][selector];
    }

    function _isRecipient(address token, address recipient) internal view override returns (bool) {
        return allowedRecipient[token][recipient];
    }

    function _storeRule(address target, bytes4 selector, uint256 rule) internal override {
        rules[target][selector] = rule;
    }

    function _storeRecipient(address token, address recipient, bool allowed) internal override {
        allowedRecipient[token][recipient] = allowed;
    }

    function _owner() internal view override returns (address) {
        return owner;
    }

    /// Everything here belongs to the running plan: the Executor starts and ends empty.
    function _owned(address token) internal view override returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
