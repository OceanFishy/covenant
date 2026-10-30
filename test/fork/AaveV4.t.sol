// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";

import {CovenantCore} from "../../contracts/CovenantCore.sol";
import {CovenantDelegate} from "../../contracts/CovenantDelegate.sol";
import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IAaveV4Giver, IAaveV4Spoke, IAaveV4Taker} from "../../contracts/interfaces/IAaveV4.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho} from "../../contracts/interfaces/IMorpho.sol";
import {LoopForkBase} from "../utils/LoopForkBase.sol";
import {Plans} from "../utils/Plans.sol";

/// Aave v4 ISpoke.ReserveConfig.
struct ReserveConfigV4 {
    uint24 collateralRisk;
    bool paused;
    bool frozen;
    bool borrowable;
    bool receiveSharesEnabled;
}

interface ISpokeAdmin {
    function getReserveConfig(uint256 reserveId) external view returns (ReserveConfigV4 memory);
    function updateReserveConfig(uint256 reserveId, ReserveConfigV4 calldata config) external;
    function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf) external;
}

/// Mainnet-fork tests for the Aave v4 blocks on the Main Spoke: supply / repay through the Giver,
/// borrow / withdraw through the Taker (allowances granted to the Executor), repay all patched to
/// the live debt (AAVE_V4_DEBT source), and the v4 guards. Run with MAINNET_RPC_URL set:
/// `pnpm test:fork`.
///
/// Every Main Spoke reserve is frozen at the time of writing: repay and withdraw work, supply and
/// borrow revert (ReserveFrozen). The test unfreezes USDC to open a position, then freezes it
/// again and closes the position the way mainnet allows today.
contract AaveV4ForkTest is LoopForkBase {
    address constant SPOKE = M.AAVE_V4_MAIN_SPOKE;
    address constant SPOKE_CONFIGURATOR = 0x9BFFf48BFb5A7AE70c348d4d4cb97E8DEFa5389a; // has the AccessManager role
    uint256 constant USDC_R = M.AAVE_V4_USDC_RESERVE;

    address owner = makeAddr("aave-v4-owner");

    function _setFrozen(uint256 reserveId, bool frozen) internal {
        ReserveConfigV4 memory c = ISpokeAdmin(SPOKE).getReserveConfig(reserveId);
        c.frozen = frozen;
        vm.prank(SPOKE_CONFIGURATOR);
        ISpokeAdmin(SPOKE).updateReserveConfig(reserveId, c);
    }

    /// The app's one-time v4 setup, all from the owner's wallet: approve Aave's Giver and Taker as
    /// position managers, use USDC as collateral, and let the Executor borrow / withdraw USDC.
    function _v4Setup(CovenantExecutor exec) internal {
        vm.startPrank(owner);
        IAaveV4Spoke(SPOKE).setUserPositionManager(M.AAVE_V4_GIVER, true);
        IAaveV4Spoke(SPOKE).setUserPositionManager(M.AAVE_V4_TAKER, true);
        ISpokeAdmin(SPOKE).setUsingAsCollateral(USDC_R, true, owner);
        IAaveV4Taker(M.AAVE_V4_TAKER).approveBorrow(SPOKE, USDC_R, address(exec), type(uint256).max);
        IAaveV4Taker(M.AAVE_V4_TAKER).approveWithdraw(SPOKE, USDC_R, address(exec), type(uint256).max);
        vm.stopPrank();
    }

    function _debtPatch(uint32 offset) internal view returns (CovenantCore.Patch memory) {
        return CovenantCore.Patch(offset, CovenantCore.Source.AAVE_V4_DEBT, abi.encode(SPOKE, USDC_R, owner), Plans.FULL);
    }

    function _run(CovenantExecutor exec, CovenantCore.Call[] memory calls) internal {
        vm.prank(owner);
        exec.execute(calls, _sweep(), keccak256(abi.encode(calls)));
    }

    function _debt() internal view returns (uint256) {
        return IAaveV4Spoke(SPOKE).getUserTotalDebt(USDC_R, owner);
    }

    function _supplied() internal view returns (uint256) {
        return IAaveV4Spoke(SPOKE).getUserSuppliedAssets(USDC_R, owner);
    }

    function _health() internal view returns (uint256) {
        return IAaveV4Spoke(SPOKE).getUserAccountData(owner).healthFactor;
    }

    function test_supplyBorrow_thenFlashClose_whileFrozen() public {
        _setFrozen(USDC_R, false);
        CovenantExecutor exec = _deployFor(owner);
        _v4Setup(exec);
        address me = address(exec);

        // Open: supply 100k USDC for the owner, borrow 60k USDC against it.
        deal(M.USDC, owner, 100_000e6);
        CovenantCore.Call[] memory c = new CovenantCore.Call[](5);
        c[0] = Plans.call(M.USDC, abi.encodeCall(IERC20.transferFrom, (owner, me, 100_000e6)));
        c[1] = Plans.patched(M.USDC, abi.encodeCall(IERC20.approve, (M.AAVE_V4_GIVER, 0)), Plans.balanceOf(Plans.arg(1), M.USDC, me));
        c[2] = Plans.patched(
            M.AAVE_V4_GIVER,
            abi.encodeCall(IAaveV4Giver.supplyOnBehalfOf, (SPOKE, USDC_R, 0, owner)),
            Plans.balanceOf(Plans.arg(2), M.USDC, me)
        );
        c[3] = Plans.call(M.AAVE_V4_TAKER, abi.encodeCall(IAaveV4Taker.borrowOnBehalfOf, (SPOKE, USDC_R, 60_000e6, owner)));
        c[4] = Plans.call(me, abi.encodeCall(CovenantCore.assertMinAaveV4Health, (SPOKE, owner, 1.2e18)));
        _run(exec, c);

        assertEq(IERC20(M.USDC).balanceOf(owner), 60_000e6, "borrowed USDC not swept to owner");
        assertApproxEqAbs(_supplied(), 100_000e6, 3, "supply not credited to owner");
        assertApproxEqAbs(_debt(), 60_000e6, 3, "debt not on owner");

        // Guards: health passes at the real value and fails just above it; no-debt fails.
        uint256 h = _health();
        exec.assertMinAaveV4Health(SPOKE, owner, h);
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.AaveV4HealthTooLow.selector, SPOKE, owner, h, h + 1));
        exec.assertMinAaveV4Health(SPOKE, owner, h + 1);
        uint256 d = _debt();
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.AaveV4DebtRemaining.selector, SPOKE, USDC_R, d));
        exec.assertNoAaveV4Debt(SPOKE, USDC_R, owner);

        // A month later, frozen again: close with a Morpho flash loan of exactly the live debt.
        vm.warp(block.timestamp + 30 days);
        _setFrozen(USDC_R, true);
        uint256 debt = _debt();
        uint256 supplied = _supplied();
        assertGt(debt, 60_000e6, "no interest accrued");

        CovenantCore.Call[] memory inner = new CovenantCore.Call[](4);
        inner[0] = Plans.patched(M.USDC, abi.encodeCall(IERC20.approve, (M.AAVE_V4_GIVER, 0)), Plans.balanceOf(Plans.arg(1), M.USDC, me));
        inner[1] = Plans.patched(
            M.AAVE_V4_GIVER, abi.encodeCall(IAaveV4Giver.repayOnBehalfOf, (SPOKE, USDC_R, 0, owner)), _debtPatch(Plans.arg(2))
        );
        inner[2] = Plans.call(me, abi.encodeCall(CovenantCore.assertNoAaveV4Debt, (SPOKE, USDC_R, owner)));
        inner[3] = Plans.call(
            M.AAVE_V4_TAKER, abi.encodeCall(IAaveV4Taker.withdrawOnBehalfOf, (SPOKE, USDC_R, type(uint256).max, owner))
        );
        c = new CovenantCore.Call[](2);
        c[0] = Plans.patched(
            M.MORPHO, abi.encodeCall(IMorpho.flashLoan, (M.USDC, 0, abi.encode(M.USDC, inner))), _debtPatch(Plans.arg(1))
        );
        c[1] = Plans.call(me, abi.encodeCall(CovenantCore.assertMinAaveV4Health, (SPOKE, owner, 1e18)));
        uint256 usdc0 = IERC20(M.USDC).balanceOf(owner);
        _run(exec, c);

        assertEq(_debt(), 0, "Aave v4 debt left");
        assertEq(_supplied(), 0, "Aave v4 supply left");
        uint256 received = IERC20(M.USDC).balanceOf(owner) - usdc0;
        assertApproxEqAbs(received, supplied - debt, 3, "equity not returned");
        _assertExecutorEmpty(exec);
        console.log("Aave v4 USDC debt repaid (6dp):", debt);
        console.log("USDC equity returned (6dp):", received);
    }

    /// Without the Taker allowance the Executor can't borrow for the owner, even with the position
    /// managers approved: v4 access is per reserve and per spender.
    function test_borrowNeedsTakerAllowance() public {
        _setFrozen(USDC_R, false);
        CovenantExecutor exec = _deployFor(owner);
        vm.prank(owner);
        IAaveV4Spoke(SPOKE).setUserPositionManager(M.AAVE_V4_TAKER, true);
        CovenantCore.Call[] memory c = new CovenantCore.Call[](1);
        c[0] = Plans.call(M.AAVE_V4_TAKER, abi.encodeCall(IAaveV4Taker.borrowOnBehalfOf, (SPOKE, USDC_R, 1e6, owner)));
        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantCore.CallFailed.selector,
                0,
                M.AAVE_V4_TAKER,
                abi.encodeWithSignature("InsufficientBorrowAllowance(uint256,uint256)", 0, 1e6)
            )
        );
        _run(exec, c);
    }

    /// EIP-7702: your account is the caller, so the plan uses the Spoke directly: no Giver /
    /// Taker, no allowances, and only the allotted USDC is spent.
    function test_7702_spokeDirect_open_thenFlashCloseWhileFrozen() public {
        _setFrozen(USDC_R, false);
        _delegate(owner);
        vm.prank(owner);
        ISpokeAdmin(SPOKE).setUsingAsCollateral(USDC_R, true, owner);
        uint256 savings = 5_000e6;
        deal(M.USDC, owner, 100_000e6 + savings);

        CovenantCore.Call[] memory c = new CovenantCore.Call[](5);
        c[0] = Plans.call(owner, abi.encodeCall(CovenantDelegate.allot, (M.USDC, 100_000e6)));
        c[1] = Plans.call(M.USDC, abi.encodeCall(IERC20.approve, (SPOKE, 100_000e6)));
        c[2] = Plans.call(SPOKE, abi.encodeCall(IAaveV4Spoke.supply, (USDC_R, 100_000e6, owner)));
        c[3] = Plans.call(SPOKE, abi.encodeCall(IAaveV4Spoke.borrow, (USDC_R, 60_000e6, owner)));
        c[4] = Plans.call(owner, abi.encodeCall(CovenantCore.assertMinAaveV4Health, (SPOKE, owner, 1.2e18)));
        _execute7702(owner, c);
        assertEq(IERC20(M.USDC).balanceOf(owner), 60_000e6 + savings, "borrowed USDC not in the wallet");
        assertApproxEqAbs(_debt(), 60_000e6, 3, "debt not on owner");
        assertEq(IERC20(M.USDC).allowance(owner, SPOKE), 0, "allowance left behind");
        assertFalse(IAaveV4Spoke(SPOKE).isPositionManager(owner, M.AAVE_V4_TAKER), "no position manager needed");

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 30 days);
        _setFrozen(USDC_R, true);
        uint256 debt = _debt();
        uint256 supplied = _supplied();

        CovenantCore.Call[] memory inner = new CovenantCore.Call[](4);
        inner[0] = Plans.patched(M.USDC, abi.encodeCall(IERC20.approve, (SPOKE, 0)), _debtPatch(Plans.arg(1)));
        inner[1] = Plans.patched(SPOKE, abi.encodeCall(IAaveV4Spoke.repay, (USDC_R, 0, owner)), _debtPatch(Plans.arg(1)));
        inner[2] = Plans.call(owner, abi.encodeCall(CovenantCore.assertNoAaveV4Debt, (SPOKE, USDC_R, owner)));
        inner[3] = Plans.call(SPOKE, abi.encodeCall(IAaveV4Spoke.withdraw, (USDC_R, type(uint256).max, owner)));
        c = new CovenantCore.Call[](1);
        c[0] = Plans.patched(
            M.MORPHO, abi.encodeCall(IMorpho.flashLoan, (M.USDC, 0, abi.encode(M.USDC, inner))), _debtPatch(Plans.arg(1))
        );
        uint256 usdc0 = IERC20(M.USDC).balanceOf(owner);
        _execute7702(owner, c);

        assertEq(_debt(), 0, "Aave v4 debt left");
        assertEq(_supplied(), 0, "Aave v4 supply left");
        assertApproxEqAbs(IERC20(M.USDC).balanceOf(owner) - usdc0, supplied - debt, 3, "equity not returned");
        assertEq(IERC20(M.USDC).allowance(owner, SPOKE), 0, "allowance left behind");
    }
}
