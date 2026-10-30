// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";

import {CovenantCore} from "../../contracts/CovenantCore.sol";
import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {CovenantDelegateMainnet} from "../../contracts/CovenantDelegateMainnet.sol";
import {MainnetConfig as M} from "../../contracts/config/MainnetConfig.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams, Position} from "../../contracts/interfaces/IMorpho.sol";
import {IAavePool} from "../../contracts/interfaces/IAave.sol";
import {Plans} from "./Plans.sol";

interface IUSD3Limits {
    function maxDeposit(address) external view returns (uint256);
    function availableDepositLimit(address) external view returns (uint256);
}

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// Shared setup and helpers for Pendle PT loop fork tests on any Morpho market.
abstract contract LoopForkBase is Test {
    IMorpho constant morpho = IMorpho(M.MORPHO);

    /// A Pendle PT series and the token its SY is entered from / exited to.
    struct Series {
        address pt;
        address yt;
        address sy;
        address tokenOut;
    }

    function setUp() public virtual {
        vm.createSelectFork("mainnet");
    }

    // ------------------------------------------------------------ series

    /// SY-USD3 redeems straight to USDC via 3Jane.
    function _usd3() internal pure returns (Series memory) {
        return Series(M.PT_USD3, M.YT_USD3, M.SY_USD3, M.USDC);
    }

    /// SY-reUSD only wraps reUSD; reUSD <-> USDC goes through an aggregator.
    function _reusd() internal pure returns (Series memory) {
        return Series(M.PT_REUSD, M.YT_REUSD, M.SY_REUSD, M.REUSD);
    }

    /// The series whose PT is the market's collateral.
    function _series(bytes32 id) internal view returns (Series memory) {
        address collateral = morpho.idToMarketParams(id).collateralToken;
        if (collateral == M.PT_USD3) return _usd3();
        if (collateral == M.PT_REUSD) return _reusd();
        revert("unknown PT collateral");
    }

    // ------------------------------------------------------------ setup helpers

    function _deployFor(address owner) internal returns (CovenantExecutor exec) {
        exec = new CovenantExecutor(owner, morpho, IAavePool(M.AAVE_POOL), M.rules(), M.recipients());
        // One-time setup from the Ledger (§5.2): authorize on Morpho, approve tokens to the Executor.
        vm.startPrank(owner);
        morpho.setAuthorization(address(exec), true);
        IERC20(M.YT_USD3).approve(address(exec), type(uint256).max);
        IERC20(M.YT_REUSD).approve(address(exec), type(uint256).max);
        IERC20(M.USDC).approve(address(exec), type(uint256).max);
        IERC20(M.REUSD).approve(address(exec), type(uint256).max);
        vm.stopPrank();
    }

    function _loop(CovenantExecutor exec, address owner, bytes32 id) internal view returns (Plans.Loop memory) {
        return _loopFor(address(exec), owner, id);
    }

    /// `executor == owner`: the EIP-7702 mode, where the delegated EOA runs the plan itself.
    function _loopFor(address executor, address owner, bytes32 id) internal view returns (Plans.Loop memory) {
        MarketParams memory params = morpho.idToMarketParams(id);
        Series memory s = _series(id);
        return Plans.Loop({
            executor: executor,
            owner: owner,
            morpho: address(morpho),
            id: id,
            params: params,
            loanToken: params.loanToken,
            pt: s.pt,
            yt: s.yt,
            sy: s.sy,
            tokenOut: s.tokenOut
        });
    }

    function _noSwap() internal pure returns (Plans.Swap memory s) {}

    function _sweep() internal pure returns (address[] memory s) {
        s = new address[](10);
        (s[0], s[1], s[2], s[3]) = (M.USDC, M.USDT, M.USD3, M.REUSD);
        (s[4], s[5], s[6]) = (M.PT_USD3, M.YT_USD3, M.SY_USD3);
        (s[7], s[8], s[9]) = (M.PT_REUSD, M.YT_REUSD, M.SY_REUSD);
    }

    function _assertExecutorEmpty(CovenantExecutor exec) internal view {
        address[] memory s = _sweep();
        for (uint256 i; i < s.length; ++i) {
            assertEq(IERC20(s[i]).balanceOf(address(exec)), 0, "executor holds tokens");
        }
    }

    function _execute(CovenantExecutor exec, address owner, CovenantCore.Call[] memory calls) internal {
        vm.prank(owner);
        exec.execute(calls, _sweep(), keccak256(abi.encode(calls)));
    }

    /// Delegates `eoa` to a fresh CovenantDelegateMainnet (designator as after a type-4
    /// transaction) and runs the one-time `initialize()` from the EOA itself.
    function _delegate(address eoa) internal returns (CovenantDelegateMainnet wallet) {
        CovenantDelegateMainnet impl = new CovenantDelegateMainnet();
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(impl)));
        wallet = CovenantDelegateMainnet(payable(eoa));
        vm.prank(eoa);
        wallet.initialize();
    }

    /// Runs a 7702 plan: a transaction from the EOA to itself, tracking every plan token.
    function _execute7702(address eoa, CovenantCore.Call[] memory calls) internal {
        vm.prank(eoa);
        CovenantDelegateMainnet(payable(eoa)).execute(calls, _sweep(), keccak256(abi.encode(calls)));
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
        address yt = _series(id).yt;
        yt0 = IERC20(yt).balanceOf(borrower);
        deal(yt, borrower, yt0 + collateral);
    }

    function _assertClosed(bytes32 id, address owner, uint256 yt0, CovenantExecutor exec) internal view {
        Position memory pos = morpho.position(id, owner);
        assertEq(pos.borrowShares, 0, "debt left");
        assertEq(pos.collateral, 0, "collateral left");
        assertEq(IERC20(_series(id).yt).balanceOf(owner), yt0, "YT not exactly consumed");
        _assertExecutorEmpty(exec);
    }

    // ------------------------------------------------------------ aggregator helpers (need ffi)

    /// Live aggregator route from scripts/quote.mjs (0x if ZEROX_API_KEY is set, else KyberSwap),
    /// with the executor as taker and recipient.
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

    /// Sizes the exit swap (tokenOut -> loan token) to buy just enough to repay the flash loan
    /// (debt + 0.01%). The on-chain guard requires debt + 0.02%; quotes target debt + `headroomBps`
    /// so the route has room to drift between quote and execution. Routes differ between sizes, so
    /// when a quote comes back short, scale the sell amount by the shortfall and re-quote (max 3 tries).
    function _exitSwap(CovenantExecutor exec, address owner, bytes32 id, uint256 headroomBps)
        internal
        returns (Plans.Swap memory s)
    {
        MarketParams memory params = morpho.idToMarketParams(id);
        morpho.accrueInterest(params);
        uint256 debt = exec.debtOf(id, owner);
        uint256 out;
        (s, out) = _quoteBuying(_series(id).tokenOut, params.loanToken, debt * (10_000 + headroomBps) / 10_000, address(exec), debt);
        s.minOut = debt * 10_002 / 10_000;
        console.log("exit swap: sell tokenOut / quoted loan token (native dp):", s.amountIn, out);
        console.log("debt (loan token dp):", debt);
    }

    /// Quote selling `sellToken` for at least `target` of `buyToken`. Starts from the current rate
    /// (a probe selling `probe` units of buyToken, rescaled to sellToken's decimals) so little
    /// extra is bought, then re-quotes up to 3 times scaling the sell amount by any shortfall.
    function _quoteBuying(address sellToken, address buyToken, uint256 target, address taker, uint256 probe)
        internal
        returns (Plans.Swap memory s, uint256 out)
    {
        uint256 probeIn = probe * 10 ** IDecimals(sellToken).decimals() / 10 ** IDecimals(buyToken).decimals();
        (, uint256 probeOut) = _quote(sellToken, buyToken, probeIn, taker);
        uint256 sell = probeIn * target / probeOut;
        for (uint256 i; i < 3; ++i) {
            (s, out) = _quote(sellToken, buyToken, sell, taker);
            if (out >= target) break;
            sell = sell * target / out * 10_002 / 10_000;
        }
        assertGe(out, target, "aggregator quote below target after 3 tries");
    }

    /// What the app does before signing (§8): simulate the unwind; if the swap guard trips
    /// because the route delivered less than quoted, re-quote with more headroom and try again.
    function _flashUnwindWithRequote(CovenantExecutor exec, address owner, bytes32 id, uint256 collateral) internal {
        uint16[3] memory headroom = [uint16(10), 30, 60];
        for (uint256 i; i < headroom.length; ++i) {
            Plans.Swap memory swap = _exitSwap(exec, owner, id, headroom[i]);
            CovenantCore.Call[] memory calls = Plans.flashUnwind(_loop(exec, owner, id), collateral, 0, swap);
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
}
