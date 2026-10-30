import type { Address, PublicClient } from "viem";
import { aavePoolAbi, aaveV4SpokeAbi, erc20Abi } from "./abis";
import { AAVE_POOL, AAVE_RESERVES, AAVE_V4, AAVE_V4_RESERVES, type AaveReserve, type AaveV4Reserve } from "./registry";

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

export type AaveV4ReserveView = {
  reserve: AaveV4Reserve;
  supplied: bigint;
  /** Drawn + premium debt, in the asset's units. */
  debt: bigint;
  usingAsCollateral: boolean;
  /** Frozen reserves accept repay and withdraw only; supply and borrow revert. */
  frozen: boolean;
};

/** `health` is WAD; maxUint256 without debt. */
export type AaveV4Account = { reserves: AaveV4ReserveView[]; health: bigint };

/** The owner's Aave v4 Main Spoke position in the supported reserves (one Multicall3 batch). */
export async function readAaveV4(client: PublicClient, owner: Address): Promise<AaveV4Account> {
  const spoke = AAVE_V4.spoke;
  const [account, ...rest] = await Promise.all([
    client.readContract({ address: spoke, abi: aaveV4SpokeAbi, functionName: "getUserAccountData", args: [owner] }),
    ...AAVE_V4_RESERVES.map((r) =>
      Promise.all([
        client.readContract({ address: spoke, abi: aaveV4SpokeAbi, functionName: "getUserSuppliedAssets", args: [r.reserveId, owner] }),
        client.readContract({ address: spoke, abi: aaveV4SpokeAbi, functionName: "getUserTotalDebt", args: [r.reserveId, owner] }),
        client.readContract({ address: spoke, abi: aaveV4SpokeAbi, functionName: "getUserReserveStatus", args: [r.reserveId, owner] }),
        client.readContract({ address: spoke, abi: aaveV4SpokeAbi, functionName: "getReserveConfig", args: [r.reserveId] }),
      ]),
    ),
  ]);
  return {
    health: account[2], // UserAccountData.healthFactor
    reserves: AAVE_V4_RESERVES.map((reserve, i) => {
      const [supplied, debt, [usingAsCollateral], config] = rest[i];
      return { reserve, supplied, debt, usingAsCollateral, frozen: config.frozen };
    }),
  };
}
