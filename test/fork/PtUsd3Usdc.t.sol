// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";

import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {Position} from "../../contracts/interfaces/IMorpho.sol";
import {LoopForkBase} from "../utils/LoopForkBase.sol";
import {Plans} from "../utils/Plans.sol";

/// Mainnet-fork tests for the PT-USD3 / USDC loops on Morpho Blue (markets A and B, LLTV 86%).
/// Run with MAINNET_RPC_URL set: `pnpm test:fork`.
contract PtUsd3UsdcForkTest is LoopForkBase {
    /// Real borrowers at the time of writing.
    address constant BORROWER_A = 0xa95d6286853320487cB0897304ad8A210F8D12c4; // ~597k PT, ~447k USDC debt
    address constant BORROWER_B = 0x7A27F9586d0895F045b80B3Fb1D9D6eF4D54e9Bc; // ~1.26M PT, ~1.03M USDC debt

    function _flashUnwindReal(bytes32 id, address borrower) internal {
        (uint256 collateral, uint256 yt0) = _prepareRealBorrower(id, borrower);
        CovenantExecutor exec = _deployFor(borrower);
        uint256 usdc0 = IERC20(M.USDC).balanceOf(borrower);
        uint256 health0 = exec.healthFactor(id, borrower);

        _execute(exec, borrower, Plans.flashUnwind(_loop(exec, borrower, id), collateral, 0, _noSwap()));

        _assertClosed(id, borrower, yt0, exec);
        uint256 received = IERC20(M.USDC).balanceOf(borrower) - usdc0;
        assertGt(received, 0, "no equity returned");
        console.log("PT collateral (6dp):", collateral);
        console.log("health factor before (1e18):", health0);
        console.log("USDC equity received (6dp):", received);
    }

    /// M0 exit criterion: flash-unwind a real PT-USD3 Morpho loop in one transaction.
    function test_flashUnwind_realPosition_marketA() public {
        _flashUnwindReal(M.MKT_PT_USD3_USDC_A, BORROWER_A);
    }

    function test_flashUnwind_realPosition_marketB() public {
        _flashUnwindReal(M.MKT_PT_USD3_USDC_B, BORROWER_B);
    }

    function _open(bytes32 id, address owner, uint256 equity, uint256 flash) internal returns (CovenantExecutor exec) {
        _ensureDepositCapacity(equity + flash);
        _supplyLiquidity(id, flash * 2);
        exec = _deployFor(owner);
        deal(M.USDC, owner, equity);
        _execute(exec, owner, Plans.enter(_loop(exec, owner, id), equity, flash, 1.02e18, _noSwap()));
    }

    function _enterThenFlashUnwind(bytes32 id) internal {
        address owner = makeAddr("ledger");
        uint256 equity = 10_000e6;
        CovenantExecutor exec = _open(id, owner, equity, 20_000e6);

        Position memory pos = morpho.position(id, owner);
        assertGt(pos.collateral, 0, "no collateral");
        assertGt(pos.borrowShares, 0, "no debt");
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), pos.collateral, "YT should match PT");
        assertGe(exec.healthFactor(id, owner), 1.02e18);
        assertEq(IERC20(M.USDC).balanceOf(owner), 0);
        _assertExecutorEmpty(exec);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1 days);

        _execute(exec, owner, Plans.flashUnwind(_loop(exec, owner, id), pos.collateral, 0, _noSwap()));

        _assertClosed(id, owner, 0, exec);
        uint256 out = IERC20(M.USDC).balanceOf(owner);
        console.log("equity in / out (6dp):", equity, out);
        assertApproxEqRel(out, equity, 0.01e18, "round trip lost more than 1%");
    }

    function test_enterThenFlashUnwind_marketA() public {
        _enterThenFlashUnwind(M.MKT_PT_USD3_USDC_A);
    }

    function test_enterThenFlashUnwind_marketB() public {
        _enterThenFlashUnwind(M.MKT_PT_USD3_USDC_B);
    }

    /// YT covers only part of the PT: withdraw just the matched PT, never sell the rest (§6.3).
    function test_matchedUnwind_ytShortfall() public {
        bytes32 id = M.MKT_PT_USD3_USDC_A;
        address owner = makeAddr("ledger");
        CovenantExecutor exec = _open(id, owner, 10_000e6, 20_000e6);

        // Owner moves 40% of their YT elsewhere.
        uint256 yt = IERC20(M.YT_USD3).balanceOf(owner);
        vm.prank(owner);
        IERC20(M.YT_USD3).transfer(address(0xdead), yt * 40 / 100);

        Position memory before = morpho.position(id, owner);
        uint256 health0 = exec.healthFactor(id, owner);
        uint256 matched = IERC20(M.YT_USD3).balanceOf(owner);
        // Proceeds per PT ~ USDC deposited per PT minted (30k / collateral); repay 98% of that.
        uint256 repayAssets = matched * 30_000e6 / before.collateral * 98 / 100;

        _execute(exec, owner, Plans.matchedUnwind(_loop(exec, owner, id), matched, repayAssets, 1.02e18, _noSwap()));

        Position memory afterPos = morpho.position(id, owner);
        assertEq(afterPos.collateral, before.collateral - matched, "withdrew more than matched PT");
        assertLt(afterPos.borrowShares, before.borrowShares, "debt not reduced");
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), 0, "matched YT not consumed");
        assertGt(exec.healthFactor(id, owner), health0, "remaining loop should be safer");
        assertGt(IERC20(M.USDC).balanceOf(owner), 0, "no leftover USDC returned");
        _assertExecutorEmpty(exec);
    }
}
