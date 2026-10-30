import type { Hex } from "viem";

/**
 * MEV protection (docs/SPEC.md §8). Rabby broadcasts every transaction, so the protected RPC is
 * set in Rabby itself: Settings → Custom RPC → Ethereum. That covers every Covenant transaction
 * (deploy, setup, plans, revokes) and every other dapp you use from that Rabby account.
 */
export const PROTECTED_RPCS = [
  {
    id: "flashbots",
    name: "Flashbots Protect",
    url: "https://rpc.flashbots.net",
    notes:
      "Recommended. Private to block builders, failed transactions are never included (no gas lost on a revert), and Covenant can confirm each transaction went through it.",
  },
  {
    id: "mevblocker",
    name: "MEV Blocker",
    url: "https://rpc.mevblocker.io/noreverts",
    notes: "The /noreverts endpoint also drops failing transactions. Covenant can't confirm routing for MEV Blocker.",
  },
] as const;

export type ProtectedRpcId = (typeof PROTECTED_RPCS)[number]["id"];

const KEY = "covenant.mevRpc";

/** Which protected RPC you confirmed is set in Rabby (per browser). */
export function confirmedRpc(): ProtectedRpcId | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return PROTECTED_RPCS.some((r) => r.id === v) ? (v as ProtectedRpcId) : undefined;
  } catch {
    return undefined;
  }
}

export function confirmRpc(id: ProtectedRpcId | undefined) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: asked again next time */
  }
}

export type ProtectStatus =
  | { kind: "private" } // Flashbots Protect saw it and it never hit the public mempool
  | { kind: "public" } // seen in the public mempool: not protected
  | { kind: "unknown" } // Flashbots Protect never saw it (MEV Blocker, or Rabby on a public RPC)
  | { kind: "unchecked"; reason: string };

/**
 * Asks Flashbots Protect's public status API (through the local proxy, /api/flashbots) whether
 * it handled `hash`. Only meaningful when you use Flashbots Protect.
 */
export async function checkFlashbots(hash: Hex, base = "/api/flashbots"): Promise<ProtectStatus> {
  try {
    const res = await fetch(`${base}/tx/${hash}`);
    if (!res.ok) return { kind: "unchecked", reason: `status API returned ${res.status}` };
    const d = (await res.json()) as { status?: string; seenInMempool?: boolean };
    if (d.seenInMempool) return { kind: "public" };
    if (d.status && d.status !== "UNKNOWN") return { kind: "private" };
    return { kind: "unknown" };
  } catch (e) {
    return { kind: "unchecked", reason: e instanceof Error ? e.message : String(e) };
  }
}
