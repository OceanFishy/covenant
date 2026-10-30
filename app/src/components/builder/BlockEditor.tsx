import type { Address } from "viem";
import { PULL_TOKENS, SWAP_TOKENS } from "../../lib/builder/catalog";
import { marketByKey, seriesByKey } from "../../lib/builder/compile";
import type { Amount, Block } from "../../lib/builder/types";
import { MARKETS, SERIES, TOKENS, label } from "../../lib/registry";

type Props<B extends Block> = { block: B; onChange: (b: Block) => void };

function MarketSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="market">
      {MARKETS.map((m) => (
        <option key={m.key} value={m.key}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

function SeriesSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Pendle series">
      {Object.keys(SERIES).map((k) => (
        <option key={k}>{k}</option>
      ))}
    </select>
  );
}

function TokenSelect({ value, options, onChange, aria }: { value: Address; options: Address[]; onChange: (v: Address) => void; aria: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Address)} aria-label={aria}>
      {options.map((t) => (
        <option key={t} value={t}>
          {label(t)}
        </option>
      ))}
    </select>
  );
}

const KIND_LABEL: Record<Amount["kind"], string> = {
  fixed: "Amount",
  balance: "All (Executor balance)",
  debt: "Whole debt",
  collateral: "All collateral",
  allShares: "All debt (by shares)",
};

/** Amount picker limited to the kinds a block supports; fixed amounts are in `unit`. */
function AmountEditor<A extends Amount>({
  value,
  kinds,
  unit,
  market,
  onChange,
}: {
  value: A;
  kinds: Amount["kind"][];
  unit: string;
  market?: string;
  onChange: (a: A) => void;
}) {
  const make = (kind: Amount["kind"]): Amount => {
    switch (kind) {
      case "fixed":
        return { kind, value: value.kind === "fixed" ? value.value : "0" };
      case "debt":
        return { kind, market: market ?? MARKETS[0].key, bps: 10_001 };
      default:
        return { kind } as Amount;
    }
  };
  return (
    <span className="row tight">
      {kinds.length > 1 && (
        <select value={value.kind} onChange={(e) => onChange(make(e.target.value as Amount["kind"]) as A)} aria-label="amount kind">
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      )}
      {value.kind === "fixed" && (
        <>
          <input className="num" inputMode="decimal" value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} aria-label="amount" />
          <span className="muted small">{unit}</span>
        </>
      )}
      {value.kind === "debt" && (
        <>
          <span className="muted small">of</span>
          <MarketSelect value={value.market} onChange={(m) => onChange({ ...value, market: m })} />
          <span className="muted small">+</span>
          <input
            className="num short"
            inputMode="decimal"
            value={((value.bps - 10_000) / 100).toString()}
            onChange={(e) => onChange({ ...value, bps: 10_000 + Math.round(Number(e.target.value || 0) * 100) })}
            aria-label="buffer percent"
          />
          <span className="muted small">%</span>
        </>
      )}
    </span>
  );
}

