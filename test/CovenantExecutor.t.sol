// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {CovenantCore} from "../contracts/CovenantCore.sol";
import {CovenantExecutor} from "../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../contracts/config/MainnetConfig.sol";
import {IERC20} from "../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams} from "../contracts/interfaces/IMorpho.sol";
import {IAaveDebtToken, IAavePool} from "../contracts/interfaces/IAave.sol";
import {IAaveV4Giver, IAaveV4Spoke, IAaveV4Taker} from "../contracts/interfaces/IAaveV4.sol";
import {Plans} from "./utils/Plans.sol";

/// Records calls so allowed plans can run without a fork.
contract Sink {
    fallback() external {}
}

/// Access-control and allowlist tests. No fork needed: rejected calls revert before any
/// external call is made.
contract CovenantExecutorTest is Test {
    address owner = makeAddr("ledger");
    address attacker = makeAddr("attacker");
    address constant PENDLE_ROUTER_V4 = 0x888888888889758F76e7103c6CbF23ABbF58F946;

    CovenantExecutor exec;
    MarketParams params;

    function setUp() public {
        exec = new CovenantExecutor(owner, IMorpho(M.MORPHO), IAavePool(M.AAVE_POOL), M.rules(), M.recipients());
        params = MarketParams(M.USDC, M.PT_USD3, address(1), address(2), 0.86e18);
    }

    function _run(CovenantCore.Call memory c) internal {
        CovenantCore.Call[] memory calls = new CovenantCore.Call[](1);
        calls[0] = c;
        vm.prank(owner);
        exec.execute(calls, new address[](0), bytes32(0));
    }

    function test_onlyOwnerCanExecute() public {
        vm.prank(attacker);
        vm.expectRevert(CovenantCore.NotOwner.selector);
        exec.execute(new CovenantCore.Call[](0), new address[](0), bytes32(0));
    }

    function test_onlyOwnerCanChangeRules() public {
        vm.startPrank(attacker);
        vm.expectRevert(CovenantCore.NotOwner.selector);
        exec.setRule(attacker, bytes4(0), 1);
        vm.expectRevert(CovenantCore.NotOwner.selector);
        exec.setRecipient(M.PT_USD3, attacker, true);
        vm.expectRevert(CovenantCore.NotOwner.selector);
        exec.rescue(M.USDC);
        vm.stopPrank();
    }

    function test_flashCallbackOnlyFromMorphoWhileExecuting() public {
        vm.prank(attacker);
        vm.expectRevert(CovenantCore.NotMorpho.selector);
        exec.onMorphoFlashLoan(0, "");

        vm.prank(M.MORPHO);
        vm.expectRevert(CovenantCore.NotExecuting.selector);
        exec.onMorphoFlashLoan(0, abi.encode(M.USDC, new CovenantCore.Call[](0)));
    }

    function test_pendleRouterNeverAllowed() public {
        bytes memory data = abi.encodeWithSignature("swapExactPtForToken(address,address,uint256)", owner, M.PT_USD3, 1);
        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.CallNotAllowed.selector, PENDLE_ROUTER_V4, bytes4(data))
        );
        _run(Plans.call(PENDLE_ROUTER_V4, data));
    }

    function test_ptCannotBeSentToArbitraryAddress() public {
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.RecipientNotAllowed.selector, M.PT_USD3, attacker));
        _run(Plans.call(M.PT_USD3, abi.encodeCall(IERC20.transfer, (attacker, 1))));

        vm.expectRevert(abi.encodeWithSelector(CovenantCore.RecipientNotAllowed.selector, M.YT_USD3, attacker));
        _run(Plans.call(M.YT_USD3, abi.encodeCall(IERC20.approve, (attacker, 1))));
    }

    /// Aggregators only ever receive USDC/USDT/reUSD approvals, so Pendle assets (PT/YT/SY of
    /// every series) can't be routed through them.
    function test_pendleAssetsCannotBeApprovedToAggregators() public {
        address[2] memory aggs = [M.ZEROX_ALLOWANCE_HOLDER, M.KYBER_ROUTER];
        address[6] memory pendle = [M.PT_USD3, M.YT_USD3, M.SY_USD3, M.PT_REUSD, M.YT_REUSD, M.SY_REUSD];
        for (uint256 i; i < aggs.length; ++i) {
            for (uint256 j; j < pendle.length; ++j) {
                vm.expectRevert(
                    abi.encodeWithSelector(CovenantCore.RecipientNotAllowed.selector, pendle[j], aggs[i])
                );
                _run(Plans.call(pendle[j], abi.encodeCall(IERC20.approve, (aggs[i], 1))));
            }
            assertTrue(exec.allowedRecipient(M.USDC, aggs[i]));
            assertTrue(exec.allowedRecipient(M.USDT, aggs[i]));
            assertTrue(exec.allowedRecipient(M.REUSD, aggs[i]));
        }
    }

    function test_cannotPullFromOthers() public {
        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, M.USDC, IERC20.transferFrom.selector, 0)
        );
        _run(Plans.call(M.USDC, abi.encodeCall(IERC20.transferFrom, (attacker, address(exec), 1))));
    }

    function test_morphoReceiversMustBeOwnerOrExecutor() public {
        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, M.MORPHO, IMorpho.borrow.selector, 8)
        );
        _run(Plans.call(M.MORPHO, abi.encodeCall(IMorpho.borrow, (params, 1, 0, owner, attacker))));

        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantCore.ArgNotSelfOrOwner.selector, M.MORPHO, IMorpho.withdrawCollateral.selector, 7
            )
        );
        _run(Plans.call(M.MORPHO, abi.encodeCall(IMorpho.withdrawCollateral, (params, 1, owner, attacker))));

        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantCore.ArgNotSelfOrOwner.selector, M.MORPHO, IMorpho.withdrawCollateral.selector, 6
            )
        );
        _run(Plans.call(M.MORPHO, abi.encodeCall(IMorpho.withdrawCollateral, (params, 1, attacker, owner))));
    }

    function test_cannotChangeMorphoAuthorizationFromPlan() public {
        bytes memory data = abi.encodeCall(IMorpho.setAuthorization, (attacker, true));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.CallNotAllowed.selector, M.MORPHO, bytes4(data)));
        _run(Plans.call(M.MORPHO, data));
    }

    function test_patchBoundsChecked() public {
        Sink sink = new Sink();
        vm.prank(owner);
        exec.setRule(address(sink), bytes4(0x12345678), 1);

        CovenantCore.Call memory c =
            Plans.patched(address(sink), hex"12345678", Plans.balanceOf(4, M.USDC, address(exec)));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.BadPatch.selector, 4));
        _run(c);

        c = Plans.patched(address(sink), abi.encodeWithSelector(0x12345678, 0), Plans.balanceOf(0, M.USDC, owner));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.BadPatch.selector, 0));
        _run(c);
    }

    function test_allowedCallRunsAndEmits() public {
        Sink sink = new Sink();
        vm.prank(owner);
        exec.setRule(address(sink), bytes4(0x12345678), 1);

        CovenantCore.Call[] memory calls = new CovenantCore.Call[](1);
        calls[0] = Plans.call(address(sink), abi.encodeWithSelector(0x12345678, 42));
        vm.expectEmit(address(exec));
        emit CovenantCore.Executed(bytes32("plan"), 1);
        vm.prank(owner);
        exec.execute(calls, new address[](0), bytes32("plan"));
    }

    function test_aaveOnBehalfAndReceiversMustBeOwnerOrExecutor() public {
        address pool = M.AAVE_POOL;
        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, pool, IAavePool.borrow.selector, 4)
        );
        _run(Plans.call(pool, abi.encodeCall(IAavePool.borrow, (M.USDC, 1, 2, 0, attacker))));

        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, pool, IAavePool.withdraw.selector, 2)
        );
        _run(Plans.call(pool, abi.encodeCall(IAavePool.withdraw, (M.USDC, 1, attacker))));

        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, pool, IAavePool.supply.selector, 2)
        );
        _run(Plans.call(pool, abi.encodeCall(IAavePool.supply, (M.USDC, 1, attacker, 0))));

        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, pool, IAavePool.repay.selector, 3)
        );
        _run(Plans.call(pool, abi.encodeCall(IAavePool.repay, (M.USDC, 1, 2, attacker))));
    }

    /// The Executor never re-delegates the owner's credit and never moves aTokens to anyone else.
    function test_aaveTokensStayWithOwner() public {
        bytes memory delegate = abi.encodeCall(IAaveDebtToken.approveDelegation, (attacker, 1));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.CallNotAllowed.selector, M.VDEBT_USDC, bytes4(delegate)));
        _run(Plans.call(M.VDEBT_USDC, delegate));

        vm.expectRevert(abi.encodeWithSelector(CovenantCore.RecipientNotAllowed.selector, M.A_USDC, attacker));
        _run(Plans.call(M.A_USDC, abi.encodeCall(IERC20.transfer, (attacker, 1))));

        vm.expectRevert(
            abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, M.A_USDT, IERC20.transferFrom.selector, 1)
        );
        _run(Plans.call(M.A_USDT, abi.encodeCall(IERC20.transferFrom, (owner, attacker, 1))));

        bytes memory approveA = abi.encodeCall(IERC20.approve, (attacker, 1));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.CallNotAllowed.selector, M.A_USDC, bytes4(approveA)));
        _run(Plans.call(M.A_USDC, approveA));
    }

    /// Only USDC and USDT can be approved to the Aave Pool, so Pendle assets never reach Aave.
    function test_onlyStablecoinsApprovedToAave() public {
        assertTrue(exec.allowedRecipient(M.USDC, M.AAVE_POOL));
        assertTrue(exec.allowedRecipient(M.USDT, M.AAVE_POOL));
        address[3] memory others = [M.PT_USD3, M.USD3, M.REUSD];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(CovenantCore.RecipientNotAllowed.selector, others[i], M.AAVE_POOL)
            );
            _run(Plans.call(others[i], abi.encodeCall(IERC20.approve, (M.AAVE_POOL, 1))));
        }
    }

    /// Giver / Taker (Executor) and the Spoke itself (EIP-7702) act for `onBehalfOf`: it must be
    /// the owner or this contract.
    function test_aaveV4OnBehalfPinned() public {
        address spoke = M.AAVE_V4_MAIN_SPOKE;
        uint256 r = M.AAVE_V4_USDC_RESERVE;
        bytes[8] memory calls = [
            abi.encodeCall(IAaveV4Giver.supplyOnBehalfOf, (spoke, r, 1, attacker)),
            abi.encodeCall(IAaveV4Giver.repayOnBehalfOf, (spoke, r, 1, attacker)),
            abi.encodeCall(IAaveV4Taker.withdrawOnBehalfOf, (spoke, r, 1, attacker)),
            abi.encodeCall(IAaveV4Taker.borrowOnBehalfOf, (spoke, r, 1, attacker)),
            abi.encodeCall(IAaveV4Spoke.supply, (r, 1, attacker)),
            abi.encodeCall(IAaveV4Spoke.repay, (r, 1, attacker)),
            abi.encodeCall(IAaveV4Spoke.withdraw, (r, 1, attacker)),
            abi.encodeCall(IAaveV4Spoke.borrow, (r, 1, attacker))
        ];
        address[8] memory targets =
            [M.AAVE_V4_GIVER, M.AAVE_V4_GIVER, M.AAVE_V4_TAKER, M.AAVE_V4_TAKER, spoke, spoke, spoke, spoke];
        for (uint256 i; i < calls.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(CovenantCore.ArgNotSelfOrOwner.selector, targets[i], bytes4(calls[i]), i < 4 ? 3 : 2)
            );
            _run(Plans.call(targets[i], calls[i]));
        }
    }

    /// Only the owner grants v4 access, from their wallet: a plan can't hand out Taker allowances
    /// or approve position managers on a Spoke.
    function test_aaveV4PermissionsNeverFromPlans() public {
        bytes memory borrowTo = abi.encodeCall(IAaveV4Taker.approveBorrow, (M.AAVE_V4_MAIN_SPOKE, 7, attacker, 1));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.CallNotAllowed.selector, M.AAVE_V4_TAKER, bytes4(borrowTo)));
        _run(Plans.call(M.AAVE_V4_TAKER, borrowTo));

        bytes memory pm = abi.encodeCall(IAaveV4Spoke.setUserPositionManager, (attacker, true));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.CallNotAllowed.selector, M.AAVE_V4_MAIN_SPOKE, bytes4(pm)));
        _run(Plans.call(M.AAVE_V4_MAIN_SPOKE, pm));
    }

    /// Only USDC and USDT can be approved to the v4 Giver, so Pendle assets never reach Aave v4.
    function test_onlyStablecoinsApprovedToAaveV4() public {
        assertTrue(exec.allowedRecipient(M.USDC, M.AAVE_V4_GIVER));
        assertTrue(exec.allowedRecipient(M.USDT, M.AAVE_V4_GIVER));
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.RecipientNotAllowed.selector, M.PT_USD3, M.AAVE_V4_GIVER));
        _run(Plans.call(M.PT_USD3, abi.encodeCall(IERC20.approve, (M.AAVE_V4_GIVER, 1))));
    }
}
