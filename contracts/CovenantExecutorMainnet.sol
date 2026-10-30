// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CovenantExecutor} from "./CovenantExecutor.sol";
import {MainnetConfig} from "./config/MainnetConfig.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";

/// @notice The Executor with the mainnet allowlist baked in, so the app deploys it with a
/// single constructor argument (the owner) in one transaction.
contract CovenantExecutorMainnet is CovenantExecutor {
    constructor(address owner_)
        CovenantExecutor(owner_, IMorpho(MainnetConfig.MORPHO), MainnetConfig.rules(), MainnetConfig.recipients())
    {}
}
