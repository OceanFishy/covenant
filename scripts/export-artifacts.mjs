#!/usr/bin/env node
// Copies the compiled Executor and EIP-7702 delegate (ABI, bytecode, immutable positions) and
// the verified registry into the app. Run after `pnpm build`: `pnpm sync`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getContractAddress } from "viem";

const read = (name) => JSON.parse(readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, "utf8"));
const write = (file, value) => writeFileSync(`${out}/${file}`, JSON.stringify(value, null, 2) + "\n");
const out = "app/src/generated";
mkdirSync(out, { recursive: true });

// ABI is needed on every page; bytecode only for deploy + verification, so it is split out and
// loaded lazily (keeps the initial bundle small).
const executor = read("CovenantExecutorMainnet");
write("executor-abi.json", { contractName: executor.contractName, abi: executor.abi });
write("executor-bytecode.json", {
  bytecode: executor.bytecode,
  deployedBytecode: executor.deployedBytecode,
  immutableReferences: executor.immutableReferences,
});

// The delegate is one shared deployment through the deterministic deployment proxy (on mainnet
// at the address below), so its address follows from the bytecode. That address is what the
// Ledger app build whitelists and what EOAs delegate to.
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = `0x${"00".repeat(32)}`;
const delegate = read("CovenantDelegateMainnet");
const address = getContractAddress({ opcode: "CREATE2", from: FACTORY, salt: SALT, bytecode: delegate.bytecode });
write("delegate.json", { contractName: delegate.contractName, abi: delegate.abi, address, factory: FACTORY, salt: SALT });
write("delegate-bytecode.json", {
  bytecode: delegate.bytecode,
  deployedBytecode: delegate.deployedBytecode,
  immutableReferences: delegate.immutableReferences,
});

writeFileSync(`${out}/registry.json`, readFileSync("registry/mainnet.json", "utf8"));
console.log(`wrote ${out}: executor-abi, executor-bytecode, delegate (${address}), delegate-bytecode, registry`);
