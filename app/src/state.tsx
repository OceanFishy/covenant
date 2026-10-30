import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { publicClient } from "./lib/chain";
import { currentExecutor, knownExecutors, rememberExecutor, verifyExecutor, type Verification } from "./lib/executor";
import { confirmedRpc, confirmRpc, type ProtectedRpcId } from "./lib/mev";
import { connect, discoverRabby, wrongNetwork, type Connection, type ProviderDetail } from "./lib/wallet";

type AppState = {
  rabby: ProviderDetail | undefined | null; // null = looked and found none
  conn?: Connection;
  connectError?: string;
  connectWallet: () => Promise<void>;
  wrongNetwork: boolean;
  executor?: Address;
  executorCheck?: Verification;
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

  // Load and verify the owner's current Executor.
  useEffect(() => {
    setExecutor(undefined);
    setExecutorCheck(undefined);
    if (!conn) return;
    const ex = currentExecutor(conn.account);
    if (!ex) return;
    setExecutor(ex);
    void verifyExecutor(publicClient, ex, conn.account).then(setExecutorCheck);
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
      executors: conn ? knownExecutors(conn.account) : [],
      useExecutor,
      mevRpc,
      setMevRpc,
      version,
      bump,
    };
    return { ...base, signBlockedReason: signBlocker(base) };
  }, [rabby, conn, connectError, connectWallet, executor, executorCheck, useExecutor, mevRpc, setMevRpc, version, bump]);
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
