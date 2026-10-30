// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";

import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams, Position} from "../../contracts/interfaces/IMorpho.sol";
import {Plans} from "../utils/Plans.sol";

interface IERC4626Limits {
    function maxDeposit(address) external view returns (uint256);
    function availableDepositLimit(address) external view returns (uint256);
}

/// Mainnet-fork tests for the PT-USD3 / USDC loop on Morpho Blue (market A, LLTV 86%).
/// Run with MAINNET_RPC_URL set: `pnpm test:fork`.
contract PtUsd3LoopForkTest is Test {
    IMorpho constant morpho = IMorpho(M.MORPHO);
    bytes32 constant ID = M.MKT_PT_USD3_USDC_A;

    /// A real borrower in market A at the time of writing (~597k PT collateral, ~447k USDC debt).
    address constant REAL_BORROWER = 0xa95d6286853320487cB0897304ad8A210F8D12c4;

    MarketParams params;

    function setUp() public {
        vm.createSelectFork("mainnet");
        params = morpho.idToMarketParams(ID);
    }

    // ------------------------------------------------------------ helpers

    function _deployFor(address owner) internal returns (CovenantExecutor exec) {
        exec = new CovenantExecutor(owner, morpho, M.rules(), M.recipients());
        // One-time setup from the Ledger (§5.2): authorize on Morpho, approve tokens to the Executor.
        vm.startPrank(owner);
        morpho.setAuthorization(address(exec), true);
        IERC20(M.YT_USD3).approve(address(exec), type(uint256).max);
        IERC20(M.USDC).approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    function _loop(CovenantExecutor exec, address owner) internal view returns (Plans.Loop memory) {
        return Plans.Loop({
            executor: address(exec),
            owner: owner,
            morpho: address(morpho),
            id: ID,
            params: params,
            loanToken: M.USDC,
            pt: M.PT_USD3,
            yt: M.YT_USD3,
            sy: M.SY_USD3,
            tokenOut: M.USDC // SY-USD3 redeems straight to USDC via 3Jane
        });
    }

    function _sweep() internal pure returns (address[] memory s) {
        s = new address[](5);
        (s[0], s[1], s[2], s[3], s[4]) = (M.USDC, M.PT_USD3, M.YT_USD3, M.SY_USD3, M.USD3);
    }

    function _assertExecutorEmpty(CovenantExecutor exec) internal view {
        address[] memory s = _sweep();
        for (uint256 i; i < s.length; ++i) {
            assertEq(IERC20(s[i]).balanceOf(address(exec)), 0, "executor holds tokens");
        }
    }

    function _execute(CovenantExecutor exec, address owner, CovenantExecutor.Call[] memory calls) internal {
        vm.prank(owner);
        exec.execute(calls, _sweep(), keccak256(abi.encode(calls)));
    }

    /// Opens a fresh loop for `owner` through the Executor (§7.4). Supplies lender liquidity
    /// first because the live market is ~100% utilized.
    function _openLoop(address owner, uint256 equity, uint256 flash) internal returns (CovenantExecutor exec) {
        // 3Jane caps USD3 deposits (and only whitelisted addresses like SY-USD3 may deposit).
        // When the live cap is too small, simulate capacity so the entry path can still be tested.
        uint256 cap = IERC4626Limits(M.USD3).maxDeposit(M.SY_USD3);
        if (cap < equity + flash) {
            console.log("live USD3 deposit cap too low; simulating capacity. cap (6dp):", cap);
            vm.mockCall(
                M.USD3,
                abi.encodeWithSelector(IERC4626Limits.availableDepositLimit.selector, M.SY_USD3),
                abi.encode(type(uint256).max)
            );
        }

        address lender = makeAddr("lender");
        deal(M.USDC, lender, flash * 2);
        vm.startPrank(lender);
        IERC20(M.USDC).approve(address(morpho), type(uint256).max);
        morpho.supply(params, flash * 2, 0, lender, "");
        vm.stopPrank();

        exec = _deployFor(owner);
        deal(M.USDC, owner, equity);
        _execute(exec, owner, Plans.enter(_loop(exec, owner), equity, flash, 1.02e18));
    }

    // ------------------------------------------------------------ tests

    /// M0 exit criterion: flash-unwind a real PT-USD3 Morpho loop in one transaction.
    function test_flashUnwind_realPosition() public {
        Position memory pos = morpho.position(ID, REAL_BORROWER);
        if (pos.borrowShares == 0) {
            console.log("reference borrower has no position at this block; skipping");
            vm.skip(true);
        }
        uint256 collateral = pos.collateral;

        // Give the borrower YT to match their PT, as if they held it in their wallet.
        uint256 yt0 = IERC20(M.YT_USD3).balanceOf(REAL_BORROWER);
        deal(M.YT_USD3, REAL_BORROWER, yt0 + collateral);

        CovenantExecutor exec = _deployFor(REAL_BORROWER);
        uint256 usdc0 = IERC20(M.USDC).balanceOf(REAL_BORROWER);
        uint256 health0 = exec.healthFactor(ID, REAL_BORROWER);

        _execute(exec, REAL_BORROWER, Plans.flashUnwind(_loop(exec, REAL_BORROWER), collateral, 0));

        pos = morpho.position(ID, REAL_BORROWER);
        assertEq(pos.borrowShares, 0, "debt left");
        assertEq(pos.collateral, 0, "collateral left");
        assertEq(IERC20(M.YT_USD3).balanceOf(REAL_BORROWER), yt0, "YT not exactly consumed");
        _assertExecutorEmpty(exec);

        uint256 received = IERC20(M.USDC).balanceOf(REAL_BORROWER) - usdc0;
        assertGt(received, 0, "no equity returned");
        console.log("PT collateral (6dp):", collateral);
        console.log("health factor before (1e18):", health0);
        console.log("USDC equity received (6dp):", received);
    }

    function test_enterThenFlashUnwind() public {
        address owner = makeAddr("ledger");
        uint256 equity = 10_000e6;
        CovenantExecutor exec = _openLoop(owner, equity, 20_000e6);

        Position memory pos = morpho.position(ID, owner);
        assertGt(pos.collateral, 0, "no collateral");
        assertGt(pos.borrowShares, 0, "no debt");
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), pos.collateral, "YT should match PT");
        assertGe(exec.healthFactor(ID, owner), 1.02e18);
        assertEq(IERC20(M.USDC).balanceOf(owner), 0);
        _assertExecutorEmpty(exec);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1 days);

        _execute(exec, owner, Plans.flashUnwind(_loop(exec, owner), pos.collateral, 0));

        pos = morpho.position(ID, owner);
        assertEq(pos.borrowShares, 0);
        assertEq(pos.collateral, 0);
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), 0);
        _assertExecutorEmpty(exec);

        uint256 out = IERC20(M.USDC).balanceOf(owner);
        console.log("equity in / out (6dp):", equity, out);
        assertApproxEqRel(out, equity, 0.01e18, "round trip lost more than 1%");
    }

    /// YT covers only part of the PT: withdraw just the matched PT, never sell the rest (§6.3).
    function test_matchedUnwind_ytShortfall() public {
        address owner = makeAddr("ledger");
        CovenantExecutor exec = _openLoop(owner, 10_000e6, 20_000e6);

        // Owner moves 40% of their YT elsewhere.
        uint256 yt = IERC20(M.YT_USD3).balanceOf(owner);
        vm.prank(owner);
        IERC20(M.YT_USD3).transfer(address(0xdead), yt * 40 / 100);

        Position memory before = morpho.position(ID, owner);
        uint256 health0 = exec.healthFactor(ID, owner);
        uint256 matched = IERC20(M.YT_USD3).balanceOf(owner);
        // Proceeds per PT ~ USDC deposited per PT minted (30k / collateral); repay 98% of that.
        uint256 repayAssets = matched * 30_000e6 / before.collateral * 98 / 100;

        _execute(exec, owner, Plans.matchedUnwind(_loop(exec, owner), matched, repayAssets, 1.02e18));

        Position memory afterPos = morpho.position(ID, owner);
        assertEq(afterPos.collateral, before.collateral - matched, "withdrew more than matched PT");
        assertLt(afterPos.borrowShares, before.borrowShares, "debt not reduced");
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), 0, "matched YT not consumed");
        assertGt(exec.healthFactor(ID, owner), health0, "remaining loop should be safer");
        assertGt(IERC20(M.USDC).balanceOf(owner), 0, "no leftover USDC returned");
        _assertExecutorEmpty(exec);
    }
}
