import type { Address, Hex, TransactionSerialized } from "viem";

export declare const DEFAULT_PATH: string;
export declare const CLA: number;
export declare const INS: { GET_ADDRESS: number; SIGN_TX: number; SIGN_AUTH_7702: number };
export declare const CHUNK_SIZE: number;
export declare const DESIGNATOR_PREFIX: Hex;

export type AuthorizationFields = { chainId: number | bigint; address: Address; nonce: number | bigint };
export type YParitySignature = { yParity: number; r: Hex; s: Hex };
export type Opts = {
  path: string;
  signer: string;
  yes: boolean;
  dryRun: boolean;
  hotKey: boolean;
  rpc: string | undefined;
  gas: bigint | undefined;
};

export declare function parsePath(path: string): number[];
export declare function packPath(path: string): Uint8Array;
export declare function authorizationTlv(auth: AuthorizationFields): Uint8Array;
export declare function apduChunks(args: { ins: number; p1First: number; p1More: number; p2?: number; data: Uint8Array }): Uint8Array[];
export declare function getAddressApdu(path: string, display: boolean): Uint8Array;
export declare function signAuthorizationApdus(path: string, auth: AuthorizationFields): Uint8Array[];
export declare function signTxApdus(path: string, unsignedTx: Hex): Uint8Array[];
export declare function parseAddressResponse(data: Uint8Array): Address;
export declare function parseSignatureResponse(data: Uint8Array): YParitySignature;
export declare function assembleSignedTx(unsignedTx: Hex, signature: YParitySignature): TransactionSerialized;
export declare function feeCaps(baseFeePerGas: bigint, maxPriorityFeePerGas: bigint): { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint };
export declare function designator(delegate: Address): Hex;
export declare function describeCode(code: Hex | undefined): { kind: "none" } | { kind: "other" } | { kind: "delegated"; target: Address };
export declare function swMessage(sw: number, op: "address" | "authorization" | "revocation" | "transaction"): string;
export declare function parseArgs(argv: string[]): { cmd: string | undefined; opts: Opts };
