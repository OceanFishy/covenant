// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";

import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {Position} from "../../contracts/interfaces/IMorpho.sol";
import {LoopForkBase} from "../utils/LoopForkBase.sol";
import {Plans} from "../utils/Plans.sol";

interface ISYExchangeRate {
    /// USDC (6dp) per SY share (18dp), scaled by 1e18. SY-reUSD wraps reUSD 1:1, so this is reUSD's NAV.
    function exchangeRate() external view returns (uint256);
}

/// Mainnet-fork tests for the PT-reUSD / USDC loop (LLTV 91.5%). SY-reUSD only wraps reUSD and
/// Re's own mint/redeem is KYC-gated, so reUSD <-> USDC goes through a DEX aggregator with a live
/// route fetched by scripts/quote.mjs (0x if ZEROX_API_KEY is set, else KyberSwap). Exits sell
/// only the debt portion and return the rest as reUSD; entries take equity in reUSD.
/// Decimals: PT/YT 6, SY/reUSD 18, USDC 6.
/// Needs network access and ffi: `pnpm test:fork:aggregator`.
contract PtReUsdUsdcForkTest is LoopForkBase {
    bytes32 constant ID = M.MKT_PT_REUSD_USDC;

    /// Real borrowers at the time of writing, tried in order. Mid-size on purpose: on 2026-10-30
    /// KyberSwap's route for ~2.4M+ reUSD went through a Uniswap v4 hook pool that reverts on
    /// mainnet too ("Call failed"), which would test Kyber rather than the Executor.
    address constant BORROWER_1 = 0x0cA6CAdb6a8cA4199788b9a060C3285Fe7B897Fd; // ~531k PT, ~456k USDC debt
    address constant BORROWER_2 = 0x03BAbEB24619902253FDB0D5675A816879115d98; // ~513k PT, ~434k USDC debt
    address constant BORROWER_3 = 0x2156f29D64f81701B58877129006E8b1964149B6; // ~897k PT, ~800k USDC debt

    /// USDC value (6dp) of `reusd` (18dp) at reUSD's NAV.
    function _usdValue(uint256 reusd) internal view returns (uint256) {
        return reusd * ISYExchangeRate(M.SY_REUSD).exchangeRate() / 1e18;
    }

    /// First reference borrower that still has a position (or the first one, which then skips).
    function _borrower() internal view returns (address) {
        address[3] memory candidates = [BORROWER_1, BORROWER_2, BORROWER_3];
        for (uint256 i; i < candidates.length; ++i) {
            if (morpho.position(ID, candidates[i]).borrowShares > 0) return candidates[i];
        }
        return candidates[0];
    }

    function test_flashUnwind_realPosition_reusd() public {
        address borrower = _borrower();
        (uint256 collateral, uint256 yt0) = _prepareRealBorrower(ID, borrower);
        CovenantExecutor exec = _deployFor(borrower);
        uint256 debt = exec.debtOf(ID, borrower);
        uint256 reusd0 = IERC20(M.REUSD).balanceOf(borrower);
        uint256 usdc0 = IERC20(M.USDC).balanceOf(borrower);

        _flashUnwindWithRequote(exec, borrower, ID, collateral);

        _assertClosed(ID, borrower, yt0, exec);
        uint256 reusd = IERC20(M.REUSD).balanceOf(borrower) - reusd0;
        uint256 usdcDust = IERC20(M.USDC).balanceOf(borrower) - usdc0;
        console.log("borrower:", borrower);
        console.log("PT collateral (6dp):", collateral);
        console.log("reUSD equity received (18dp):", reusd);
        console.log("reUSD equity value in USDC at NAV (6dp):", _usdValue(reusd));
        console.log("leftover USDC returned (6dp):", usdcDust);
        assertGt(reusd, 0, "no equity returned");
        // Leftover USDC is only the exit swap's overshoot of the debt: headroom (max 0.60% after
        // re-quotes) plus whatever the route beat its quote by.
        assertLt(usdcDust, debt / 100, "leftover USDC should be the swap's headroom over the debt");
    }

    function test_enterThenFlashUnwind_reusd() public {
        address owner = makeAddr("ledger");
        uint256 equity = 10_000e18; // reUSD
        uint256 flash = 20_000e6; // USDC
        _supplyLiquidity(ID, flash * 2);
        CovenantExecutor exec = _deployFor(owner);
        deal(M.REUSD, owner, equity);

        // Entry: flash USDC, buy reUSD, wrap all reUSD into SY, mint PT+YT, borrow USDC to repay.
        (Plans.Swap memory entrySwap, uint256 quoted) = _quote(M.USDC, M.REUSD, flash, address(exec));
        entrySwap.minOut = quoted * 997 / 1000;
        console.log("entry swap: sell USDC (6dp) / quoted reUSD (18dp):", flash, quoted);
        _execute(exec, owner, Plans.enter(_loop(exec, owner, ID), equity, flash, 1.02e18, entrySwap));

        Position memory pos = morpho.position(ID, owner);
        assertGt(pos.collateral, 0);
        assertEq(IERC20(M.YT_REUSD).balanceOf(owner), pos.collateral, "YT should match PT");
        uint256 health = exec.healthFactor(ID, owner);
        assertGe(health, 1.02e18);
        assertEq(IERC20(M.REUSD).balanceOf(owner), 0, "equity not fully used");
        _assertExecutorEmpty(exec);
        console.log("PT collateral (6dp) / health factor (1e18):", pos.collateral, health);

        _flashUnwindWithRequote(exec, owner, ID, pos.collateral);

        _assertClosed(ID, owner, 0, exec);
        uint256 reusdOut = IERC20(M.REUSD).balanceOf(owner);
        uint256 usdcOut = IERC20(M.USDC).balanceOf(owner);
        uint256 valueIn = _usdValue(equity);
        uint256 valueOut = _usdValue(reusdOut) + usdcOut;
        console.log("equity in / out reUSD (18dp):", equity, reusdOut);
        console.log("leftover USDC returned (6dp):", usdcOut);
        console.log("value in / out at reUSD NAV, USDC (6dp):", valueIn, valueOut);
        // Two DEX legs on the debt portion (USDC -> reUSD in, reUSD -> USDC out).
        assertApproxEqRel(valueOut, valueIn, 0.015e18, "round trip lost more than 1.5%");
    }
}
