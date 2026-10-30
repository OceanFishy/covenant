import { createWalletClient, custom, getAddress, type Address, type EIP1193Provider, type Hex, type WalletClient } from "viem";
import { chain, publicClient, withChainLock } from "./chain";

/** EIP-6963 provider announcement. */
export type ProviderDetail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
};

/** Covenant only connects to Rabby (with a Ledger attached), docs/SPEC.md §3. */
export const RABBY_RDNS = "io.rabby";

/**
 * Returns the Rabby provider as soon as it announces itself over EIP-6963 (normally
 * synchronously), or undefined after `ms` if it never does.
 */
export function discoverRabby(ms = 400): Promise<ProviderDetail | undefined> {
  return new Promise((resolve) => {
    const done = (p?: ProviderDetail) => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(timer);
      resolve(p);
    };
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<ProviderDetail>).detail;
      if (d?.info?.rdns === RABBY_RDNS) done(d);
    };
    const timer = setTimeout(() => done(undefined), ms);
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  });
}

export type Connection = { account: Address; chainId: number; wallet: WalletClient; provider: EIP1193Provider };

/** `silent`: only reconnect if Rabby already authorized this site (eth_accounts, no prompt). */
export async function connect(detail: ProviderDetail, silent = false): Promise<Connection | undefined> {
  const provider = detail.provider;
  const accounts = (await provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" })) as string[];
  if (silent && !accounts.length) return undefined;
  if (!accounts.length) throw new Error("Rabby returned no account");
  const account = getAddress(accounts[0]);
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  return { account, chainId, wallet, provider };
}

export function wrongNetwork(c: Connection): boolean {
  return c.chainId !== chain.id;
}

export async function switchNetwork(c: Connection): Promise<void> {
  await c.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chain.id.toString(16)}` }] });
}

/** Sends one transaction through Rabby (→ Ledger) and waits for it to be mined. */
export async function send(c: Connection, tx: { to?: Address; data: Hex }) {
  // Hold the chain lock so a dev-fork simulation's evm_revert can't undo this transaction.
  return withChainLock(async () => {
    const hash = await c.wallet.sendTransaction({ account: c.account, chain, to: tx.to, data: tx.data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  });
}
