// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";

import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams, Position} from "../../contracts/interfaces/IMorpho.sol";
import {Plans} from "./Plans.sol";

interface IUSD3Limits {
    function maxDeposit(address) external view returns (uint256);
    function availableDepositLimit(address) external view returns (uint256);
}

/// Shared setup and helpers for PT-USD3 loop fork tests on any Morpho market.
abstract contract LoopForkBase is Test {
    IMorpho constant morpho = IMorpho(M.MORPHO);

    function setUp() public virtual {
        vm.createSelectFork("mainnet");
    }

    // ------------------------------------------------------------ setup helpers

    function _deployFor(address owner) internal returns (CovenantExecutor exec) {
        exec = new CovenantExecutor(owner, morpho, M.rules(), M.recipients());
        // One-time setup from the Ledger (§5.2): authorize on Morpho, approve tokens to the Executor.
        vm.startPrank(owner);
        morpho.setAuthorization(address(exec), true);
        IERC20(M.YT_USD3).approve(address(exec), type(uint256).max);
        IERC20(M.USDC).approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    function _loop(CovenantExecutor exec, address owner, bytes32 id) internal view returns (Plans.Loop memory) {
        MarketParams memory params = morpho.idToMarketParams(id);
        return Plans.Loop({
            executor: address(exec),
            owner: owner,
            morpho: address(morpho),
            id: id,
            params: params,
            loanToken: params.loanToken,
            pt: M.PT_USD3,
            yt: M.YT_USD3,
            sy: M.SY_USD3,
            tokenOut: M.USDC // SY-USD3 redeems straight to USDC via 3Jane
        });
    }

    function _noSwap() internal pure returns (Plans.Swap memory s) {}

    function _sweep() internal pure returns (address[] memory s) {
        s = new address[](6);
        (s[0], s[1], s[2], s[3], s[4], s[5]) = (M.USDC, M.USDT, M.PT_USD3, M.YT_USD3, M.SY_USD3, M.USD3);
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

    /// 3Jane caps USD3 deposits (and only whitelisted addresses like SY-USD3 may deposit).
    /// When the live cap is too small, simulate capacity so the entry path can still be tested.
    function _ensureDepositCapacity(uint256 needed) internal {
        uint256 cap = IUSD3Limits(M.USD3).maxDeposit(M.SY_USD3);
        if (cap < needed) {
            console.log("live USD3 deposit cap too low; simulating capacity. cap (6dp):", cap);
            vm.mockCall(
                M.USD3,
                abi.encodeWithSelector(IUSD3Limits.availableDepositLimit.selector, M.SY_USD3),
                abi.encode(type(uint256).max)
            );
        }
    }

    /// The live markets are ~100% utilized; add lender liquidity so new borrows succeed.
    function _supplyLiquidity(bytes32 id, uint256 amount) internal {
        MarketParams memory params = morpho.idToMarketParams(id);
        address lender = makeAddr("lender");
        deal(params.loanToken, lender, amount);
        vm.startPrank(lender);
        // USDT's approve returns nothing; call it low-level.
        (bool ok,) = params.loanToken.call(abi.encodeCall(IERC20.approve, (address(morpho), type(uint256).max)));
        require(ok, "approve");
        morpho.supply(params, amount, 0, lender, "");
        vm.stopPrank();
    }

    /// Gives `borrower` YT matching their PT collateral (as if held in their wallet) and
    /// returns the collateral, or skips the test if the reference position no longer exists.
    function _prepareRealBorrower(bytes32 id, address borrower) internal returns (uint256 collateral, uint256 yt0) {
        Position memory pos = morpho.position(id, borrower);
        if (pos.borrowShares == 0) {
            console.log("reference borrower has no position at this block; skipping");
            vm.skip(true);
        }
        collateral = pos.collateral;
        yt0 = IERC20(M.YT_USD3).balanceOf(borrower);
        deal(M.YT_USD3, borrower, yt0 + collateral);
    }

    function _assertClosed(bytes32 id, address owner, uint256 yt0, CovenantExecutor exec) internal view {
        Position memory pos = morpho.position(id, owner);
        assertEq(pos.borrowShares, 0, "debt left");
        assertEq(pos.collateral, 0, "collateral left");
        assertEq(IERC20(M.YT_USD3).balanceOf(owner), yt0, "YT not exactly consumed");
        _assertExecutorEmpty(exec);
    }
}
