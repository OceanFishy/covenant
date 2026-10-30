// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantExecutor} from "../../contracts/CovenantExecutor.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams} from "../../contracts/interfaces/IMorpho.sol";
import {IPYieldToken, IStandardizedYield} from "../../contracts/interfaces/IPendle.sol";

/// @notice Builds Executor call lists for the loop templates in docs/SPEC.md §7.
/// This is a Solidity prototype of the M1 TypeScript compiler, used by the fork tests.
library Plans {
    uint32 internal constant FULL = 10_000;

    /// Byte offset of argument word `i` in calldata (after the 4-byte selector).
    function arg(uint256 i) internal pure returns (uint32) {
        return uint32(4 + 32 * i);
    }

    function call(address target, bytes memory data) internal pure returns (CovenantExecutor.Call memory c) {
        c.target = target;
        c.data = data;
        c.patches = new CovenantExecutor.Patch[](0);
    }

    function patched(address target, bytes memory data, CovenantExecutor.Patch memory p)
        internal
        pure
        returns (CovenantExecutor.Call memory c)
    {
        c.target = target;
        c.data = data;
        c.patches = new CovenantExecutor.Patch[](1);
        c.patches[0] = p;
    }

    function balanceOf(uint32 offset, address token, address account)
        internal
        pure
        returns (CovenantExecutor.Patch memory)
    {
        return CovenantExecutor.Patch(offset, CovenantExecutor.Source.BALANCE, abi.encode(token, account), FULL);
    }

    function morphoValue(uint32 offset, CovenantExecutor.Source source, bytes32 id, address user, uint32 bps)
        internal
        pure
        returns (CovenantExecutor.Patch memory)
    {
        return CovenantExecutor.Patch(offset, source, abi.encode(id, user), bps);
    }

    struct Loop {
        address executor;
        address owner;
        address morpho;
        bytes32 id;
        MarketParams params;
        address loanToken; // USDC or USDT
        address pt;
        address yt; // also the Pendle YT contract
        address sy;
        address tokenOut; // what SY redeems to / deposits from (USDC for SY-USD3)
    }

    /// Aggregator swap between tokenOut and loanToken (0x or KyberSwap), quoted off-chain for
    /// a fixed sell amount with the executor as taker and recipient. Unused when loanToken == tokenOut.
    struct Swap {
        address spender; // approved for `amountIn` of the sell token
        address target; // router / AllowanceHolder
        bytes data; // route calldata from the aggregator API
        uint256 amountIn;
        uint256 minOut; // enforced on-chain by assertMinBalance on the executor
    }

    function _swap(Loop memory l, address sellToken, address buyToken, Swap memory swap, CovenantExecutor.Call[] memory c, uint256 n)
        private
        pure
        returns (uint256)
    {
        c[n++] = call(sellToken, abi.encodeCall(IERC20.approve, (swap.spender, swap.amountIn)));
        c[n++] = call(swap.target, swap.data);
        c[n++] = call(l.executor, abi.encodeCall(CovenantExecutor.assertMinBalance, (buyToken, l.executor, swap.minOut)));
        return n;
    }

    function needsSwap(Loop memory l) internal pure returns (bool) {
        return l.loanToken != l.tokenOut;
    }

    /// Matched PT+YT redemption of the executor's whole PT balance into `tokenOut`, then
    /// (if needed) a fixed-size swap of tokenOut into the loan token to repay the flash loan.
    /// Assumes the executor holds exactly as much YT as PT (pre-expiry).
    function _redeemInner(
        Loop memory l,
        uint256 minOut,
        Swap memory swap,
        CovenantExecutor.Call[] memory inner,
        uint256 n
    ) private pure returns (uint256) {
        inner[n++] = patched(l.pt, abi.encodeCall(IERC20.transfer, (l.yt, 0)), balanceOf(arg(1), l.pt, l.executor));
        inner[n++] = patched(l.yt, abi.encodeCall(IERC20.transfer, (l.yt, 0)), balanceOf(arg(1), l.yt, l.executor));
        inner[n++] = call(l.yt, abi.encodeCall(IPYieldToken.redeemPY, (l.executor)));
        inner[n++] = patched(
            l.sy,
            abi.encodeCall(IStandardizedYield.redeem, (l.executor, 0, l.tokenOut, minOut, false)),
            balanceOf(arg(1), l.sy, l.executor)
        );
        if (needsSwap(l)) n = _swap(l, l.tokenOut, l.loanToken, swap, inner, n);
        return n;
    }

    function _alloc(Loop memory l, uint256 base) private pure returns (CovenantExecutor.Call[] memory) {
        return new CovenantExecutor.Call[](needsSwap(l) ? base + 3 : base);
    }

    /// §7.1 Flash-unwind: repay all debt, withdraw all collateral, redeem PT+YT, (swap), repay the flash loan.
    /// `ytAmount` must equal the position's collateral (pulled from the owner).
    function flashUnwind(Loop memory l, uint256 ytAmount, uint256 minOut, Swap memory swap)
        internal
        pure
        returns (CovenantExecutor.Call[] memory top)
    {
        CovenantExecutor.Call[] memory inner = _alloc(l, 7);
        uint256 n;
        inner[n++] = patched(
            l.loanToken, abi.encodeCall(IERC20.approve, (l.morpho, 0)), balanceOf(arg(1), l.loanToken, l.executor)
        );
        // repay(params, 0, shares = all, owner, "") — params occupy words 0..4
        inner[n++] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.repay, (l.params, 0, 0, l.owner, "")),
            morphoValue(arg(6), CovenantExecutor.Source.MORPHO_BORROW_SHARES, l.id, l.owner, FULL)
        );
        inner[n++] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.withdrawCollateral, (l.params, 0, l.owner, l.executor)),
            morphoValue(arg(5), CovenantExecutor.Source.MORPHO_COLLATERAL, l.id, l.owner, FULL)
        );
        n = _redeemInner(l, minOut, swap, inner, n);
        assert(n == inner.length);

        top = new CovenantExecutor.Call[](4);
        top[0] = call(l.morpho, abi.encodeCall(IMorpho.accrueInterest, (l.params)));
        top[1] = call(l.yt, abi.encodeCall(IERC20.transferFrom, (l.owner, l.executor, ytAmount)));
        top[2] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.flashLoan, (l.loanToken, 0, abi.encode(l.loanToken, inner))),
            // flash = current debt + 0.01% buffer; leftovers are swept back to the owner
            morphoValue(arg(1), CovenantExecutor.Source.MORPHO_DEBT_ASSETS, l.id, l.owner, 10_001)
        );
        top[3] = call(l.executor, abi.encodeCall(CovenantExecutor.assertNoDebt, (l.id, l.owner)));
    }

    /// §6.3 Matched (partial) unwind when YT < PT: flash `repayAssets`, repay that much debt,
    /// withdraw only `matched` PT (= YT pulled), redeem, (swap), repay the flash loan.
    function matchedUnwind(Loop memory l, uint256 matched, uint256 repayAssets, uint256 minHealth, Swap memory swap)
        internal
        pure
        returns (CovenantExecutor.Call[] memory top)
    {
        CovenantExecutor.Call[] memory inner = _alloc(l, 7);
        uint256 n;
        inner[n++] = call(l.loanToken, abi.encodeCall(IERC20.approve, (l.morpho, repayAssets)));
        inner[n++] = call(l.morpho, abi.encodeCall(IMorpho.repay, (l.params, repayAssets, 0, l.owner, "")));
        inner[n++] = call(l.morpho, abi.encodeCall(IMorpho.withdrawCollateral, (l.params, matched, l.owner, l.executor)));
        n = _redeemInner(l, 0, swap, inner, n);
        assert(n == inner.length);

        top = new CovenantExecutor.Call[](4);
        top[0] = call(l.morpho, abi.encodeCall(IMorpho.accrueInterest, (l.params)));
        top[1] = call(l.yt, abi.encodeCall(IERC20.transferFrom, (l.owner, l.executor, matched)));
        top[2] = call(
            l.morpho, abi.encodeCall(IMorpho.flashLoan, (l.loanToken, repayAssets, abi.encode(l.loanToken, inner)))
        );
        top[3] = call(l.executor, abi.encodeCall(CovenantExecutor.assertMinHealth, (l.id, l.owner, minHealth)));
    }

    /// §7.4 Enter: pull `equity` tokenOut, flash `flash` loanToken, (swap it to tokenOut), mint PT+YT
    /// from all tokenOut (YT to owner), supply PT as collateral, borrow `flash` to repay the flash loan.
    function enter(Loop memory l, uint256 equity, uint256 flash, uint256 minHealth, Swap memory swap)
        internal
        pure
        returns (CovenantExecutor.Call[] memory top)
    {
        CovenantExecutor.Call[] memory inner = _alloc(l, 7);
        uint256 n;
        if (needsSwap(l)) n = _swap(l, l.loanToken, l.tokenOut, swap, inner, n); // sell the flash-loaned USDT
        inner[n++] = patched(
            l.tokenOut, abi.encodeCall(IERC20.approve, (l.sy, 0)), balanceOf(arg(1), l.tokenOut, l.executor)
        );
        inner[n++] = patched(
            l.sy,
            abi.encodeCall(IStandardizedYield.deposit, (l.executor, l.tokenOut, 0, 0)),
            balanceOf(arg(2), l.tokenOut, l.executor)
        );
        inner[n++] = patched(l.sy, abi.encodeCall(IERC20.transfer, (l.yt, 0)), balanceOf(arg(1), l.sy, l.executor));
        inner[n++] = call(l.yt, abi.encodeCall(IPYieldToken.mintPY, (l.executor, l.owner)));
        inner[n++] =
            patched(l.pt, abi.encodeCall(IERC20.approve, (l.morpho, 0)), balanceOf(arg(1), l.pt, l.executor));
        inner[n++] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.supplyCollateral, (l.params, 0, l.owner, "")),
            balanceOf(arg(5), l.pt, l.executor)
        );
        inner[n++] = call(l.morpho, abi.encodeCall(IMorpho.borrow, (l.params, flash, 0, l.owner, l.executor)));
        assert(n == inner.length);

        top = new CovenantExecutor.Call[](3);
        top[0] = call(l.tokenOut, abi.encodeCall(IERC20.transferFrom, (l.owner, l.executor, equity)));
        top[1] =
            call(l.morpho, abi.encodeCall(IMorpho.flashLoan, (l.loanToken, flash, abi.encode(l.loanToken, inner))));
        top[2] = call(l.executor, abi.encodeCall(CovenantExecutor.assertMinHealth, (l.id, l.owner, minHealth)));
    }
}
