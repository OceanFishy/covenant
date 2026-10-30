import type { Address, PublicClient } from "viem";
import { aavePoolAbi, erc20Abi } from "./abis";
import { AAVE_POOL, AAVE_RESERVES, type AaveReserve } from "./registry";

/** Aave ReserveConfigurationMap bits (aave-v3-origin ReserveConfiguration.sol). */
const LTV_MASK = 0xffffn;
const FROZEN_BIT = 1n << 57n;

export type AaveReserveView = {
  reserve: AaveReserve;
  /** The owner's aToken balance (supply incl. interest) and variable debt, in the asset's units. */
  supplied: bigint;
  debt: bigint;
  /** Frozen reserves accept repay and withdraw only; supply and borrow revert. */
  frozen: boolean;
  /** Loan-to-value in bps (0 = can't back new borrows). */
  ltvBps: number;
};

export type AaveAccount = {
  reserves: AaveReserveView[];
  /** WAD; maxUint256 when there is no debt. */
  health: bigint;
  /** Aave's base currency (USD, 8 decimals). */
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
};

/** The owner's Aave v3 Core position in the supported reserves (one Multicall3 batch). */
export async function readAave(client: PublicClient, owner: Address): Promise<AaveAccount> {
  const [account, ...rest] = await Promise.all([
    client.readContract({ address: AAVE_POOL, abi: aavePoolAbi, functionName: "getUserAccountData", args: [owner] }),
    ...AAVE_RESERVES.flatMap((r) => [
      ...[r.aToken.address, r.debtToken.address].map((token) =>
        client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      ),
      client.readContract({ address: AAVE_POOL, abi: aavePoolAbi, functionName: "getConfiguration", args: [r.asset] }).then((c) => c.data),
    ]),
  ]);
  const [totalCollateralBase, totalDebtBase, , , , health] = account;
  return {
    reserves: AAVE_RESERVES.map((reserve, i) => {
      const [supplied, debt, config] = rest.slice(3 * i, 3 * i + 3) as bigint[];
      return { reserve, supplied, debt, frozen: (config & FROZEN_BIT) !== 0n, ltvBps: Number(config & LTV_MASK) };
    }),
    health,
    totalCollateralBase,
    totalDebtBase,
  };
}
