import { describe, expect, it } from "vitest";
import { bytesToHex, encodeFunctionData, hexToBytes, keccak256, parseAbi, parseSignature, recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerializableEIP7702 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  apduChunks,
  assembleSignedTx,
  authorizationTlv,
  describeCode,
  designator,
  feeCaps,
  getAddressApdu,
  packPath,
  parseAddressResponse,
  parseArgs,
  parsePath,
  parseSignatureResponse,
  signAuthorizationApdus,
  signTxApdus,
  swMessage,
} from "../../scripts/ledger7702-lib.mjs";

const hex = (b: Uint8Array) => bytesToHex(b).slice(2);
const SIMPLE_7702 = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
// m/44'/60'/0'/0/0: 5 components, 44|0x80000000, 60|0x80000000, 0|0x80000000, 0, 0.
const DEFAULT_PATH_HEX = "05" + "8000002c" + "8000003c" + "80000000" + "00000000" + "00000000";
// anvil / hardhat account #1 (well known, test only)
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("BIP32 path", () => {
  it("packs the default Ethereum path", () => {
    expect(hex(packPath("m/44'/60'/0'/0/0"))).toBe(DEFAULT_PATH_HEX);
    expect(hex(packPath("44h/60H/1'/0/7"))).toBe("05" + "8000002c" + "8000003c" + "80000001" + "00000000" + "00000007");
  });

  it("rejects malformed paths", () => {
    expect(() => parsePath("m/44'/x")).toThrow();
    expect(() => parsePath("m/")).toThrow();
    expect(() => parsePath("m/2147483648")).toThrow();
    expect(() => parsePath("m/" + Array(11).fill("0").join("/"))).toThrow();
  });
});

describe("EIP-7702 authorization TLV", () => {
  it("encodes version, delegate, chain id and nonce (hand-computed)", () => {
    // 00 01 01 | 01 14 <20-byte delegate> | 02 01 01 | 03 01 05
    expect(hex(authorizationTlv({ chainId: 1, address: SIMPLE_7702, nonce: 5 }))).toBe(
      "000101" + "0114" + "4cd241e8d1510e30b2076397afc7508ae59c66c9" + "020101" + "030105",
    );
  });

  it("uses minimal big-endian integers, at least one byte", () => {
    const tlv = hex(authorizationTlv({ chainId: 0x1_0000n, address: SIMPLE_7702, nonce: 0 }));
    expect(tlv.endsWith("0203010000" + "030100")).toBe(true);
    const big = hex(authorizationTlv({ chainId: 1, address: SIMPLE_7702, nonce: 0xffffffffffffffffn }));
    expect(big.endsWith("0308ffffffffffffffff")).toBe(true);
    expect(() => authorizationTlv({ chainId: 1, address: SIMPLE_7702, nonce: 1n << 64n })).toThrow();
  });

  it("wraps it as SIGN EIP7702 AUTHORIZATION: path ++ uint16 length ++ TLV, P1 0x01", () => {
    const chunks = signAuthorizationApdus("m/44'/60'/0'/0/0", { chainId: 1, address: SIMPLE_7702, nonce: 5 });
    expect(chunks).toHaveLength(1);
    // CLA E0, INS 34, P1 01, P2 00, Lc = 21 (path) + 2 + 31 (TLV) = 54 = 0x36
    expect(hex(chunks[0])).toBe(
      "e0340100" + "36" + DEFAULT_PATH_HEX + "001f" + "000101" + "0114" + "4cd241e8d1510e30b2076397afc7508ae59c66c9" + "020101" + "030105",
    );
  });
});

describe("APDU chunking", () => {
  it("GET ADDRESS with and without display", () => {
    expect(hex(getAddressApdu("m/44'/60'/0'/0/0", false))).toBe("e0020000" + "15" + DEFAULT_PATH_HEX);
    expect(hex(getAddressApdu("m/44'/60'/0'/0/0", true))).toBe("e0020100" + "15" + DEFAULT_PATH_HEX);
  });

  it("splits at 255 bytes with first/following P1", () => {
    const data = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
    const chunks = apduChunks({ ins: 0x34, p1First: 0x01, p1More: 0x00, data });
    expect(chunks.map((c) => c.length - 5)).toEqual([255, 255, 90]);
    expect(chunks.map((c) => [...c.subarray(0, 5)])).toEqual([
      [0xe0, 0x34, 0x01, 0x00, 255],
      [0xe0, 0x34, 0x00, 0x00, 255],
      [0xe0, 0x34, 0x00, 0x00, 90],
    ]);
    expect(hex(Uint8Array.from(chunks.flatMap((c) => [...c.subarray(5)])))).toBe(hex(data));
  });

  it("SIGN TX: path only in the first chunk, P1 0x00 then 0x80, P2 0x00", () => {
    const tx = `0x04${"ab".repeat(400)}` as Hex;
    const chunks = signTxApdus("m/44'/60'/0'/0/0", tx);
    expect(chunks.map((c) => hex(c.subarray(0, 4)))).toEqual(["e0040000", "e0048000"]);
    expect(chunks.map((c) => c[4])).toEqual([255, 21 + 401 - 255]);
    expect(hex(chunks[0].subarray(5, 26))).toBe(DEFAULT_PATH_HEX);
    expect(chunks[0][26]).toBe(0x04);
    // the following chunk carries tx bytes only
    expect(hex(chunks[1].subarray(5))).toBe("ab".repeat(21 + 401 - 255));
  });
});

