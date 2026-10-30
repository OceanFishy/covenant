// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";

import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams, Position} from "../../contracts/interfaces/IMorpho.sol";
import {LoopForkBase} from "../utils/LoopForkBase.sol";
import {Plans} from "../utils/Plans.sol";

/// Mainnet-fork tests for the PT-USD3 / USDT loop (LLTV 91.5%). SY-USD3 only redeems to
/// USDC/USD3, so USDC <-> USDT goes through a DEX aggregator with a live route fetched by
/// scripts/quote.mjs (0x if ZEROX_API_KEY is set, else KyberSwap).
/// Needs network access and ffi: `pnpm test:fork:aggregator`.
contract PtUsd3UsdtForkTest is LoopForkBase {
    bytes32 constant ID = M.MKT_PT_USD3_USDT;
    address constant BORROWER = 0x7A27F9586d0895F045b80B3Fb1D9D6eF4D54e9Bc; // ~793k PT, ~688k USDT debt

    function _quote(address sellToken, address buyToken, uint256 sellAmount, address taker)
        internal
        returns (Plans.Swap memory s, uint256 buyAmount)
    {
        string[] memory cmd = new string[](6);
        cmd[0] = "node";
        cmd[1] = "scripts/quote.mjs";
        cmd[2] = vm.toString(sellToken);
        cmd[3] = vm.toString(buyToken);
        cmd[4] = vm.toString(sellAmount);
        cmd[5] = vm.toString(taker);
        (s.spender, s.target, s.data, buyAmount) = abi.decode(vm.ffi(cmd), (address, address, bytes, uint256));
        s.amountIn = sellAmount;
    }

    /// Sizes the exit swap to buy just enough USDT to repay the flash loan (debt + 0.01%).
    /// The on-chain guard requires debt + 0.02%; quotes target debt + `headroomBps` so the route
    /// has room to drift between quote and execution. Routes differ between sizes, so when a
    /// quote comes back short, scale the sell amount by the shortfall and re-quote (max 3 tries).
    function _exitSwap(CovenantExecutor exec, address owner, uint256 headroomBps)
        internal
        returns (Plans.Swap memory s)
    {
        morpho.accrueInterest(morpho.idToMarketParams(ID));
        uint256 debt = exec.debtOf(ID, owner);
        uint256 minOut = debt * 10_002 / 10_000;
        uint256 target = debt * (10_000 + headroomBps) / 10_000;
        // Start from the current rate (probe quote) so little extra USDT is bought.
        (, uint256 probeOut) = _quote(M.USDC, M.USDT, debt, address(exec));
        uint256 sell = debt * target / probeOut;
        uint256 out;
        for (uint256 i; i < 3; ++i) {
            (s, out) = _quote(M.USDC, M.USDT, sell, address(exec));
            if (out >= target) break;
            sell = sell * target / out * 10_002 / 10_000;
        }
        s.minOut = minOut;
        assertGe(out, target, "aggregator quote below target USDT after 3 tries");
        console.log("exit swap: sell USDC / quoted USDT (6dp)", sell, out);
        console.log("debt", debt);
    }

    /// What the app does before signing (§8): simulate the unwind; if the swap guard trips
    /// because the route delivered less than quoted, re-quote with more headroom and try again.
    function _flashUnwindWithRequote(CovenantExecutor exec, address owner, uint256 collateral) internal {
        uint16[3] memory headroom = [uint16(10), 30, 60];
        for (uint256 i; i < headroom.length; ++i) {
            Plans.Swap memory swap = _exitSwap(exec, owner, headroom[i]);
            CovenantExecutor.Call[] memory calls = Plans.flashUnwind(_loop(exec, owner, ID), collateral, 0, swap);
            vm.prank(owner);
            try exec.execute(calls, _sweep(), keccak256(abi.encode(calls))) {
                return;
            } catch (bytes memory err) {
                console.log("simulation failed; re-quoting with more headroom (bps):", headroom[i]);
                if (i == headroom.length - 1) {
                    assembly ("memory-safe") {
                        revert(add(err, 32), mload(err))
                    }
                }
            }
        }
    }

    function test_flashUnwind_realPosition_usdt() public {
        (uint256 collateral, uint256 yt0) = _prepareRealBorrower(ID, BORROWER);
        CovenantExecutor exec = _deployFor(BORROWER);
        uint256 usdc0 = IERC20(M.USDC).balanceOf(BORROWER);
        uint256 usdt0 = IERC20(M.USDT).balanceOf(BORROWER);

        _flashUnwindWithRequote(exec, BORROWER, collateral);

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

        _flashUnwindWithRequote(exec, owner, pos.collateral);

        _assertClosed(ID, owner, 0, exec);
        uint256 out = IERC20(M.USDC).balanceOf(owner) + IERC20(M.USDT).balanceOf(owner);
        console.log("equity in / out USDC+USDT (6dp):", equity, out);
        assertApproxEqRel(out, equity, 0.01e18, "round trip lost more than 1%");
    }
}
