// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal Morpho Blue interface (https://github.com/morpho-org/morpho-blue).
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

interface IMorpho {
    function position(bytes32 id, address user) external view returns (Position memory);
    function market(bytes32 id) external view returns (Market memory);
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
    function setAuthorization(address authorized, bool newIsAuthorized) external;

    function supply(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;
    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;
    function borrow(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
    function repay(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
    function accrueInterest(MarketParams memory marketParams) external;
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IOracle {
    function price() external view returns (uint256);
}
