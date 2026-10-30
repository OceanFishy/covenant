// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal Aave v4 interfaces (https://github.com/aave/aave-v4).
///
/// A Spoke only lets `onBehalfOf` itself, or a governance-activated position manager the user
/// approved, act on a position. Under EIP-7702 your account is the caller and uses the Spoke
/// directly; a personal Executor can't be activated, so it goes through Aave's own managers: the
/// Giver (supply / repay for anyone) and the Taker (withdraw / borrow up to per-reserve
/// allowances the user grants to a spender).

struct UserAccountData {
    uint256 riskPremium;
    uint256 avgCollateralFactor;
    uint256 healthFactor; // WAD; type(uint256).max without debt
    uint256 totalCollateralValue;
    uint256 totalDebtValueRay;
    uint256 activeCollateralCount;
    uint256 borrowCount;
}

interface IAaveV4Spoke {
    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
    function getUserAccountData(address user) external view returns (UserAccountData memory);
    function setUserPositionManager(address positionManager, bool approve) external;
    function isPositionManager(address user, address positionManager) external view returns (bool);
    /// Caller must be `onBehalfOf` (or its position manager). Withdraw / borrow pay the caller;
    /// supply / repay pull from it. A repay above the debt is capped at the debt.
    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}

/// Pulls the underlying from the caller; repay is capped at the user's debt and rejects max.
interface IAaveV4Giver {
    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
    function repayOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
}

/// Sends the withdrawn / borrowed underlying to the caller (the allowance's spender).
interface IAaveV4Taker {
    function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount) external;
    function approveBorrow(address spoke, uint256 reserveId, address spender, uint256 amount) external;
    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
    function borrowOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
    function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256);
    function borrowAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256);
}
