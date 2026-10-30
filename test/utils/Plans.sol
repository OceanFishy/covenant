// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantCore} from "../../contracts/CovenantCore.sol";
import {CovenantDelegate} from "../../contracts/CovenantDelegate.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {IMorpho, MarketParams} from "../../contracts/interfaces/IMorpho.sol";
import {IPYieldToken, IStandardizedYield} from "../../contracts/interfaces/IPendle.sol";

/// @notice Builds call lists for the loop templates in docs/SPEC.md §7.
/// This is a Solidity prototype of the TypeScript compiler, used by the fork tests.
///
/// Two modes, as in the app: a deployed Executor (`executor != owner`: pulls with
/// transferFrom, "the plan's balance" = the Executor's balance), or EIP-7702 (`executor ==
/// owner`: the EOA runs the plan itself, pulls become `allot`, and the plan's balance is
/// Source.OWNED).
library Plans {
    uint32 internal constant FULL = 10_000;

    /// Byte offset of argument word `i` in calldata (after the 4-byte selector).
    function arg(uint256 i) internal pure returns (uint32) {
        return uint32(4 + 32 * i);
    }

    function call(address target, bytes memory data) internal pure returns (CovenantCore.Call memory c) {
        c.target = target;
        c.data = data;
        c.patches = new CovenantCore.Patch[](0);
    }

    function patched(address target, bytes memory data, CovenantCore.Patch memory p)
        internal
        pure
        returns (CovenantCore.Call memory c)
    {
        c.target = target;
        c.data = data;
        c.patches = new CovenantCore.Patch[](1);
        c.patches[0] = p;
    }

    function balanceOf(uint32 offset, address token, address account)
        internal
        pure
        returns (CovenantCore.Patch memory)
    {
        return CovenantCore.Patch(offset, CovenantCore.Source.BALANCE, abi.encode(token, account), FULL);
    }

    function owned(uint32 offset, address token) internal pure returns (CovenantCore.Patch memory) {
        return CovenantCore.Patch(offset, CovenantCore.Source.OWNED, abi.encode(token), FULL);
    }

    function morphoValue(uint32 offset, CovenantCore.Source source, bytes32 id, address user, uint32 bps)
        internal
        pure
        returns (CovenantCore.Patch memory)
    {
        return CovenantCore.Patch(offset, source, abi.encode(id, user), bps);
    }

    struct Loop {
        address executor; // the deployed Executor, or the owner itself under EIP-7702
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
        uint256 minOut; // enforced on-chain by the executor's balance guard
    }

    function is7702(Loop memory l) internal pure returns (bool) {
        return l.executor == l.owner;
    }

    /// The plan's own balance of `token` at `offset`.
    function held(Loop memory l, uint32 offset, address token) internal pure returns (CovenantCore.Patch memory) {
        return is7702(l) ? owned(offset, token) : balanceOf(offset, token, l.executor);
    }

    /// Brings `amount` of the owner's `token` into the plan.
    function pull(Loop memory l, address token, uint256 amount) internal pure returns (CovenantCore.Call memory) {
        return is7702(l)
            ? call(l.executor, abi.encodeCall(CovenantDelegate.allot, (token, amount)))
            : call(token, abi.encodeCall(IERC20.transferFrom, (l.owner, l.executor, amount)));
    }

    /// Reverts unless the plan holds at least `min` of `token`.
    function minHeld(Loop memory l, address token, uint256 min) internal pure returns (CovenantCore.Call memory) {
        return is7702(l)
            ? call(l.executor, abi.encodeCall(CovenantCore.assertMinOwned, (token, min)))
            : call(l.executor, abi.encodeCall(CovenantCore.assertMinBalance, (token, l.executor, min)));
    }

    function _swap(Loop memory l, address sellToken, address buyToken, Swap memory swap, CovenantCore.Call[] memory c, uint256 n)
        private
        pure
        returns (uint256)
    {
        c[n++] = call(sellToken, abi.encodeCall(IERC20.approve, (swap.spender, swap.amountIn)));
        c[n++] = call(swap.target, swap.data);
        c[n++] = minHeld(l, buyToken, swap.minOut);
        return n;
    }

    function needsSwap(Loop memory l) internal pure returns (bool) {
        return l.loanToken != l.tokenOut;
    }

    /// Matched PT+YT redemption of the plan's whole PT balance into `tokenOut`, then
    /// (if needed) a fixed-size swap of tokenOut into the loan token to repay the flash loan.
    /// Assumes the plan holds exactly as much YT as PT (pre-expiry).
    function _redeemInner(
        Loop memory l,
        uint256 minOut,
        Swap memory swap,
        CovenantCore.Call[] memory inner,
        uint256 n
    ) private pure returns (uint256) {
        inner[n++] = patched(l.pt, abi.encodeCall(IERC20.transfer, (l.yt, 0)), held(l, arg(1), l.pt));
        inner[n++] = patched(l.yt, abi.encodeCall(IERC20.transfer, (l.yt, 0)), held(l, arg(1), l.yt));
        inner[n++] = call(l.yt, abi.encodeCall(IPYieldToken.redeemPY, (l.executor)));
        inner[n++] = patched(
            l.sy,
            abi.encodeCall(IStandardizedYield.redeem, (l.executor, 0, l.tokenOut, minOut, false)),
            held(l, arg(1), l.sy)
        );
        if (needsSwap(l)) n = _swap(l, l.tokenOut, l.loanToken, swap, inner, n);
        return n;
    }

    function _alloc(Loop memory l, uint256 base) private pure returns (CovenantCore.Call[] memory) {
        return new CovenantCore.Call[](needsSwap(l) ? base + 3 : base);
    }

    /// §7.1 Flash-unwind: repay all debt, withdraw all collateral, redeem PT+YT, (swap), repay the flash loan.
    /// `ytAmount` must equal the position's collateral (pulled from the owner).
    function flashUnwind(Loop memory l, uint256 ytAmount, uint256 minOut, Swap memory swap)
        internal
        pure
        returns (CovenantCore.Call[] memory top)
    {
        CovenantCore.Call[] memory inner = _alloc(l, 7);
        uint256 n;
        inner[n++] = patched(l.loanToken, abi.encodeCall(IERC20.approve, (l.morpho, 0)), held(l, arg(1), l.loanToken));
        // repay(params, 0, shares = all, owner, "") — params occupy words 0..4
        inner[n++] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.repay, (l.params, 0, 0, l.owner, "")),
            morphoValue(arg(6), CovenantCore.Source.MORPHO_BORROW_SHARES, l.id, l.owner, FULL)
        );
        inner[n++] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.withdrawCollateral, (l.params, 0, l.owner, l.executor)),
            morphoValue(arg(5), CovenantCore.Source.MORPHO_COLLATERAL, l.id, l.owner, FULL)
        );
        n = _redeemInner(l, minOut, swap, inner, n);
        assert(n == inner.length);

        top = new CovenantCore.Call[](4);
        top[0] = call(l.morpho, abi.encodeCall(IMorpho.accrueInterest, (l.params)));
        top[1] = pull(l, l.yt, ytAmount);
        top[2] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.flashLoan, (l.loanToken, 0, abi.encode(l.loanToken, inner))),
            // flash = current debt + 0.01% buffer; leftovers are swept back to the owner
            morphoValue(arg(1), CovenantCore.Source.MORPHO_DEBT_ASSETS, l.id, l.owner, 10_001)
        );
        top[3] = call(l.executor, abi.encodeCall(CovenantCore.assertNoDebt, (l.id, l.owner)));
    }

    /// §6.3 Matched (partial) unwind when YT < PT: flash `repayAssets`, repay that much debt,
    /// withdraw only `matched` PT (= YT pulled), redeem, (swap), repay the flash loan.
    function matchedUnwind(Loop memory l, uint256 matched, uint256 repayAssets, uint256 minHealth, Swap memory swap)
        internal
        pure
        returns (CovenantCore.Call[] memory top)
    {
        CovenantCore.Call[] memory inner = _alloc(l, 7);
        uint256 n;
        inner[n++] = call(l.loanToken, abi.encodeCall(IERC20.approve, (l.morpho, repayAssets)));
        inner[n++] = call(l.morpho, abi.encodeCall(IMorpho.repay, (l.params, repayAssets, 0, l.owner, "")));
        inner[n++] = call(l.morpho, abi.encodeCall(IMorpho.withdrawCollateral, (l.params, matched, l.owner, l.executor)));
        n = _redeemInner(l, 0, swap, inner, n);
        assert(n == inner.length);

        top = new CovenantCore.Call[](4);
        top[0] = call(l.morpho, abi.encodeCall(IMorpho.accrueInterest, (l.params)));
        top[1] = pull(l, l.yt, matched);
        top[2] = call(
            l.morpho, abi.encodeCall(IMorpho.flashLoan, (l.loanToken, repayAssets, abi.encode(l.loanToken, inner)))
        );
        top[3] = call(l.executor, abi.encodeCall(CovenantCore.assertMinHealth, (l.id, l.owner, minHealth)));
    }

    /// §7.4 Enter: pull `equity` tokenOut, flash `flash` loanToken, (swap it to tokenOut), mint PT+YT
    /// from all tokenOut (YT to owner), supply PT as collateral, borrow `flash` to repay the flash loan.
    function enter(Loop memory l, uint256 equity, uint256 flash, uint256 minHealth, Swap memory swap)
        internal
        pure
        returns (CovenantCore.Call[] memory top)
    {
        CovenantCore.Call[] memory inner = _alloc(l, 7);
        uint256 n;
        if (needsSwap(l)) n = _swap(l, l.loanToken, l.tokenOut, swap, inner, n); // sell the flash-loaned USDT
        inner[n++] = patched(l.tokenOut, abi.encodeCall(IERC20.approve, (l.sy, 0)), held(l, arg(1), l.tokenOut));
        inner[n++] = patched(
            l.sy,
            abi.encodeCall(IStandardizedYield.deposit, (l.executor, l.tokenOut, 0, 0)),
            held(l, arg(2), l.tokenOut)
        );
        inner[n++] = patched(l.sy, abi.encodeCall(IERC20.transfer, (l.yt, 0)), held(l, arg(1), l.sy));
        inner[n++] = call(l.yt, abi.encodeCall(IPYieldToken.mintPY, (l.executor, l.owner)));
        inner[n++] = patched(l.pt, abi.encodeCall(IERC20.approve, (l.morpho, 0)), held(l, arg(1), l.pt));
        inner[n++] = patched(
            l.morpho,
            abi.encodeCall(IMorpho.supplyCollateral, (l.params, 0, l.owner, "")),
            held(l, arg(5), l.pt)
        );
        inner[n++] = call(l.morpho, abi.encodeCall(IMorpho.borrow, (l.params, flash, 0, l.owner, l.executor)));
        assert(n == inner.length);

        top = new CovenantCore.Call[](3);
        top[0] = pull(l, l.tokenOut, equity);
        top[1] =
            call(l.morpho, abi.encodeCall(IMorpho.flashLoan, (l.loanToken, flash, abi.encode(l.loanToken, inner))));
        top[2] = call(l.executor, abi.encodeCall(CovenantCore.assertMinHealth, (l.id, l.owner, minHealth)));
    }
}
