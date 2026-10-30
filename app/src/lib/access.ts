import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { aaveDebtTokenAbi, aaveV4TakerAbi, erc20Abi, morphoAbi } from "./abis";
import { AAVE_RESERVES, AAVE_V4, AAVE_V4_RESERVES, APPROVAL_TOKENS, MORPHO, tokenInfo } from "./registry";

/**
 * Executor access (docs/SPEC.md §9.3): everything that lets an Executor act for you.
 * Revokes are sent straight from your wallet to Morpho / the Aave debt token / the Aave v4 Taker /
 * the token, never via the Executor.
 */
export type Permission = {
  executor: Address;
  kind: "morpho" | "aaveDelegation" | "aaveV4Borrow" | "aaveV4Withdraw" | "allowance";
  label: string;
  /** Token for allowances; the variable debt token for Aave credit delegation; the asset for v4. */
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
      ...AAVE_V4_RESERVES.flatMap((r) =>
        (["borrowAllowance", "withdrawAllowance"] as const).map((functionName) =>
          client.readContract({ address: AAVE_V4.taker, abi: aaveV4TakerAbi, functionName, args: [AAVE_V4.spoke, r.reserveId, owner, executor] }),
        ),
      ),
    ]);
    const allowances = rest.slice(0, APPROVAL_TOKENS.length) as bigint[];
    const delegations = rest.slice(APPROVAL_TOKENS.length, APPROVAL_TOKENS.length + AAVE_RESERVES.length) as bigint[];
    const v4 = rest.slice(APPROVAL_TOKENS.length + AAVE_RESERVES.length) as bigint[];
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
    AAVE_V4_RESERVES.forEach((r, i) => {
      (["Borrow", "Withdraw"] as const).forEach((kind, j) => {
        const amount = v4[2 * i + j];
        if (amount === 0n) return;
        out.push({
          executor,
          kind: kind === "Borrow" ? "aaveV4Borrow" : "aaveV4Withdraw",
          label: kind === "Borrow" ? `Aave v4 ${r.symbol}: can borrow for you` : `Aave v4 ${r.symbol}: can withdraw your supply`,
          token: r.asset,
          amount,
          revoke: {
            to: AAVE_V4.taker,
            data: encodeFunctionData({ abi: aaveV4TakerAbi, functionName: `approve${kind}`, args: [AAVE_V4.spoke, r.reserveId, executor, 0n] }),
          },
          manual: `Aave v4 Taker ${AAVE_V4.taker} → approve${kind}(${AAVE_V4.spoke}, ${r.reserveId}, ${executor}, 0)`,
        });
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
