// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";

import {CovenantCore} from "../../contracts/CovenantCore.sol";
import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IAaveDebtToken, IAavePool} from "../../contracts/interfaces/IAave.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho} from "../../contracts/interfaces/IMorpho.sol";
import {LoopForkBase} from "../utils/LoopForkBase.sol";
import {Plans} from "../utils/Plans.sol";

/// Aave's DataTypes.ReserveConfigurationMap.
struct ReserveConfig {
    uint256 data;
}

interface IAavePoolConfig {
    function getConfiguration(address asset) external view returns (ReserveConfig memory);
    function setConfiguration(address asset, ReserveConfig calldata configuration) external;
}

interface IAddressesProvider {
    function getPoolConfigurator() external view returns (address);
}

/// Mainnet-fork tests for the Aave v3 Core blocks: supply, borrow (credit delegation), repay all
/// (patched to the live variable debt), withdraw all (aTokens pulled, then withdrawn) and the Aave
/// guards. Run with MAINNET_RPC_URL set: `pnpm test:fork`.
///
/// Every Aave v3 Ethereum reserve is frozen with LTV 0 at the time of writing: repay and withdraw
/// work, supply and borrow revert (ReserveFrozen). Tests that open a position unfreeze USDC/USDT
/// on the fork first; the close test re-freezes them, as on mainnet today.
contract AaveV3ForkTest is LoopForkBase {
    IAavePool constant pool = IAavePool(M.AAVE_POOL);
    address constant ADDRESSES_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
    uint256 constant FROZEN_BIT = 1 << 57;
    uint256 constant VARIABLE = 2;

    address owner = makeAddr("aave-owner");
    mapping(address asset => uint256) liveConfig;

    // ------------------------------------------------------------ helpers

    /// Unfreezes `asset` and gives it a 75% LTV, as before Aave froze v3.
    function _unfreeze(address asset) internal {
        uint256 c = IAavePoolConfig(address(pool)).getConfiguration(asset).data;
        liveConfig[asset] = c;
        _setConfig(asset, ((c & ~FROZEN_BIT) & ~uint256(0xffff)) | 7500);
    }

    /// Back to the live (frozen, LTV 0) configuration.
    function _refreeze(address asset) internal {
        _setConfig(asset, liveConfig[asset]);
    }

    function _setConfig(address asset, uint256 c) internal {
        vm.prank(IAddressesProvider(ADDRESSES_PROVIDER).getPoolConfigurator());
        IAavePoolConfig(address(pool)).setConfiguration(asset, ReserveConfig(c));
    }

    /// The app's one-time Aave setup: credit delegation (borrow) and aToken approval (withdraw).
    function _aaveSetup(CovenantExecutor exec) internal {
        vm.startPrank(owner);
        IAaveDebtToken(M.VDEBT_USDC).approveDelegation(address(exec), type(uint256).max);
        IAaveDebtToken(M.VDEBT_USDT).approveDelegation(address(exec), type(uint256).max);
        IERC20(M.A_USDC).approve(address(exec), type(uint256).max);
        IERC20(M.A_USDT).approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    /// Same sweep list as the app: aTokens are not swept, so the Executor must end without any.
    function _run(CovenantExecutor exec, CovenantCore.Call[] memory calls) internal {
        vm.prank(owner);
        exec.execute(calls, _sweep(), keccak256(abi.encode(calls)));
    }

    function _health() internal view returns (uint256 h) {
        (,,,,, h) = pool.getUserAccountData(owner);
    }

    /// Supplies `equity` USDC for the owner and borrows `borrowAmount` of `borrowAsset` against it.
    function _open(CovenantExecutor exec, uint256 equity, address borrowAsset, uint256 borrowAmount) internal {
        deal(M.USDC, owner, equity);
        CovenantCore.Call[] memory c = new CovenantCore.Call[](5);
        address me = address(exec);
        c[0] = Plans.call(M.USDC, abi.encodeCall(IERC20.transferFrom, (owner, me, equity)));
        c[1] = Plans.patched(M.USDC, abi.encodeCall(IERC20.approve, (M.AAVE_POOL, 0)), Plans.balanceOf(Plans.arg(1), M.USDC, me));
        c[2] = Plans.patched(
            M.AAVE_POOL, abi.encodeCall(IAavePool.supply, (M.USDC, 0, owner, 0)), Plans.balanceOf(Plans.arg(1), M.USDC, me)
        );
        c[3] = Plans.call(M.AAVE_POOL, abi.encodeCall(IAavePool.borrow, (borrowAsset, borrowAmount, VARIABLE, 0, owner)));
        c[4] = Plans.call(me, abi.encodeCall(CovenantCore.assertMinAaveHealth, (owner, 1.2e18)));
        _run(exec, c);
    }

    // ------------------------------------------------------------ tests

    /// Opens a USDC-collateral / USDC-debt position, then (with the reserve frozen again, as on
    /// mainnet today) closes it in one transaction: a Morpho flash loan of exactly the live Aave
    /// debt repays it all, the aUSDC is pulled and withdrawn, Morpho takes its loan back.
    function test_supplyBorrow_thenFlashClose_whileFrozen() public {
        _unfreeze(M.USDC);
        CovenantExecutor exec = _deployFor(owner);
        _aaveSetup(exec);

        _open(exec, 100_000e6, M.USDC, 60_000e6);
        assertEq(IERC20(M.USDC).balanceOf(owner), 60_000e6, "borrowed USDC not swept to owner");
        // Aave rounds scaled balances against the user: a few wei either way.
        assertApproxEqAbs(IERC20(M.A_USDC).balanceOf(owner), 100_000e6, 3, "supply not credited to owner");
        assertApproxEqAbs(IERC20(M.VDEBT_USDC).balanceOf(owner), 60_000e6, 3, "debt not on owner");
        assertGe(_health(), 1.2e18);

        vm.warp(block.timestamp + 30 days);
        _refreeze(M.USDC);
        uint256 debt = IERC20(M.VDEBT_USDC).balanceOf(owner);
        uint256 supplied = IERC20(M.A_USDC).balanceOf(owner);
        assertGt(debt, 60_000e6, "no interest accrued");

        address me = address(exec);
        CovenantCore.Call[] memory inner = new CovenantCore.Call[](5);
        inner[0] = Plans.patched(M.USDC, abi.encodeCall(IERC20.approve, (M.AAVE_POOL, 0)), Plans.balanceOf(Plans.arg(1), M.USDC, me));
        inner[1] = Plans.patched(
            M.AAVE_POOL,
            abi.encodeCall(IAavePool.repay, (M.USDC, 0, VARIABLE, owner)),
            Plans.balanceOf(Plans.arg(1), M.VDEBT_USDC, owner)
        );
        inner[2] = Plans.call(me, abi.encodeCall(CovenantCore.assertMaxBalance, (M.VDEBT_USDC, owner, 0)));
        inner[3] = Plans.patched(
            M.A_USDC, abi.encodeCall(IERC20.transferFrom, (owner, me, 0)), Plans.balanceOf(Plans.arg(2), M.A_USDC, owner)
        );
        inner[4] = Plans.call(M.AAVE_POOL, abi.encodeCall(IAavePool.withdraw, (M.USDC, type(uint256).max, me)));

        CovenantCore.Call[] memory c = new CovenantCore.Call[](2);
        c[0] = Plans.patched(
            M.MORPHO,
            abi.encodeCall(IMorpho.flashLoan, (M.USDC, 0, abi.encode(M.USDC, inner))),
            Plans.balanceOf(Plans.arg(1), M.VDEBT_USDC, owner)
        );
        c[1] = Plans.call(me, abi.encodeCall(CovenantCore.assertMinAaveHealth, (owner, 1e18)));
        uint256 usdc0 = IERC20(M.USDC).balanceOf(owner);
        _run(exec, c);

        assertEq(IERC20(M.VDEBT_USDC).balanceOf(owner), 0, "Aave debt left");
        assertEq(IERC20(M.A_USDC).balanceOf(owner), 0, "aUSDC left");
        assertEq(_health(), type(uint256).max);
        uint256 received = IERC20(M.USDC).balanceOf(owner) - usdc0;
        assertApproxEqAbs(received, supplied - debt, 3, "equity not returned");
        assertEq(IERC20(M.A_USDC).balanceOf(me), 0, "executor holds aUSDC");
        _assertExecutorEmpty(exec);
        console.log("Aave USDC debt repaid (6dp):", debt);
        console.log("USDC equity returned (6dp):", received);
    }

    /// USDT debt against USDC collateral: repay a fixed amount and the rest from the wallet
    /// (repay all = live debt), withdraw part, then the rest, checking the guards along the way.
    function test_crossAsset_partialThenFullExit() public {
        _unfreeze(M.USDC);
        _unfreeze(M.USDT);
        CovenantExecutor exec = _deployFor(owner);
        _aaveSetup(exec);
        address me = address(exec);
        _open(exec, 50_000e6, M.USDT, 20_000e6);
        assertEq(IERC20(M.USDT).balanceOf(owner), 20_000e6, "borrowed USDT not swept to owner");

        // Health guard: passes at the real health, reverts above it.
        uint256 h = _health();
        exec.assertMinAaveHealth(owner, h);
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.AaveHealthTooLow.selector, owner, h, h + 1));
        exec.assertMinAaveHealth(owner, h + 1);

        vm.warp(block.timestamp + 7 days);
        deal(M.USDT, owner, 21_000e6); // the borrowed USDT + some for interest
        vm.prank(owner);
        (bool ok,) = M.USDT.call(abi.encodeCall(IERC20.approve, (me, type(uint256).max)));
        require(ok, "approve");

        // Repay 5k, withdraw 10k: health stays above 1.2.
        CovenantCore.Call[] memory c = new CovenantCore.Call[](6);
        c[0] = Plans.call(M.USDT, abi.encodeCall(IERC20.transferFrom, (owner, me, 5_000e6)));
        c[1] = Plans.call(M.USDT, abi.encodeCall(IERC20.approve, (M.AAVE_POOL, 5_000e6)));
        c[2] = Plans.call(M.AAVE_POOL, abi.encodeCall(IAavePool.repay, (M.USDT, 5_000e6, VARIABLE, owner)));
        c[3] = Plans.call(M.A_USDC, abi.encodeCall(IERC20.transferFrom, (owner, me, 10_000e6)));
        c[4] = Plans.call(M.AAVE_POOL, abi.encodeCall(IAavePool.withdraw, (M.USDC, type(uint256).max, me)));
        c[5] = Plans.call(me, abi.encodeCall(CovenantCore.assertMinAaveHealth, (owner, 1.2e18)));
        _run(exec, c);
        assertEq(IERC20(M.USDC).balanceOf(owner), 10_000e6, "withdrawn USDC not swept to owner");
        uint256 debt = IERC20(M.VDEBT_USDT).balanceOf(owner);
        assertGt(debt, 15_000e6);

        // No-debt guard fails while debt remains.
        vm.expectRevert(abi.encodeWithSelector(CovenantCore.BalanceTooHigh.selector, M.VDEBT_USDT, debt, 0));
        exec.assertMaxBalance(M.VDEBT_USDT, owner, 0);

        // Repay all from the wallet (pull the remaining USDT, repay exactly the live debt), then
        // withdraw all collateral.
        c = new CovenantCore.Call[](7);
        c[0] = Plans.patched(
            M.USDT, abi.encodeCall(IERC20.transferFrom, (owner, me, 0)), Plans.balanceOf(Plans.arg(2), M.USDT, owner)
        );
        c[1] = Plans.patched(M.USDT, abi.encodeCall(IERC20.approve, (M.AAVE_POOL, 0)), Plans.balanceOf(Plans.arg(1), M.USDT, me));
        c[2] = Plans.patched(
            M.AAVE_POOL,
            abi.encodeCall(IAavePool.repay, (M.USDT, 0, VARIABLE, owner)),
            Plans.balanceOf(Plans.arg(1), M.VDEBT_USDT, owner)
        );
        c[3] = Plans.call(me, abi.encodeCall(CovenantCore.assertMaxBalance, (M.VDEBT_USDT, owner, 0)));
        c[4] = Plans.patched(
            M.A_USDC, abi.encodeCall(IERC20.transferFrom, (owner, me, 0)), Plans.balanceOf(Plans.arg(2), M.A_USDC, owner)
        );
        c[5] = Plans.call(M.AAVE_POOL, abi.encodeCall(IAavePool.withdraw, (M.USDC, type(uint256).max, me)));
        c[6] = Plans.call(me, abi.encodeCall(CovenantCore.assertMinAaveHealth, (owner, type(uint256).max)));
        uint256 usdt0 = IERC20(M.USDT).balanceOf(owner);
        _run(exec, c);

        assertEq(IERC20(M.VDEBT_USDT).balanceOf(owner), 0, "Aave debt left");
        assertEq(IERC20(M.A_USDC).balanceOf(owner), 0, "aUSDC left");
        assertEq(IERC20(M.USDT).balanceOf(owner), usdt0 - debt, "unused USDT not returned");
        assertGt(IERC20(M.USDC).balanceOf(owner), 50_000e6, "collateral (+ interest) not returned");
        assertEq(IERC20(M.A_USDC).balanceOf(me), 0, "executor holds aUSDC");
        _assertExecutorEmpty(exec);
    }
}
