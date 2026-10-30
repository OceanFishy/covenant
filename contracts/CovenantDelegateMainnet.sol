// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantDelegate} from "./CovenantDelegate.sol";
import {MainnetConfig} from "./config/MainnetConfig.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IAavePool} from "./interfaces/IAave.sol";

/// @notice The EIP-7702 delegate with the mainnet allowlist. One shared deployment (CREATE2,
/// no constructor arguments, so its address follows from the bytecode); each EOA that
/// delegates to it calls `initialize()` once, from itself, to write the allowlist into its
/// own storage. Re-running `initialize()` after a config bump adds the new rules.
contract CovenantDelegateMainnet is CovenantDelegate {
    /// Bump with every MainnetConfig change; the app compares it with `configVersion()`.
    uint256 public constant CONFIG_VERSION = 1;

    constructor() CovenantDelegate(IMorpho(MainnetConfig.MORPHO), IAavePool(MainnetConfig.AAVE_POOL)) {}

    function initialize() external onlySelf {
        _initialize(MainnetConfig.rules(), MainnetConfig.recipients(), CONFIG_VERSION);
    }
}
