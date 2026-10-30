import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { aaveDebtTokenAbi, erc20Abi, morphoAbi } from "./abis";
import { AAVE_RESERVES, APPROVAL_TOKENS, MORPHO, tokenInfo } from "./registry";

/**
 * Executor access (docs/SPEC.md §9.3): everything that lets an Executor act for you.
 * Revokes are sent straight from your wallet to Morpho / the Aave debt token / the token, never
 * via the Executor.
 */
export type Permission = {
  executor: Address;
  kind: "morpho" | "aaveDelegation" | "allowance";
  label: string;
  /** Token for allowances; the variable debt token for Aave credit delegation. */
  token?: Address;
  amount?: bigint;
  revoke: { to: Address; data: Hex };
  /** Shown for the no-Covenant fallback (Etherscan "Write contract"). */
  manual: string;
};

export async function readAccess(client: PublicClient, owner: Address, executors: Address[]): Promise<Permission[]> {
  const out: Permission[] = [];
  for (const executor of executors) {
    const [authorized, ...rest] = await Promise.all([
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [owner, executor] }),
      ...APPROVAL_TOKENS.map((t) =>
        client.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [owner, executor] }),
      ),
      ...AAVE_RESERVES.map((r) =>
        client.readContract({ address: r.debtToken.address, abi: aaveDebtTokenAbi, functionName: "borrowAllowance", args: [owner, executor] }),
      ),
    ]);
    const allowances = rest.slice(0, APPROVAL_TOKENS.length) as bigint[];
    const delegations = rest.slice(APPROVAL_TOKENS.length) as bigint[];
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
    AAVE_RESERVES.forEach((r, i) => {
      const amount = delegations[i];
      if (amount === 0n) return;
      const debt = r.debtToken.address;
      out.push({
        executor,
        kind: "aaveDelegation",
        label: `Aave ${r.symbol}: can borrow for you (credit delegation)`,
        token: debt,
        amount,
        revoke: { to: debt, data: encodeFunctionData({ abi: aaveDebtTokenAbi, functionName: "approveDelegation", args: [executor, 0n] }) },
        manual: `${r.debtToken.symbol} ${debt} → approveDelegation(${executor}, 0)`,
      });
    });
    APPROVAL_TOKENS.forEach((token, i) => {
      const amount = allowances[i];
      if (amount === 0n) return;
      const { symbol } = tokenInfo(token);
      const isAToken = AAVE_RESERVES.some((r) => r.aToken.address === token);
      out.push({
        executor,
        kind: "allowance",
        label: isAToken ? `${symbol}: your Aave supply can be pulled and withdrawn` : `${symbol}: can be pulled from your wallet`,
        token,
        amount,
        revoke: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [executor, 0n] }) },
        manual: `${symbol} ${token} → approve(${executor}, 0)`,
      });
    });
  }
  return out;
}
