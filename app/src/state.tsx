import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { publicClient } from "./lib/chain";
import { currentExecutor, knownExecutors, readDelegation, rememberExecutor, verifyExecutor, type Delegation, type Verification } from "./lib/executor";
import { confirmedRpc, confirmRpc, type ProtectedRpcId } from "./lib/mev";
import { connect, discoverRabby, wrongNetwork, type Connection, type ProviderDetail } from "./lib/wallet";

type AppState = {
  rabby: ProviderDetail | undefined | null; // null = looked and found none
  conn?: Connection;
  connectError?: string;
  connectWallet: () => Promise<void>;
  wrongNetwork: boolean;
  /** The Executor plans run on: a deployed Executor, or your own address in EIP-7702 mode. */
  executor?: Address;
  executorCheck?: Verification;
  /** Your account's EIP-7702 delegation; `covenant` makes it run plans itself. */
  delegation?: Delegation;
  executors: Address[];
  useExecutor: (a: Address) => Promise<Verification>;
  mevRpc?: ProtectedRpcId;
  setMevRpc: (id: ProtectedRpcId | undefined) => void;
  /** Why sending is blocked right now (no wallet, wrong network, no MEV RPC), else undefined. */
  signBlockedReason?: string;
  /** Bumped after any transaction so views re-read the chain. */
  version: number;
  bump: () => void;
};

const Ctx = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [rabby, setRabby] = useState<ProviderDetail | undefined | null>(undefined);
  const [conn, setConn] = useState<Connection>();
  const [connectError, setConnectError] = useState<string>();
  const [executor, setExecutor] = useState<Address>();
  const [executorCheck, setExecutorCheck] = useState<Verification>();
  const [delegation, setDelegation] = useState<Delegation>();
  const [mevRpc, setMevRpcState] = useState<ProtectedRpcId | undefined>(confirmedRpc());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Find Rabby, and reconnect without a prompt if it already authorized this site.
  useEffect(() => {
    void discoverRabby().then(async (r) => {
      setRabby(r ?? null);
      if (r) setConn(await connect(r, true).catch(() => undefined));
    });
  }, []);

  const connectWallet = useCallback(async () => {
    if (!rabby) return;
    try {
      setConn(await connect(rabby));
      setConnectError(undefined);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    }
  }, [rabby]);

  // Follow account / network changes in Rabby.
  useEffect(() => {
    const p = rabby?.provider;
    if (!p || !conn) return;
    const reconnect = () => void connectWallet();
    p.on("accountsChanged", reconnect);
    p.on("chainChanged", reconnect);
    return () => {
      p.removeListener("accountsChanged", reconnect);
      p.removeListener("chainChanged", reconnect);
    };
  }, [rabby, conn, connectWallet]);

  // Load and verify where plans run. An account delegated to the Covenant delegate runs them
  // itself (EIP-7702 mode); otherwise the owner's latest deployed Executor. A refresh (version
  // bump, e.g. after every transaction) keeps the current values until the new ones arrive:
  // the delegation read is async, and clearing them would unmount the page mid-flow (Review's
  // "Done."). They are cleared only when the account changes.
  const loadedFor = useRef<Address | undefined>(undefined);
  const shownExecutor = useRef<Address | undefined>(undefined);
  useEffect(() => {
    if (loadedFor.current !== conn?.account) {
      loadedFor.current = conn?.account;
      shownExecutor.current = undefined;
      setExecutor(undefined);
      setExecutorCheck(undefined);
      setDelegation(undefined);
    }
    if (!conn) return;
    const owner = conn.account;
    let live = true;
    void readDelegation(publicClient, owner)
      .catch((): Delegation => ({ kind: "none" }))
      .then((d) => {
        if (!live) return;
        setDelegation(d);
        const ex = d.kind === "covenant" ? owner : currentExecutor(owner);
        // A different Executor must not inherit the previous one's verification.
        if (shownExecutor.current !== ex) setExecutorCheck(undefined);
        shownExecutor.current = ex;
        setExecutor(ex);
        if (!ex) return;
        void verifyExecutor(publicClient, ex, owner).then((c) => live && setExecutorCheck(c));
      });
    return () => {
      live = false;
    };
  }, [conn, version]);

  const useExecutor = useCallback(
    async (a: Address) => {
      if (!conn) throw new Error("connect first");
      const v = await verifyExecutor(publicClient, a, conn.account);
      if (v.ok) {
        rememberExecutor(conn.account, a);
        bump();
      }
      return v;
    },
    [conn, bump],
  );

  const setMevRpc = useCallback((id: ProtectedRpcId | undefined) => {
    confirmRpc(id);
    setMevRpcState(id);
  }, []);

  const value = useMemo<AppState>(() => {
    const base: AppState = {
      rabby,
      conn,
      connectError,
      connectWallet,
      wrongNetwork: conn ? wrongNetwork(conn) : false,
      executor,
      executorCheck,
      delegation,
      executors: conn ? knownExecutors(conn.account) : [],
      useExecutor,
      mevRpc,
      setMevRpc,
      version,
      bump,
    };
    return { ...base, signBlockedReason: signBlocker(base) };
  }, [rabby, conn, connectError, connectWallet, executor, executorCheck, delegation, useExecutor, mevRpc, setMevRpc, version, bump]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppProvider missing");
  return v;
}

/** Why signing is blocked right now, or undefined when it's allowed. */
export function signBlocker(s: AppState): string | undefined {
  if (!s.conn) return "Connect Rabby first.";
  if (s.wrongNetwork) return "Rabby is on the wrong network.";
  if (!s.mevRpc) return "Confirm that Rabby uses an MEV-protected RPC (Setup).";
  return undefined;
}
