import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { erc20Abi, morphoAbi } from "./abis";
import { APPROVAL_TOKENS, MORPHO, tokenInfo } from "./registry";

/**
 * Executor access (docs/SPEC.md §9.3): everything that lets an Executor act for you.
 * Revokes are sent straight from your wallet to Morpho / the token, never via the Executor.
 */
export type Permission = {
  executor: Address;
  kind: "morpho" | "allowance";
  label: string;
  /** Token for allowances. */
  token?: Address;
  amount?: bigint;
  revoke: { to: Address; data: Hex };
  /** Shown for the no-Covenant fallback (Etherscan "Write contract"). */
  manual: string;
};

export async function readAccess(client: PublicClient, owner: Address, executors: Address[]): Promise<Permission[]> {
  const out: Permission[] = [];
  for (const executor of executors) {
    const [authorized, ...allowances] = await Promise.all([
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [owner, executor] }),
      ...APPROVAL_TOKENS.map((t) =>
        client.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [owner, executor] }),
      ),
    ]);
    if (authorized) {
      out.push({
        executor,
        kind: "morpho",
        label: "Morpho Blue: can withdraw collateral and borrow for you",
        revoke: {
          to: MORPHO,
          data: encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [executor, false] }),
        },
        manual: `Morpho Blue ${MORPHO} → setAuthorization(${executor}, false)`,
      });
    }
    APPROVAL_TOKENS.forEach((token, i) => {
      const amount = allowances[i] as bigint;
      if (amount === 0n) return;
      const { symbol } = tokenInfo(token);
      out.push({
        executor,
        kind: "allowance",
        label: `${symbol}: can be pulled from your wallet`,
        token,
        amount,
        revoke: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [executor, 0n] }) },
        manual: `${symbol} ${token} → approve(${executor}, 0)`,
      });
    });
  }
  return out;
}