/** Field editors for one block. */
export function BlockEditor({ block: b, onChange }: Props<Block>) {
  const set = (patch: Partial<Block>) => onChange({ ...b, ...patch } as Block);
  switch (b.type) {
    case "accrueInterest":
    case "guardNoDebt":
      return <MarketSelect value={b.market} onChange={(market) => set({ market })} />;
    case "pull":
      return (
        <span className="row tight">
          <TokenSelect value={b.token} options={PULL_TOKENS} onChange={(token) => set({ token })} aria="token" />
          <AmountEditor value={b.amount} kinds={["fixed"]} unit={label(b.token)} onChange={(amount) => set({ amount })} />
        </span>
      );
    case "flashLoan":
      return (
        <span className="row tight">
          <TokenSelect value={b.token} options={[TOKENS.USDC.address, TOKENS.USDT.address]} onChange={(token) => set({ token })} aria="loan token" />
          <AmountEditor value={b.amount} kinds={["debt", "fixed"]} unit={label(b.token)} onChange={(amount) => set({ amount })} />
        </span>
      );
    case "repay":
      return (
        <span className="row tight">
          <MarketSelect value={b.market} onChange={(market) => set({ market })} />
          <AmountEditor value={b.amount} kinds={["allShares", "balance", "fixed"]} unit={label(marketByKey(b.market).loanToken)} onChange={(amount) => set({ amount })} />
        </span>
      );
    case "withdrawCollateral":
      return (
        <span className="row tight">
          <MarketSelect value={b.market} onChange={(market) => set({ market })} />
          <AmountEditor value={b.amount} kinds={["collateral", "fixed"]} unit="PT" onChange={(amount) => set({ amount })} />
        </span>
      );
    case "supplyCollateral":
      return (
        <span className="row tight">
          <MarketSelect value={b.market} onChange={(market) => set({ market })} />
          <AmountEditor value={b.amount} kinds={["balance", "fixed"]} unit="PT" onChange={(amount) => set({ amount })} />
        </span>
      );
    case "borrow":
      return (
        <span className="row tight">
          <MarketSelect value={b.market} onChange={(market) => set({ market })} />
          <AmountEditor value={b.amount} kinds={["fixed"]} unit={label(marketByKey(b.market).loanToken)} onChange={(amount) => set({ amount })} />
        </span>
      );
    case "redeemPY":
      return (
        <span className="row tight">
          <SeriesSelect value={b.series} onChange={(series) => set({ series })} />
          <AmountEditor value={b.amount} kinds={["balance", "fixed"]} unit="PT" onChange={(amount) => set({ amount })} />
        </span>
      );
    case "redeemSY": {
      const s = seriesByKey(b.series);
      const outs = s.name.includes("reUSD") ? [TOKENS.reUSD.address] : [TOKENS.USDC.address, TOKENS.USD3.address];
      return (
        <span className="row tight">
          <SeriesSelect value={b.series} onChange={(series) => set({ series, tokenOut: seriesByKey(series).tokenOut })} />
          <span className="muted small">to</span>
          <TokenSelect value={b.tokenOut} options={outs} onChange={(tokenOut) => set({ tokenOut })} aria="token out" />
          <span className="muted small">min</span>
          <AmountEditor value={b.minOut} kinds={["fixed"]} unit={label(b.tokenOut)} onChange={(minOut) => set({ minOut })} />
        </span>
      );
    }
    case "mintPY":
      return (
        <span className="row tight">
          <SeriesSelect value={b.series} onChange={(series) => set({ series })} />
          <TokenSelect value={b.tokenIn} options={[TOKENS.USDC.address, TOKENS.USD3.address]} onChange={(tokenIn) => set({ tokenIn })} aria="token in" />
          <AmountEditor value={b.amount} kinds={["balance", "fixed"]} unit={label(b.tokenIn)} onChange={(amount) => set({ amount })} />
          <select value={b.ytTo} onChange={(e) => set({ ytTo: e.target.value as "wallet" | "executor" })} aria-label="YT goes to">
            <option value="wallet">YT → your wallet</option>
            <option value="executor">YT → Executor</option>
          </select>
        </span>
      );
    case "swap":
      return (
        <span className="row tight">
          <TokenSelect value={b.sell} options={SWAP_TOKENS} onChange={(sell) => set({ sell })} aria="sell" />
          <span className="muted small">→</span>
          <TokenSelect value={b.buy} options={SWAP_TOKENS} onChange={(buy) => set({ buy })} aria="buy" />
          <select value={b.mode} onChange={(e) => set({ mode: e.target.value as "exactIn" | "minOut" })} aria-label="swap mode">
            <option value="minOut">buy at least</option>
            <option value="exactIn">sell exactly</option>
          </select>
          <AmountEditor value={b.amount} kinds={b.mode === "minOut" ? ["fixed", "debt"] : ["fixed"]} unit={label(b.mode === "exactIn" ? b.sell : b.buy)} onChange={(amount) => set({ amount })} />
        </span>
      );
    case "guardMinBalance":
      return (
        <span className="row tight">
          <TokenSelect value={b.token} options={PULL_TOKENS} onChange={(token) => set({ token })} aria="token" />
          <AmountEditor value={b.min} kinds={["fixed"]} unit={label(b.token)} onChange={(min) => set({ min })} />
        </span>
      );
    case "guardMinHealth":
      return (
        <span className="row tight">
          <MarketSelect value={b.market} onChange={(market) => set({ market })} />
          <span className="muted small">≥</span>
          <input className="num short" inputMode="decimal" value={b.min} onChange={(e) => set({ min: e.target.value })} aria-label="minimum health factor" />
        </span>
      );
  }
}