describe("responses", () => {
  it("parses GET ADDRESS", () => {
    const pub = new Uint8Array(65).fill(4);
    const ascii = new TextEncoder().encode("70997970c51812dc3a010c7d01b50e0d17dc79c8");
    const resp = Uint8Array.from([65, ...pub, 40, ...ascii]);
    expect(parseAddressResponse(resp)).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("parses v/r/s, accepting 27/28 and normalizing high s", () => {
    const r = "11".repeat(32);
    const s = "22".repeat(32);
    expect(parseSignatureResponse(hexToBytes(`0x01${r}${s}`))).toEqual({ yParity: 1, r: `0x${r}`, s: `0x${s}` });
    expect(parseSignatureResponse(hexToBytes(`0x1b${r}${s}`)).yParity).toBe(0);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = (n - BigInt(`0x${s}`)).toString(16);
    expect(parseSignatureResponse(hexToBytes(`0x00${r}${high}`))).toEqual({ yParity: 1, r: `0x${r}`, s: `0x${s}` });
    expect(() => parseSignatureResponse(hexToBytes(`0x05${r}${s}`))).toThrow();
  });

  it("maps status words to actions", () => {
    expect(swMessage(0x6985, "transaction")).toMatch(/rejected on the device/);
    expect(swMessage(0x6986, "authorization")).toMatch(/EIP-7702.*Covenant 7702/s);
    expect(swMessage(0x6980, "authorization")).toMatch(/whitelist/);
    expect(swMessage(0x6a80, "transaction")).toMatch(/Blind signing/);
    expect(swMessage(0x6e00, "address")).toMatch(/Covenant 7702/);
    expect(swMessage(0x6d00, "address")).toMatch(/wrong or no app/);
  });
});

describe("signed type-4 transaction", () => {
  const account = privateKeyToAccount(KEY);
  const initialize = encodeFunctionData({ abi: parseAbi(["function initialize()"]), functionName: "initialize" });
  const tx: TransactionSerializableEIP7702 = {
    type: "eip7702",
    chainId: 1,
    nonce: 7,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 30_000_000_000n,
    gas: 3_000_000n,
    to: account.address,
    value: 0n,
    data: initialize,
    accessList: [],
    authorizationList: [
      {
        address: "0xf29AC9B5d96f421ED0c8d488B6fF645D458779c7",
        chainId: 1,
        nonce: 8,
        r: "0x00aa000000000000000000000000000000000000000000000000000000000001",
        s: "0x0000000000000000000000000000000000000000000000000000000000000002",
        yParity: 1,
      },
    ],
  };

  it("assembles (unsigned tx, v/r/s) exactly like viem serializeTransaction", async () => {
    const unsigned = serializeTransaction(tx);
    expect(unsigned.startsWith("0x04")).toBe(true);
    const sig = parseSignature(await account.sign({ hash: keccak256(unsigned) }));
    const device = hexToBytes(`0x${(sig.yParity ?? 0).toString(16).padStart(2, "0")}${sig.r.slice(2)}${sig.s.slice(2)}`);
    const assembled = assembleSignedTx(unsigned, parseSignatureResponse(device));
    expect(assembled).toBe(serializeTransaction(tx, sig));
    expect(assembled).toBe(await account.signTransaction(tx));
    expect(await recoverTransactionAddress({ serializedTransaction: assembled })).toBe(account.address);
  });

  it("strips leading zero bytes of r and s and encodes yParity 0 as empty", () => {
    const unsigned = serializeTransaction(tx);
    const sig = { yParity: 0, r: `0x0000${"33".repeat(30)}` as Hex, s: `0x00${"44".repeat(31)}` as Hex };
    expect(assembleSignedTx(unsigned, sig)).toBe(serializeTransaction(tx, sig));
  });
});

describe("misc", () => {
  it("fee caps, designator and code classification", () => {
    expect(feeCaps(10n, 2n)).toEqual({ maxPriorityFeePerGas: 2n, maxFeePerGas: 22n });
    const d = "0xf29AC9B5d96f421ED0c8d488B6fF645D458779c7";
    expect(designator(d)).toBe("0xef0100f29ac9b5d96f421ed0c8d488b6ff645d458779c7");
    expect(describeCode(undefined)).toEqual({ kind: "none" });
    expect(describeCode("0x")).toEqual({ kind: "none" });
    expect(describeCode(designator(d))).toEqual({ kind: "delegated", target: d });
    expect(describeCode("0x6080604052")).toEqual({ kind: "other" });
  });

  it("parses CLI arguments", () => {
    const { cmd, opts } = parseArgs(["delegate", "--rpc", "http://x", "--gas", "500000", "--yes", "--dry-run", "--path", "m/44'/60'/1'/0/0"]);
    expect(cmd).toBe("delegate");
    expect(opts).toMatchObject({ rpc: "http://x", gas: 500000n, yes: true, dryRun: true, path: "m/44'/60'/1'/0/0", signer: "ledger" });
    expect(() => parseArgs(["delegate", "--signer", "key:zz"])).toThrow();
    expect(() => parseArgs(["delegate", "--bogus"])).toThrow();
    expect(() => parseArgs(["delegate", "revoke"])).toThrow();
  });
});
