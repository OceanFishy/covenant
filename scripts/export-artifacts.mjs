#!/usr/bin/env node
// Copies the compiled Executor (ABI, bytecode, immutable positions) and the verified registry
// into the app. Run after `pnpm build`: `pnpm sync`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const artifact = JSON.parse(
  readFileSync("artifacts/contracts/CovenantExecutorMainnet.sol/CovenantExecutorMainnet.json", "utf8"),
);
const out = "app/src/generated";
mkdirSync(out, { recursive: true });
// ABI is needed on every page; bytecode only for deploy + verification, so it is split out and
// loaded lazily (keeps the initial bundle small).
writeFileSync(`${out}/executor-abi.json`, JSON.stringify({ contractName: artifact.contractName, abi: artifact.abi }, null, 2) + "\n");
writeFileSync(
  `${out}/executor-bytecode.json`,
  JSON.stringify(
    {
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
      immutableReferences: artifact.immutableReferences,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(`${out}/registry.json`, readFileSync("registry/mainnet.json", "utf8"));
console.log(`wrote ${out}/executor-abi.json, executor-bytecode.json and registry.json`);
