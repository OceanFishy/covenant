import type { Flow } from "./types";

const DRAFT = "covenant.builder.draft";
const SAVED = "covenant.builder.saved";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: drafts just aren't kept */
  }
}

export function loadDraft(): Flow | undefined {
  return read<Flow | undefined>(DRAFT, undefined);
}

export function saveDraft(flow: Flow) {
  write(DRAFT, flow);
}

export function savedFlows(): Flow[] {
  return read<Flow[]>(SAVED, []);
}

export function saveFlow(flow: Flow) {
  write(SAVED, [...savedFlows().filter((f) => f.name !== flow.name), flow]);
}

export function deleteFlow(name: string) {
  write(SAVED, savedFlows().filter((f) => f.name !== name));
}

/** Basic shape check for imported / shared flows (blocks are re-validated before compiling). */
export function parseFlow(json: string): Flow {
  const f = JSON.parse(json) as Flow;
  if (f?.version !== 1 || !Array.isArray(f.blocks) || typeof f.name !== "string") throw new Error("not a Covenant flow");
  return f;
}

/** Share as a URL fragment: nothing leaves your machine unless you send the link. */
export function flowToHash(flow: Flow): string {
  const bytes = new TextEncoder().encode(JSON.stringify(flow));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `#/builder?flow=${encodeURIComponent(btoa(bin))}`;
}

export function flowFromParam(param: string): Flow {
  const bin = atob(decodeURIComponent(param));
  return parseFlow(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
