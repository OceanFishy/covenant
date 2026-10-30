// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";

import {CovenantCore} from "../../contracts/CovenantCore.sol";
import {CovenantDelegate} from "../../contracts/CovenantDelegate.sol";
import {CovenantDelegateMainnet} from "../../contracts/CovenantDelegateMainnet.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams, Position} from "../../contracts/interfaces/IMorpho.sol";
import {LoopForkBase} from "../utils/LoopForkBase.sol";
import {Plans} from "../utils/Plans.sol";

/// Mainnet-fork tests for the EIP-7702 mode: the delegated EOA runs the loop templates
/// itself (no Executor, no approvals, no Morpho authorization), and a plan can't reach the
/// wallet's other funds. Run with MAINNET_RPC_URL set: `pnpm test:fork`.
contract Delegate7702ForkTest is LoopForkBase {
    bytes32 constant ID = M.MKT_PT_USD3_USDC_A;
    address constant BORROWER_A = 0xa95d6286853320487cB0897304ad8A210F8D12c4; // ~597k PT, ~447k USDC debt

    function test_7702_flashUnwind_realPosition() public {
        (uint256 collateral, uint256 yt0) = _prepareRealBorrower(ID, BORROWER_A);
        CovenantDelegateMainnet wallet = _delegate(BORROWER_A);
        // Unrelated holdings the plan must leave alone.
        deal(M.PT_USD3, BORROWER_A, IERC20(M.PT_USD3).balanceOf(BORROWER_A) + 1_000e6);
        uint256 pt0 = IERC20(M.PT_USD3).balanceOf(BORROWER_A);
        uint256 usdc0 = IERC20(M.USDC).balanceOf(BORROWER_A);
        uint256 morphoAllowance0 = IERC20(M.USDC).allowance(BORROWER_A, M.MORPHO);
        assertFalse(morpho.isAuthorized(BORROWER_A, address(wallet)), "no authorization needed");

        _execute7702(BORROWER_A, Plans.flashUnwind(_loopFor(BORROWER_A, BORROWER_A, ID), collateral, 0, _noSwap()));

        Position memory pos = morpho.position(ID, BORROWER_A);
        assertEq(pos.borrowShares, 0, "debt left");
        assertEq(pos.collateral, 0, "collateral left");
        assertEq(IERC20(M.YT_USD3).balanceOf(BORROWER_A), yt0, "YT not exactly consumed");
        assertEq(IERC20(M.PT_USD3).balanceOf(BORROWER_A), pt0, "wallet PT touched");
        assertEq(IERC20(M.USDC).allowance(BORROWER_A, M.MORPHO), morphoAllowance0, "allowance left behind");
        uint256 received = IERC20(M.USDC).balanceOf(BORROWER_A) - usdc0;
        assertGt(received, 0, "no equity returned");
        console.log("7702: PT collateral / USDC equity received (6dp):", collateral, received);
    }

    function test_7702_enterThenFlashUnwind_keepsSavingsApart() public {
        address owner = makeAddr("ledger7702");
        uint256 equity = 10_000e6;
        uint256 savings = 5_000e6;
        uint256 flash = 20_000e6;
        _ensureDepositCapacity(equity + flash);
        _supplyLiquidity(ID, flash * 2);
        _delegate(owner);
        deal(M.USDC, owner, equity + savings);

        _execute7702(owner, Plans.enter(_loopFor(owner, owner, ID), equity, flash, 1.02e18, _noSwap()));

        Position memory pos = morpho.position(ID, owner);
        assertGt(pos.collateral, 0, "no collateral");
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), pos.collateral, "YT should match PT");
        assertEq(IERC20(M.USDC).balanceOf(owner), savings, "only the allotted equity was used");
        assertGe(CovenantDelegateMainnet(payable(owner)).healthFactor(ID, owner), 1.02e18);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1 days);
        _execute7702(owner, Plans.flashUnwind(_loopFor(owner, owner, ID), pos.collateral, 0, _noSwap()));

        assertEq(morpho.position(ID, owner).borrowShares, 0, "debt left");
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), 0, "YT not consumed");
        uint256 out = IERC20(M.USDC).balanceOf(owner) - savings;
        console.log("7702: equity in / out (6dp):", equity, out);
        assertApproxEqRel(out, equity, 0.01e18, "round trip lost more than 1%");
    }

    /// A plan that repays debt from wallet funds it never allotted is rejected as a whole.
    function test_7702_planCannotSpendUnallottedSavings() public {
        address owner = makeAddr("ledger7702");
        uint256 equity = 10_000e6;
        _ensureDepositCapacity(equity * 3);
        _supplyLiquidity(ID, equity * 4);
        _delegate(owner);
        deal(M.USDC, owner, equity);
        _execute7702(owner, Plans.enter(_loopFor(owner, owner, ID), equity, equity * 2, 1.02e18, _noSwap()));
        deal(M.USDC, owner, 5_000e6); // savings

        MarketParams memory params = morpho.idToMarketParams(ID);
        CovenantCore.Call[] memory calls = new CovenantCore.Call[](2);
        calls[0] = Plans.call(M.USDC, abi.encodeCall(IERC20.approve, (M.MORPHO, 1_000e6)));
        calls[1] = Plans.call(M.MORPHO, abi.encodeCall(IMorpho.repay, (params, 1_000e6, 0, owner, "")));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CovenantDelegate.Overspent.selector, M.USDC, 4_000e6, 5_000e6));
        CovenantDelegateMainnet(payable(owner)).execute(calls, _sweep(), bytes32(0));

        // The same repayment with an explicit allotment goes through.
        CovenantCore.Call[] memory allotted = new CovenantCore.Call[](3);
        allotted[0] = Plans.call(owner, abi.encodeCall(CovenantDelegate.allot, (M.USDC, 1_000e6)));
        (allotted[1], allotted[2]) = (calls[0], calls[1]);
        _execute7702(owner, allotted);
        assertEq(IERC20(M.USDC).balanceOf(owner), 4_000e6);
    }
}
