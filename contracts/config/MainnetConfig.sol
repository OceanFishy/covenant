// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantExecutor} from "../CovenantExecutor.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {IMorpho} from "../interfaces/IMorpho.sol";
import {IPYieldToken, IStandardizedYield} from "../interfaces/IPendle.sol";

/// @notice Ethereum mainnet addresses and the Executor allowlist built from them.
/// Every address here was verified on-chain (see registry/mainnet.json for how).
/// Keep this file and registry/mainnet.json in sync.
library MainnetConfig {
    // Tokens
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USD3 = 0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc; // 3Jane senior tranche (Yearn V3 strategy)
    address internal constant REUSD = 0x5086bf358635B81D8C47C66d1C8b9E567Db70c72;

    // Morpho Blue
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    // Pendle PT-USD3-17DEC2026
    address internal constant PT_USD3 = 0x7f47c3e6b2c00fC4eB4d5Ae50d0Ab0Ab6888Eb4D;
    address internal constant YT_USD3 = 0x5cFfCc9DdEF0fDcf395e2eA24CA5ED5A12032706;
    address internal constant SY_USD3 = 0xeA3BC608F32847B97965C5e1648BDFCd4C2C40d0;

    // Pendle PT-reUSD-10DEC2026
    address internal constant PT_REUSD = 0xeCfaFdC7741323a945A163ed068B5a3C43483957;
    address internal constant YT_REUSD = 0xA8bD3B21291AcE53927b35563fc80615919E63D7;
    address internal constant SY_REUSD = 0x9487Bd5A3b16Ecb5F3184453E3ee75B800141648;

    // Morpho markets (USDC loans)
    bytes32 internal constant MKT_PT_USD3_USDC_A = 0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89;
    bytes32 internal constant MKT_PT_USD3_USDC_B = 0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837;
    bytes32 internal constant MKT_PT_REUSD_USDC = 0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64;

    /// Rule bit requiring argument word `i` to be the owner or the Executor.
    function w(uint256 i) internal pure returns (uint256) {
        return 1 << (i + 1);
    }

    function rules() internal pure returns (CovenantExecutor.RuleInit[] memory r) {
        uint256 ALLOWED = 1;
        uint256 RECIPIENT = 1 << 255;
        address[9] memory tokens = [USDC, USD3, REUSD, PT_USD3, YT_USD3, SY_USD3, PT_REUSD, YT_REUSD, SY_REUSD];

        r = new CovenantExecutor.RuleInit[](6 + tokens.length * 3 + 4 * 2 + 3);
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

        assert(n == r.length);
    }

    function recipients() internal pure returns (CovenantExecutor.RecipientInit[] memory r) {
        r = new CovenantExecutor.RecipientInit[](13);
        uint256 n;
        r[n++] = CovenantExecutor.RecipientInit(USDC, MORPHO); // repay / flash repayment
        r[n++] = CovenantExecutor.RecipientInit(USDC, SY_USD3); // SY.deposit(USDC)
        r[n++] = CovenantExecutor.RecipientInit(USDC, USD3); // USD3.deposit
        r[n++] = CovenantExecutor.RecipientInit(USD3, SY_USD3); // SY.deposit(USD3)
        r[n++] = CovenantExecutor.RecipientInit(PT_USD3, MORPHO); // supplyCollateral
        r[n++] = CovenantExecutor.RecipientInit(PT_USD3, YT_USD3); // redeemPY
        r[n++] = CovenantExecutor.RecipientInit(YT_USD3, YT_USD3); // redeemPY
        r[n++] = CovenantExecutor.RecipientInit(SY_USD3, YT_USD3); // mintPY
        r[n++] = CovenantExecutor.RecipientInit(REUSD, SY_REUSD); // SY.deposit(reUSD)
        r[n++] = CovenantExecutor.RecipientInit(PT_REUSD, MORPHO);
        r[n++] = CovenantExecutor.RecipientInit(PT_REUSD, YT_REUSD);
        r[n++] = CovenantExecutor.RecipientInit(YT_REUSD, YT_REUSD);
        r[n++] = CovenantExecutor.RecipientInit(SY_REUSD, YT_REUSD);
        assert(n == r.length);
    }

    function _r(address target, bytes4 selector, uint256 rule)
        private
        pure
        returns (CovenantExecutor.RuleInit memory)
    {
        return CovenantExecutor.RuleInit(target, selector, rule);
    }
}
