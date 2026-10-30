// Pure helpers for scripts/ledger7702.mjs: BIP32 path packing, the Ledger Ethereum app's
// EIP-7702 authorization TLV, APDU chunking, response parsing and signed-tx assembly.
// No I/O here, so test/unit/ledger7702.test.ts can cover all of it.
import { bytesToHex, fromRlp, getAddress, hexToBytes, isHex, toRlp } from "viem";

export const DEFAULT_PATH = "m/44'/60'/0'/0/0";
export const CLA = 0xe0;
export const INS = { GET_ADDRESS: 0x02, SIGN_TX: 0x04, SIGN_AUTH_7702: 0x34 };
export const CHUNK_SIZE = 255;
/** EIP-7702 delegation designator prefix: delegated code is 0xef0100 ++ delegate. */
export const DESIGNATOR_PREFIX = "0xef0100";
const HARDENED = 0x80000000;
const MAX_PATH_DEPTH = 10; // MAX_BIP32_PATH in app-ethereum
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const U64_MAX = (1n << 64n) - 1n;

/** "m/44'/60'/0'/0/0" -> [0x8000002c, 0x8000003c, 0x80000000, 0, 0]. */
export function parsePath(path) {
  const parts = path.replace(/^m\//, "").split("/");
  if (parts.length === 0 || parts.length > MAX_PATH_DEPTH || parts[0] === "") {
    throw new Error(`invalid BIP32 path "${path}"`);
  }
  return parts.map((part) => {
    const m = /^(\d+)(['hH]?)$/.exec(part);
    if (!m) throw new Error(`invalid BIP32 path component "${part}" in "${path}"`);
    const index = Number(m[1]);
    if (!Number.isSafeInteger(index) || index >= HARDENED) throw new Error(`BIP32 index out of range in "${path}"`);
    return m[2] ? (index | HARDENED) >>> 0 : index;
  });
}

/** Ledger path encoding: 1 byte component count, then each index as uint32 big-endian. */
export function packPath(path) {
  const indices = parsePath(path);
  const out = new Uint8Array(1 + 4 * indices.length);
  const view = new DataView(out.buffer);
  out[0] = indices.length;
  indices.forEach((index, i) => view.setUint32(1 + 4 * i, index, false));
  return out;
}

/** Minimal big-endian bytes of an unsigned integer below 2^64 (at least one byte). */
function u64Bytes(value, name) {
  const v = BigInt(value);
  if (v < 0n || v > U64_MAX) throw new Error(`${name} must fit in a uint64`);
  const bytes = [];
  for (let x = v; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
  return Uint8Array.from(bytes.length ? bytes : [0]);
}

function tlv(tag, value) {
  if (value.length >= 0x80) throw new Error("TLV value too long");
  return Uint8Array.from([tag, value.length, ...value]);
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * SIGN EIP7702 AUTHORIZATION payload (app-ethereum auth_7702.c): STRUCT_VERSION (0x00) = 1,
 * DELEGATE_ADDR (0x01) = 20 bytes, CHAIN_ID (0x02) and NONCE (0x03) as minimal uint64.
 */
export function authorizationTlv({ chainId, address, nonce }) {
  return concatBytes(
    tlv(0x00, Uint8Array.of(1)),
    tlv(0x01, hexToBytes(getAddress(address))),
    tlv(0x02, u64Bytes(chainId, "chainId")),
    tlv(0x03, u64Bytes(nonce, "nonce")),
  );
}

/** Splits `data` into APDUs of at most 255 data bytes: P1 = p1First for the first, p1More after. */
export function apduChunks({ ins, p1First, p1More, p2 = 0x00, data }) {
  if (data.length === 0) throw new Error("empty APDU payload");
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const part = data.subarray(offset, offset + CHUNK_SIZE);
    chunks.push(Uint8Array.from([CLA, ins, offset === 0 ? p1First : p1More, p2, part.length, ...part]));
  }
  return chunks;
}

/** GET ADDRESS (INS 0x02); P1 0x01 shows the address on the device and waits for approval. */
export function getAddressApdu(path, display) {
  const data = packPath(path);
  return Uint8Array.from([CLA, INS.GET_ADDRESS, display ? 0x01 : 0x00, 0x00, data.length, ...data]);
}

/** SIGN EIP7702 AUTHORIZATION (INS 0x34): path ++ uint16-BE(len(tlv)) ++ tlv; P1 0x01 first chunk, 0x00 after. */
export function signAuthorizationApdus(path, authorization) {
  const body = authorizationTlv(authorization);
  const len = Uint8Array.of(body.length >> 8, body.length & 0xff);
  return apduChunks({
    ins: INS.SIGN_AUTH_7702,
    p1First: 0x01,
    p1More: 0x00,
    data: concatBytes(packPath(path), len, body),
  });
}

/** SIGN TX (INS 0x04): path ++ unsigned typed tx bytes; P1 0x00 first chunk, 0x80 after. */
export function signTxApdus(path, unsignedTx) {
  return apduChunks({ ins: INS.SIGN_TX, p1First: 0x00, p1More: 0x80, data: concatBytes(packPath(path), hexToBytes(unsignedTx)) });
}

/** GET ADDRESS response: pubkey length, pubkey, address length, ASCII hex address (no 0x). */
export function parseAddressResponse(data) {
  const pubLen = data[0];
  const addrLen = data[1 + pubLen];
  if (addrLen === undefined || data.length < 2 + pubLen + addrLen) throw new Error("malformed GET ADDRESS response");
  const ascii = new TextDecoder().decode(data.subarray(2 + pubLen, 2 + pubLen + addrLen));
  return getAddress(`0x${ascii.replace(/^0x/, "")}`);
}

/**
 * Signature response v (1) ‖ r (32) ‖ s (32). For authorizations and typed transactions the app
 * returns the y parity (0/1); 27/28 is accepted too. High s is normalized (EIP-2 / EIP-7702).
 */
export function parseSignatureResponse(data) {
  if (data.length !== 65) throw new Error(`expected a 65-byte signature, got ${data.length} bytes`);
  const v = data[0];
  let yParity;
  if (v === 0 || v === 1) yParity = v;
  else if (v === 27 || v === 28) yParity = v - 27;
  else throw new Error(`unexpected signature v = ${v}`);
  const r = bytesToHex(data.subarray(1, 33));
  let s = BigInt(bytesToHex(data.subarray(33, 65)));
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s;
    yParity ^= 1;
  }
  return { yParity, r, s: `0x${s.toString(16).padStart(64, "0")}` };
}

/** Minimal RLP integer of a 32-byte hex value: leading zero bytes dropped, zero -> "0x". */
function rlpUint(hex) {
  const stripped = hex.replace(/^0x(00)*/, "");
  return `0x${stripped}`;
}

/**
 * Signed typed transaction from its unsigned serialization and a signature: type byte ++
 * rlp([...fields, yParity, r, s]).
 */
export function assembleSignedTx(unsignedTx, { yParity, r, s }) {
  if (!isHex(unsignedTx) || unsignedTx.length < 4) throw new Error("unsigned tx must be hex");
  const type = unsignedTx.slice(0, 4);
  if (Number(type) > 0x7f) throw new Error("not a typed (EIP-2718) transaction");
  const fields = fromRlp(`0x${unsignedTx.slice(4)}`, "hex");
  if (!Array.isArray(fields)) throw new Error("unsigned tx payload is not an RLP list");
  const signed = toRlp([...fields, yParity ? "0x01" : "0x", rlpUint(r), rlpUint(s)]);
  return `${type}${signed.slice(2)}`;
}

/** EIP-1559 caps: room for the base fee to double before the tx stops being includable. */
export function feeCaps(baseFeePerGas, maxPriorityFeePerGas) {
  return { maxPriorityFeePerGas, maxFeePerGas: 2n * baseFeePerGas + maxPriorityFeePerGas };
}

export function designator(delegate) {
  return `${DESIGNATOR_PREFIX}${getAddress(delegate).slice(2).toLowerCase()}`;
}

/** Classifies an account's code: none, an EIP-7702 delegation (with its target), or contract code. */
export function describeCode(code) {
  const c = (code ?? "0x").toLowerCase();
  if (c === "0x") return { kind: "none" };
  if (c.length === 2 + 46 && c.startsWith(DESIGNATOR_PREFIX)) return { kind: "delegated", target: getAddress(`0x${c.slice(8)}`) };
  return { kind: "other" };
}

const OPEN_APP = 'open the "Covenant 7702" app (built and sideloaded with ledger/build-app.sh) on the unlocked device';

/** Actionable message for a Ledger status word; `op` is "address", "authorization", "revocation" or "transaction". */
export function swMessage(sw, op) {
  const hex = `0x${sw.toString(16).padStart(4, "0")}`;
  switch (sw) {
    case 0x6985:
      return `rejected on the device (${hex})`;
    case 0x6980:
    case 0x6986:
      if (op === "authorization") {
        return `the device refused the authorization (${hex}). Either the "EIP-7702" setting is off (app Settings -> enable EIP-7702), or the open app does not whitelist this delegate: ${OPEN_APP}; rebuild it if delegate.json's address changed. The device screen says which.`;
      }
      if (op === "revocation") return `the device refused the revocation (${hex}): enable the "EIP-7702" setting in the app's Settings.`;
      return `command not allowed (${hex}): another signing flow is active on the device; go back to the app's home screen and retry.`;
    case 0x6a80:
      if (op === "transaction") {
        return `the device refused the transaction data (${hex}): enable "Blind signing" in the app's Settings (the transaction calls initialize() on your own address).`;
      }
      return `the device rejected the request data (${hex})`;
    case 0x6d00:
    case 0x6e00:
    case 0x6e01:
    case 0x6511:
    case 0x6a15:
      return `wrong or no app open (${hex}): ${OPEN_APP}.`;
    case 0x5515:
    case 0x6b0c:
      return `the device is locked (${hex}): unlock it and ${OPEN_APP}.`;
    default:
      return `Ledger error ${hex}`;
  }
}

/** argv (after `node script`) -> { cmd, opts }. */
export function parseArgs(argv) {
  const opts = { path: DEFAULT_PATH, signer: "ledger", yes: false, dryRun: false, hotKey: false, rpc: undefined, gas: undefined };
  let cmd;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--rpc":
        opts.rpc = value();
        break;
      case "--path":
        opts.path = value();
        parsePath(opts.path);
        break;
      case "--signer":
        opts.signer = value();
        if (opts.signer !== "ledger" && !/^key:(0x)?[0-9a-fA-F]{64}$/.test(opts.signer)) {
          throw new Error("--signer must be ledger or key:<32-byte hex private key>");
        }
        break;
      case "--gas": {
        const v = value();
        if (!/^\d+$/.test(v) || BigInt(v) < 21000n) throw new Error("--gas must be an integer >= 21000");
        opts.gas = BigInt(v);
        break;
      }
      case "--yes":
        opts.yes = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--i-know-this-is-a-hot-key":
        opts.hotKey = true;
        break;
      case "--help":
      case "-h":
        cmd = "help";
        break;
      default:
        if (arg.startsWith("-") || cmd !== undefined) throw new Error(`unexpected argument "${arg}"`);
        cmd = arg;
    }
  }
  return { cmd, opts };
}
