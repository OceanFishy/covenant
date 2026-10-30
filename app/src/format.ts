import { formatUnits, type Address } from "viem";
import { tokenInfo } from "./lib/registry";

export const MAX_UINT = 2n ** 256n - 1n;

export function amount(value: bigint, token: Address, digits = 2): string {
  const { decimals } = tokenInfo(token);
  const n = Number(formatUnits(value, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function withSymbol(value: bigint, token: Address, digits = 2): string {
  return `${amount(value, token, digits)} ${tokenInfo(token).symbol}`;
}

export function signed(value: bigint, token: Address): string {
  const s = amount(value < 0n ? -value : value, token);
  return value < 0n ? `−${s}` : value > 0n ? `+${s}` : "0";
}

/** Health factor (1e18 = liquidation). */
export function health(h: bigint): string {
  if (h >= 10n ** 30n) return "∞";
  return (Number(h / 10n ** 14n) / 10_000).toFixed(3);
}

export function pct(wad: bigint): string {
  return `${(Number(wad / 10n ** 12n) / 10_000).toFixed(2)}%`;
}

export function allowance(value: bigint, token: Address): string {
  return value > 10n ** 60n ? "unlimited" : withSymbol(value, token);
}
