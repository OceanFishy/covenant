// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal Pendle V2 core interfaces. Covenant only uses mint/redeem on the YT and
/// SY contracts. The Pendle router and markets (AMM) are never called.
interface IPYieldToken {
    /// Mints PT + YT from SY previously transferred to this contract.
    function mintPY(address receiverPT, address receiverYT) external returns (uint256 amountPYOut);

    /// Redeems PT (+ equal YT before expiry) previously transferred to this contract for SY.
    function redeemPY(address receiver) external returns (uint256 amountSyOut);

    function PT() external view returns (address);
    function SY() external view returns (address);
    function expiry() external view returns (uint256);
    function isExpired() external view returns (bool);
}

interface IStandardizedYield {
    function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut)
        external
        payable
        returns (uint256 amountSharesOut);

    function redeem(
        address receiver,
        uint256 amountSharesToRedeem,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external returns (uint256 amountTokenOut);

    function previewRedeem(address tokenOut, uint256 amountSharesToRedeem) external view returns (uint256);
    function previewDeposit(address tokenIn, uint256 amountTokenToDeposit) external view returns (uint256);
}
