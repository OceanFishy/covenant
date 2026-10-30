import { parseAbi, type Abi, type Address, type Hex } from "viem";
import delegate from "../generated/delegate.json";
import executor from "../generated/executor-abi.json";

export const executorAbi = executor.abi as Abi;

/** The EIP-7702 delegate (CovenantDelegateMainnet): shared deployment, address from CREATE2. */
export const delegateAbi = delegate.abi as Abi;
export const DELEGATE: Address = delegate.address as Address;
export const DELEGATE_FACTORY: Address = delegate.factory as Address;
export const DELEGATE_SALT: Hex = delegate.salt as Hex;

export type ExecutorBytecode = {
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
};

/** Bytecode is only needed to deploy or verify an Executor, so it loads on demand. */
export async function loadExecutorBytecode(): Promise<ExecutorBytecode> {
  return (await import("../generated/executor-bytecode.json")).default as ExecutorBytecode;
}

/** Same for the delegate (deploying it once, verifying the code your EOA delegates to). */
export async function loadDelegateBytecode(): Promise<ExecutorBytecode> {
  return (await import("../generated/delegate-bytecode.json")).default as ExecutorBytecode;
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);

const marketParams = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
const market =
  "(uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)";

export const morphoAbi = parseAbi([
  `struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }`,
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  `function market(bytes32 id) view returns ${market}`,
  "function isAuthorized(address authorizer, address authorized) view returns (bool)",
  "function setAuthorization(address authorized, bool newIsAuthorized)",
  "function accrueInterest(MarketParams marketParams)",
  "function flashLoan(address token, uint256 assets, bytes data)",
  "function repay(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function withdrawCollateral(MarketParams marketParams, uint256 assets, address onBehalf, address receiver)",
  "function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
]);

export const irmAbi = parseAbi([
  `function borrowRateView(${marketParams} marketParams, ${market} market) view returns (uint256)`,
]);

export const oracleAbi = parseAbi(["function price() view returns (uint256)"]);

export const ytAbi = parseAbi([
  "function mintPY(address receiverPT, address receiverYT) returns (uint256)",
  "function redeemPY(address receiver) returns (uint256)",
  "function pyIndexStored() view returns (uint256)",
  "function isExpired() view returns (bool)",
]);

export const syAbi = parseAbi([
  "function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut) payable returns (uint256)",
  "function redeem(address receiver, uint256 amountSharesToRedeem, address tokenOut, uint256 minTokenOut, bool burnFromInternalBalance) returns (uint256)",
  "function previewRedeem(address tokenOut, uint256 amountSharesToRedeem) view returns (uint256)",
  "function previewDeposit(address tokenIn, uint256 amountTokenToDeposit) view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
]);

export const usd3Abi = parseAbi([
  "function maxDeposit(address) view returns (uint256)",
  "function availableWithdrawLimit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
]);

/** Re Protocol redemption (verified source on Etherscan); read-only views. */
export const reGatewayAbi = parseAbi([
  "function instantRedemption() view returns (address)",
  "function currentMode() view returns (uint8)",
]);

export const reInstantRedemptionAbi = parseAbi([
  "function feeBps() view returns (uint16)",
  "function maxRedemption() view returns (uint256)",
  "function redemptionPriceRouter() view returns (address)",
  "function payoutTokenRegistry() view returns (address)",
]);

export const rePriceRouterAbi = parseAbi(["function getPrice(address token) view returns (uint256)"]);

export const rePayoutRegistryAbi = parseAbi(["function activePayoutToken() view returns (address)"]);

export const aavePoolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getConfiguration(address asset) view returns ((uint256 data))",
]);

export const aaveDebtTokenAbi = parseAbi([
  "function approveDelegation(address delegatee, uint256 amount)",
  "function borrowAllowance(address fromUser, address toUser) view returns (uint256)",
]);

/** Aave v3 Pool custom errors a plan is likely to hit, for readable simulation failures. */
export const aaveErrorsAbi = parseAbi([
  "error ReserveFrozen()",
  "error ReservePaused()",
  "error ReserveInactive()",
  "error InvalidAmount()",
  "error BorrowingNotEnabled()",
  "error NotEnoughAvailableUserBalance()",
  "error HealthFactorLowerThanLiquidationThreshold()",
  "error CollateralCannotCoverNewBorrow()",
  "error NoDebtOfSelectedType()",
  "error NoExplicitAmountToRepayOnBehalf()",
  "error UnderlyingBalanceZero()",
  "error BorrowCapExceeded()",
  "error SupplyCapExceeded()",
  "error LtvValidationFailed()",
  "error UserHasAssetWithZeroLtv()",
  "error InsufficientBorrowAllowance(address delegatee, uint256 allowance, uint256 amount)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);
