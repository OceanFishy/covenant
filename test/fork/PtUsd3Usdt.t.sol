// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";

import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {Position} from "../../contracts/interfaces/IMorpho.sol";
import {LoopForkBase} from "../utils/LoopForkBase.sol";
import {Plans} from "../utils/Plans.sol";

/// Mainnet-fork tests for the PT-USD3 / USDT loop (LLTV 91.5%). SY-USD3 only redeems to
/// USDC/USD3, so USDC <-> USDT goes through a DEX aggregator with a live route fetched by
/// scripts/quote.mjs (0x if ZEROX_API_KEY is set, else KyberSwap).
/// Needs network access and ffi: `pnpm test:fork:aggregator`.
contract PtUsd3UsdtForkTest is LoopForkBase {
    bytes32 constant ID = M.MKT_PT_USD3_USDT;
    address constant BORROWER = 0x7A27F9586d0895F045b80B3Fb1D9D6eF4D54e9Bc; // ~793k PT, ~688k USDT debt

    function test_flashUnwind_realPosition_usdt() public {
        (uint256 collateral, uint256 yt0) = _prepareRealBorrower(ID, BORROWER);
        CovenantExecutor exec = _deployFor(BORROWER);
        uint256 usdc0 = IERC20(M.USDC).balanceOf(BORROWER);
        uint256 usdt0 = IERC20(M.USDT).balanceOf(BORROWER);

        _flashUnwindWithRequote(exec, BORROWER, ID, collateral);

        _assertClosed(ID, BORROWER, yt0, exec);
        uint256 usdc = IERC20(M.USDC).balanceOf(BORROWER) - usdc0;
        uint256 usdtDust = IERC20(M.USDT).balanceOf(BORROWER) - usdt0;
        console.log("PT collateral (6dp):", collateral);
        console.log("USDC equity received (6dp):", usdc);
        console.log("leftover USDT returned (6dp):", usdtDust);
        assertGt(usdc, 0, "no equity returned");
        assertLt(usdtDust, usdc / 100, "most equity should come back as USDC");
    }

    function test_enterThenFlashUnwind_usdt() public {
        address owner = makeAddr("ledger");
        uint256 equity = 10_000e6;
        uint256 flash = 20_000e6;
        _ensureDepositCapacity(equity + flash * 2);
        _supplyLiquidity(ID, flash * 2);
        CovenantExecutor exec = _deployFor(owner);
        deal(M.USDC, owner, equity);

        // Entry: flash USDT, sell it for USDC, mint PT+YT, borrow USDT to repay.
        (Plans.Swap memory entrySwap, uint256 quoted) = _quote(M.USDT, M.USDC, flash, address(exec));
        entrySwap.minOut = quoted * 997 / 1000;
        _execute(exec, owner, Plans.enter(_loop(exec, owner, ID), equity, flash, 1.02e18, entrySwap));

        Position memory pos = morpho.position(ID, owner);
        assertGt(pos.collateral, 0);
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), pos.collateral, "YT should match PT");
        assertGe(exec.healthFactor(ID, owner), 1.02e18);
        _assertExecutorEmpty(exec);

        _flashUnwindWithRequote(exec, owner, ID, pos.collateral);

        _assertClosed(ID, owner, 0, exec);
        uint256 out = IERC20(M.USDC).balanceOf(owner) + IERC20(M.USDT).balanceOf(owner);
        console.log("equity in / out USDC+USDT (6dp):", equity, out);
        assertApproxEqRel(out, equity, 0.01e18, "round trip lost more than 1%");
    }
}
