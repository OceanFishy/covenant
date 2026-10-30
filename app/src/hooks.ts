import { useCallback, useEffect, useRef, useState } from "react";

/** Runs `fn` now and every `ms` (default: one Ethereum block). */
export function usePoll<T>(fn: (() => Promise<T>) | undefined, deps: unknown[], ms = 12_000) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async () => {
    const f = fnRef.current;
    if (!f) return;
    setLoading(true);
    try {
      setData(await f());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(undefined);
    if (!fn) return;
    void refresh();
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh };
}

/** `#/review?market=…` style routing; no server needed. */
export function useRoute(): { path: string; params: URLSearchParams } {
  const parse = () => {
    const [path, query] = (window.location.hash.slice(1) || "/").split("?");
    return { path: path === "/revoke" ? "/access" : path, params: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(hash: string) {
  window.location.hash = hash;
}
