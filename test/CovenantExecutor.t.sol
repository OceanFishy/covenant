// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {CovenantExecutor} from "../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../contracts/config/MainnetConfig.sol";
import {IERC20} from "../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams} from "../contracts/interfaces/IMorpho.sol";
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
        exec = new CovenantExecutor(owner, IMorpho(M.MORPHO), M.rules(), M.recipients());
        params = MarketParams(M.USDC, M.PT_USD3, address(1), address(2), 0.86e18);
    }

    function _run(CovenantExecutor.Call memory c) internal {
        CovenantExecutor.Call[] memory calls = new CovenantExecutor.Call[](1);
        calls[0] = c;
        vm.prank(owner);
        exec.execute(calls, new address[](0), bytes32(0));
    }

    function test_onlyOwnerCanExecute() public {
        vm.prank(attacker);
        vm.expectRevert(CovenantExecutor.NotOwner.selector);
        exec.execute(new CovenantExecutor.Call[](0), new address[](0), bytes32(0));
    }

    function test_onlyOwnerCanChangeRules() public {
        vm.startPrank(attacker);
        vm.expectRevert(CovenantExecutor.NotOwner.selector);
        exec.setRule(attacker, bytes4(0), 1);
        vm.expectRevert(CovenantExecutor.NotOwner.selector);
        exec.setRecipient(M.PT_USD3, attacker, true);
        vm.expectRevert(CovenantExecutor.NotOwner.selector);
        exec.rescue(M.USDC);
        vm.stopPrank();
    }

    function test_flashCallbackOnlyFromMorphoWhileExecuting() public {
        vm.prank(attacker);
        vm.expectRevert(CovenantExecutor.NotMorpho.selector);
        exec.onMorphoFlashLoan(0, "");

        vm.prank(M.MORPHO);
        vm.expectRevert(CovenantExecutor.NotExecuting.selector);
        exec.onMorphoFlashLoan(0, abi.encode(M.USDC, new CovenantExecutor.Call[](0)));
    }

    function test_pendleRouterNeverAllowed() public {
        bytes memory data = abi.encodeWithSignature("swapExactPtForToken(address,address,uint256)", owner, M.PT_USD3, 1);
        vm.expectRevert(
            abi.encodeWithSelector(CovenantExecutor.CallNotAllowed.selector, PENDLE_ROUTER_V4, bytes4(data))
        );
        _run(Plans.call(PENDLE_ROUTER_V4, data));
    }

    function test_ptCannotBeSentToArbitraryAddress() public {
        vm.expectRevert(abi.encodeWithSelector(CovenantExecutor.RecipientNotAllowed.selector, M.PT_USD3, attacker));
        _run(Plans.call(M.PT_USD3, abi.encodeCall(IERC20.transfer, (attacker, 1))));

        vm.expectRevert(abi.encodeWithSelector(CovenantExecutor.RecipientNotAllowed.selector, M.YT_USD3, attacker));
        _run(Plans.call(M.YT_USD3, abi.encodeCall(IERC20.approve, (attacker, 1))));
    }

    /// Aggregators only ever receive USDC/USDT approvals, so Pendle assets can't be routed through them.
    function test_pendleAssetsCannotBeApprovedToAggregators() public {
        address[2] memory aggs = [M.ZEROX_ALLOWANCE_HOLDER, M.KYBER_ROUTER];
        address[3] memory pendle = [M.PT_USD3, M.YT_USD3, M.SY_USD3];
        for (uint256 i; i < aggs.length; ++i) {
            for (uint256 j; j < pendle.length; ++j) {
                vm.expectRevert(
                    abi.encodeWithSelector(CovenantExecutor.RecipientNotAllowed.selector, pendle[j], aggs[i])
                );
                _run(Plans.call(pendle[j], abi.encodeCall(IERC20.approve, (aggs[i], 1))));
            }
            assertTrue(exec.allowedRecipient(M.USDC, aggs[i]));
            assertTrue(exec.allowedRecipient(M.USDT, aggs[i]));
        }
    }

    function test_cannotPullFromOthers() public {
        vm.expectRevert(
            abi.encodeWithSelector(CovenantExecutor.ArgNotSelfOrOwner.selector, M.USDC, IERC20.transferFrom.selector, 0)
        );
        _run(Plans.call(M.USDC, abi.encodeCall(IERC20.transferFrom, (attacker, address(exec), 1))));
    }

    function test_morphoReceiversMustBeOwnerOrExecutor() public {
        vm.expectRevert(
            abi.encodeWithSelector(CovenantExecutor.ArgNotSelfOrOwner.selector, M.MORPHO, IMorpho.borrow.selector, 8)
        );
        _run(Plans.call(M.MORPHO, abi.encodeCall(IMorpho.borrow, (params, 1, 0, owner, attacker))));

        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantExecutor.ArgNotSelfOrOwner.selector, M.MORPHO, IMorpho.withdrawCollateral.selector, 7
            )
        );
        _run(Plans.call(M.MORPHO, abi.encodeCall(IMorpho.withdrawCollateral, (params, 1, owner, attacker))));

        vm.expectRevert(
            abi.encodeWithSelector(
                CovenantExecutor.ArgNotSelfOrOwner.selector, M.MORPHO, IMorpho.withdrawCollateral.selector, 6
            )
        );
        _run(Plans.call(M.MORPHO, abi.encodeCall(IMorpho.withdrawCollateral, (params, 1, attacker, owner))));
    }

    function test_cannotChangeMorphoAuthorizationFromPlan() public {
        bytes memory data = abi.encodeCall(IMorpho.setAuthorization, (attacker, true));
        vm.expectRevert(abi.encodeWithSelector(CovenantExecutor.CallNotAllowed.selector, M.MORPHO, bytes4(data)));
        _run(Plans.call(M.MORPHO, data));
    }

    function test_patchBoundsChecked() public {
        Sink sink = new Sink();
        vm.prank(owner);
        exec.setRule(address(sink), bytes4(0x12345678), 1);

        CovenantExecutor.Call memory c =
            Plans.patched(address(sink), hex"12345678", Plans.balanceOf(4, M.USDC, address(exec)));
        vm.expectRevert(abi.encodeWithSelector(CovenantExecutor.BadPatch.selector, 4));
        _run(c);

        c = Plans.patched(address(sink), abi.encodeWithSelector(0x12345678, 0), Plans.balanceOf(0, M.USDC, owner));
        vm.expectRevert(abi.encodeWithSelector(CovenantExecutor.BadPatch.selector, 0));
        _run(c);
    }

    function test_allowedCallRunsAndEmits() public {
        Sink sink = new Sink();
        vm.prank(owner);
        exec.setRule(address(sink), bytes4(0x12345678), 1);

        CovenantExecutor.Call[] memory calls = new CovenantExecutor.Call[](1);
        calls[0] = Plans.call(address(sink), abi.encodeWithSelector(0x12345678, 42));
        vm.expectEmit(address(exec));
        emit CovenantExecutor.Executed(bytes32("plan"), 1);
        vm.prank(owner);
        exec.execute(calls, new address[](0), bytes32("plan"));
    }
}
