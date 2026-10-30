// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantCore} from "../CovenantCore.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {IMorpho} from "../interfaces/IMorpho.sol";
import {IAavePool} from "../interfaces/IAave.sol";
import {IPYieldToken, IStandardizedYield} from "../interfaces/IPendle.sol";

/// @notice Ethereum mainnet addresses and the Executor allowlist built from them.
/// Every address here was verified on-chain (see registry/mainnet.json for how).
/// Keep this file and registry/mainnet.json in sync.
library MainnetConfig {
    // Tokens
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant USD3 = 0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc; // 3Jane senior tranche (Yearn V3 strategy)
    address internal constant REUSD = 0x5086bf358635B81D8C47C66d1C8b9E567Db70c72;

    // Morpho Blue
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    // Aave v3 Core market (Ethereum). Only USDC and USDT are approved to the Pool, so only they
    // can be supplied or repaid; borrowing needs the owner's credit delegation on the debt token,
    // and withdrawing needs the owner's aToken approval to the Executor (pulled, then withdrawn).
    address internal constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant A_USDC = 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c; // aEthUSDC
    address internal constant A_USDT = 0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a; // aEthUSDT
    address internal constant VDEBT_USDC = 0x72E95b8931767C79bA4EeE721354d6E99a61D004; // variableDebtEthUSDC
    address internal constant VDEBT_USDT = 0x6df1C1E379bC5a00a7b4C6e67A203333772f45A8; // variableDebtEthUSDT

    // DEX aggregators: USDC <-> USDT (USDT-debt loops) and reUSD <-> USDC (reUSD loops; Re's own
    // mint/redeem is KYC-gated). Only USDC, USDT and reUSD may be approved to them, never Pendle
    // assets (PT/YT/SY). The swap's output is checked by an Executor guard (assertMinBalance),
    // independent of the route data.
    address internal constant ZEROX_ALLOWANCE_HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734; // 0x Swap API v2
    address internal constant KYBER_ROUTER = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5; // MetaAggregationRouterV2

    // Pendle PT-USD3-17DEC2026
    address internal constant PT_USD3 = 0x7f47c3e6b2c00fC4eB4d5Ae50d0Ab0Ab6888Eb4D;
    address internal constant YT_USD3 = 0x5cFfCc9DdEF0fDcf395e2eA24CA5ED5A12032706;
    address internal constant SY_USD3 = 0xeA3BC608F32847B97965C5e1648BDFCd4C2C40d0;

    // Pendle PT-reUSD-10DEC2026
    address internal constant PT_REUSD = 0xeCfaFdC7741323a945A163ed068B5a3C43483957;
    address internal constant YT_REUSD = 0xA8bD3B21291AcE53927b35563fc80615919E63D7;
    address internal constant SY_REUSD = 0x9487Bd5A3b16Ecb5F3184453E3ee75B800141648;

    // Morpho markets
    bytes32 internal constant MKT_PT_USD3_USDC_A = 0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89; // LLTV 86%
    bytes32 internal constant MKT_PT_USD3_USDC_B = 0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837; // LLTV 86%
    bytes32 internal constant MKT_PT_USD3_USDT = 0x37a584c981f6f59f7532ae5565732ee54647773d425978eb94d4cd29c21ff53b; // LLTV 91.5%
    bytes32 internal constant MKT_PT_REUSD_USDC = 0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64; // LLTV 91.5%

    /// Rule bit requiring argument word `i` to be the owner or the Executor.
    function w(uint256 i) internal pure returns (uint256) {
        return 1 << (i + 1);
    }

    function rules() internal pure returns (CovenantCore.RuleInit[] memory r) {
        uint256 ALLOWED = 1;
        uint256 RECIPIENT = 1 << 255;
        address[10] memory tokens = [USDC, USDT, USD3, REUSD, PT_USD3, YT_USD3, SY_USD3, PT_REUSD, YT_REUSD, SY_REUSD];

        r = new CovenantCore.RuleInit[](6 + tokens.length * 3 + 4 * 2 + 3 + 2 + 4 + 2 * 2);
        uint256 n;

        // Morpho Blue. MarketParams is 5 static words (0..4), so arguments start at word 5.
        r[n++] = _r(MORPHO, IMorpho.accrueInterest.selector, ALLOWED);
        r[n++] = _r(MORPHO, IMorpho.flashLoan.selector, ALLOWED);
        // repay(params, assets, shares, onBehalf, data)
        r[n++] = _r(MORPHO, IMorpho.repay.selector, ALLOWED | w(7));
        // withdrawCollateral(params, assets, onBehalf, receiver)
        r[n++] = _r(MORPHO, IMorpho.withdrawCollateral.selector, ALLOWED | w(6) | w(7));
        // supplyCollateral(params, assets, onBehalf, data)
        r[n++] = _r(MORPHO, IMorpho.supplyCollateral.selector, ALLOWED | w(6));
        // borrow(params, assets, shares, onBehalf, receiver)
        r[n++] = _r(MORPHO, IMorpho.borrow.selector, ALLOWED | w(7) | w(8));

        // ERC-20s: transfer/approve only to allowlisted recipients; pulls only owner -> executor.
        for (uint256 i; i < tokens.length; ++i) {
            r[n++] = _r(tokens[i], IERC20.transfer.selector, ALLOWED | RECIPIENT);
            r[n++] = _r(tokens[i], IERC20.approve.selector, ALLOWED | RECIPIENT);
            r[n++] = _r(tokens[i], IERC20.transferFrom.selector, ALLOWED | w(0) | w(1));
        }

        // Pendle core: mint/redeem only. Router and markets are intentionally absent.
        r[n++] = _r(YT_USD3, IPYieldToken.mintPY.selector, ALLOWED | w(0) | w(1));
        r[n++] = _r(YT_USD3, IPYieldToken.redeemPY.selector, ALLOWED | w(0));
        r[n++] = _r(YT_REUSD, IPYieldToken.mintPY.selector, ALLOWED | w(0) | w(1));
        r[n++] = _r(YT_REUSD, IPYieldToken.redeemPY.selector, ALLOWED | w(0));
        r[n++] = _r(SY_USD3, IStandardizedYield.deposit.selector, ALLOWED | w(0));
        r[n++] = _r(SY_USD3, IStandardizedYield.redeem.selector, ALLOWED | w(0));
        r[n++] = _r(SY_REUSD, IStandardizedYield.deposit.selector, ALLOWED | w(0));
        r[n++] = _r(SY_REUSD, IStandardizedYield.redeem.selector, ALLOWED | w(0));

        // 3Jane USD3 (ERC-4626): deposit(assets, receiver), redeem/withdraw(x, receiver, owner)
        r[n++] = _r(USD3, bytes4(keccak256("deposit(uint256,address)")), ALLOWED | w(1));
        r[n++] = _r(USD3, bytes4(keccak256("redeem(uint256,address,address)")), ALLOWED | w(1) | w(2));
        r[n++] = _r(USD3, bytes4(keccak256("withdraw(uint256,address,address)")), ALLOWED | w(1) | w(2));

        // Aggregators. AllowanceHolder.exec(operator, token, amount, target, data) forwards to the
        // current 0x Settler; Kyber swap(SwapExecutionParams).
        r[n++] = _r(ZEROX_ALLOWANCE_HOLDER, bytes4(keccak256("exec(address,address,uint256,address,bytes)")), ALLOWED);
        r[n++] = _r(KYBER_ROUTER, bytes4(0xe21fd0e9), ALLOWED);

        // Aave v3 Pool. Funds always land in the Executor (borrow, withdraw to self/owner);
        // onBehalfOf / to must be the owner or the Executor.
        // supply(asset, amount, onBehalfOf, referralCode)
        r[n++] = _r(AAVE_POOL, IAavePool.supply.selector, ALLOWED | w(2));
        // withdraw(asset, amount, to): burns the Executor's own aTokens
        r[n++] = _r(AAVE_POOL, IAavePool.withdraw.selector, ALLOWED | w(2));
        // borrow(asset, amount, interestRateMode, referralCode, onBehalfOf)
        r[n++] = _r(AAVE_POOL, IAavePool.borrow.selector, ALLOWED | w(4));
        // repay(asset, amount, interestRateMode, onBehalfOf)
        r[n++] = _r(AAVE_POOL, IAavePool.repay.selector, ALLOWED | w(3));
        // aTokens: pull the owner's supply into the Executor to withdraw it, or hand it back.
        // No recipient is allowlisted for them, so `transfer` can only go to the owner.
        address[2] memory aTokens = [A_USDC, A_USDT];
        for (uint256 i; i < aTokens.length; ++i) {
            r[n++] = _r(aTokens[i], IERC20.transfer.selector, ALLOWED | RECIPIENT);
            r[n++] = _r(aTokens[i], IERC20.transferFrom.selector, ALLOWED | w(0) | w(1));
        }

        assert(n == r.length);
    }

    function recipients() internal pure returns (CovenantCore.RecipientInit[] memory r) {
        r = new CovenantCore.RecipientInit[](22);
        uint256 n;
        r[n++] = CovenantCore.RecipientInit(USDC, MORPHO); // repay / flash repayment
        r[n++] = CovenantCore.RecipientInit(USDT, MORPHO); // repay / flash repayment (USDT market)
        r[n++] = CovenantCore.RecipientInit(USDC, AAVE_POOL); // Aave supply / repay
        r[n++] = CovenantCore.RecipientInit(USDT, AAVE_POOL); // Aave supply / repay
        r[n++] = CovenantCore.RecipientInit(USDC, ZEROX_ALLOWANCE_HOLDER); // USDC -> USDT
        r[n++] = CovenantCore.RecipientInit(USDT, ZEROX_ALLOWANCE_HOLDER); // USDT -> USDC
        r[n++] = CovenantCore.RecipientInit(USDC, KYBER_ROUTER);
        r[n++] = CovenantCore.RecipientInit(USDT, KYBER_ROUTER);
        // reUSD -> USDC exits, USDC -> reUSD entries
        r[n++] = CovenantCore.RecipientInit(REUSD, ZEROX_ALLOWANCE_HOLDER);
        r[n++] = CovenantCore.RecipientInit(REUSD, KYBER_ROUTER);
        r[n++] = CovenantCore.RecipientInit(USDC, SY_USD3); // SY.deposit(USDC)
        r[n++] = CovenantCore.RecipientInit(USDC, USD3); // USD3.deposit
        r[n++] = CovenantCore.RecipientInit(USD3, SY_USD3); // SY.deposit(USD3)
        r[n++] = CovenantCore.RecipientInit(PT_USD3, MORPHO); // supplyCollateral
        r[n++] = CovenantCore.RecipientInit(PT_USD3, YT_USD3); // redeemPY
        r[n++] = CovenantCore.RecipientInit(YT_USD3, YT_USD3); // redeemPY
        r[n++] = CovenantCore.RecipientInit(SY_USD3, YT_USD3); // mintPY
        r[n++] = CovenantCore.RecipientInit(REUSD, SY_REUSD); // SY.deposit(reUSD)
        r[n++] = CovenantCore.RecipientInit(PT_REUSD, MORPHO);
        r[n++] = CovenantCore.RecipientInit(PT_REUSD, YT_REUSD);
        r[n++] = CovenantCore.RecipientInit(YT_REUSD, YT_REUSD);
        r[n++] = CovenantCore.RecipientInit(SY_REUSD, YT_REUSD);
        assert(n == r.length);
    }

    function _r(address target, bytes4 selector, uint256 rule)
        private
        pure
        returns (CovenantCore.RuleInit memory)
    {
        return CovenantCore.RuleInit(target, selector, rule);
    }
}
