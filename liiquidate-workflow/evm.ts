/**
 * @title EVM Contract Interactions
 * @description Module for on-chain interactions with LiiBorrow, Liquidator Adapter,
 *              and Aave V3 contracts. Handles liquidation execution, position queries,
 *              and pool data retrieval.
 * @author Liidia Team
 * @version 1.0.0
 */

// evm.ts
// EVM on-chain settlement for prediction markets.
// Uses CRE EVM Write capability to submit settlement reports.

import {
    type Runtime,
    getNetwork,
    bytesToHex,
    hexToBase64,
    EVMClient,
    TxStatus,
    encodeCallMsg,
    LATEST_BLOCK_NUMBER
} from "@chainlink/cre-sdk";
import {
    encodeAbiParameters,
    type Address,
    decodeFunctionResult,
    encodeFunctionData,
    zeroAddress
} from "viem";
import type {
    Config,
    LiquidatablePositions,
    RiskState,
    LiquidationStatus,
    UserSuppliedCollateral,
    PoolAccountData,
    HealthFactor,
    AaveAmount,
    PrepareWriteOutput,
    ReadPositionData
} from "./types";
import { LiiBorrowV1, LiquidatorAdapter, Aave, Multicall3 } from "../contracts/abi";
import { USDC, MULTICALL3_ADDRESS, HOT_HF, WARM_HF } from "./helper"

/**
 * @notice Executes liquidation transactions for undercollateralized positions
 * @dev Signs and submits a liquidation report to the Liiquidate consumer contract.
 *      Uses CRE's report signing capability for decentralized execution.
 * @param runtime - The CRE runtime instance containing config and secrets
 * @param positions - Array of liquidatable positions with user, collateral, debt info
 * @param chain - The chain index for configuration lookup
 * @returns The transaction hash of the successful liquidation
 * @throws Error if transaction reverts or fails fatally
 * 
 * @dev Execution Flow:
 *      1. Fetch EVM config for the specified chain
 *      2. Resolve network from chain selector name
 *      3. Encode liquidation report data as ABI parameters
 *      4. Sign report using ECDSA with keccak256 hashing
 *      5. Submit signed report via evmClient.writeReport()
 *      6. Verify transaction success and return tx hash
 * 
 * @dev Report Data Structure:
 *      - user: Address of the borrower
 *      - collateralAsset: Address of collateral token to seize
 *      - debtAsset: Address of debt token (USDC)
 *      - debtToCover: Amount of debt to cover in USDC
 *      - protocol: Protocol identifier string
 */
export function liquidatePositions(
    runtime: Runtime<Config>,
    positions: LiquidatablePositions[],
    chain: number
): string {
    runtime.log(`>>> Liquidating ${positions.length} positions.`)

    // Fetch config
    const evmCfg = runtime.config.evms[chain];

    // Resolve concrete chain selector from chainSelectorName
    const network = getNetwork({
        chainFamily: "evm",
        chainSelectorName: evmCfg.chainSelectorName,
        isTestnet: true,
    });
    if (!network) throw new Error(`Unknown chain name: ${evmCfg.chainSelectorName}`);

    const evmClient = new EVMClient(network.chainSelector.selector);

    // Encode report payload for signing & submission
    const reportData = makeReportData(positions);

    // Sign the report using ECDSA over keccak256 (EVM-compatible signature)
    const reportResponse = runtime
        .report({
            encodedPayload: hexToBase64(reportData),
            encoderName: "evm",
            signingAlgo: "ecdsa",
            hashingAlgo: "keccak256",
        })
        .result();

    // Submit the signed report to the Liiquidate Contract via onReport()
    const writeReportResult = evmClient
        .writeReport(runtime, {
            receiver: evmCfg.proxyAddress,
            report: reportResponse,
            gasConfig: {
                gasLimit: evmCfg.gasLimit,
            },
        })
        .result();

    // Check for failed tx
    if (writeReportResult.txStatus === TxStatus.SUCCESS) {
        runtime.log(`- SUCCESS`)
    } else if (writeReportResult.txStatus === TxStatus.REVERTED) {
        runtime.log(`Transaction reverted: ${writeReportResult.errorMessage || "Unknown error"}`)
        throw new Error(`Write failed: ${writeReportResult.errorMessage}`)
    } else if (writeReportResult.txStatus === TxStatus.FATAL) {
        runtime.log(`Fatal error: ${writeReportResult.errorMessage || "Unknown error"}`)
        throw new Error(`Fatal write error: ${writeReportResult.errorMessage}`)
    }

    const txHash = bytesToHex(writeReportResult.txHash ?? new Uint8Array(32));

    return txHash;
}

/**
 * @title LiiBorrow Contract Queries
 * @description Functions for interacting with the LiiBorrow lending protocol
 */

/**
 * @notice Converts a USD amount to USDC token amount
 * @dev Queries the LiiBorrow contract to convert a value in USD (wei) to USDC tokens
 * @param runtime - The CRE runtime instance
 * @param value - The USD value in wei to convert
 * @param chain - The chain index for configuration lookup
 * @returns The equivalent amount of USDC tokens
 * @throws Error if no amount is returned from the contract
 */
export function getUsdcAmount(
    runtime: Runtime<Config>,
    value: bigint,
    chain: number
): bigint {

    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: LiiBorrowV1,
        functionName: 'getCollateralAmount',
        args: [USDC, value],
    })

    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.liiBorrowAddress as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const amount = decodeFunctionResult({
        abi: LiiBorrowV1,
        functionName: 'getCollateralAmount',
        data: bytesToHex(contractCall.data),
    })

    if (!amount) {
        throw new Error('No amount returned from contract!')
    }

    return amount
}

/**
 * @notice Retrieves all collateral positions supplied by a user
 * @dev Queries the LiiBorrow contract for all collateral assets supplied by a user
 * @param runtime - The CRE runtime instance
 * @param user - The borrower's wallet address
 * @param chain - The chain index for configuration lookup
 * @returns Array of UserSuppliedCollateral containing symbol, address, amount, and USD value
 * @throws Error if no collaterals are returned
 * 
 * @dev Return Structure:
 *      - symbol: Token symbol (e.g., "WETH")
 *      - collateral: Token contract address
 *      - amount: Raw token amount supplied
 *      - value: USD value of the collateral
 */
export function getUserCollateral(
    runtime: Runtime<Config>,
    user: Address,
    chain: number
): readonly UserSuppliedCollateral[] {
    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: LiiBorrowV1,
        functionName: 'getUserSuppliedCollateralAmount',
        args: [user as Address],
    })

    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.liiBorrowAddress as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const collaterals = decodeFunctionResult({
        abi: LiiBorrowV1,
        functionName: 'getUserSuppliedCollateralAmount',
        data: bytesToHex(contractCall.data),
    })

    if (!collaterals) {
        throw new Error('No collaterals returned from contract!')
    }

    return collaterals
}

/**
 * @title LiiBorrow Adapter Queries
 * @description Functions for risk assessment and liquidation eligibility via the Liquidator Adapter
 */

/**
 * @notice Calculates liquidation profitability for a specific position
 * @dev Queries the Liquidator Adapter to determine max debt to cover, expected returns,
 *      and potential profit from liquidating a position
 * @param runtime - The CRE runtime instance
 * @param user - The borrower's wallet address
 * @param collateral - The collateral token address to seize
 * @param chain - The chain index for configuration lookup
 * @returns LiquidationStatus object containing:
 *          - maxDebtToCover: Maximum debt that can be covered (in USD)
 *          - actualReturn: Actual collateral return after liquidation
 *          - expectedReturn: Expected collateral return
 *          - expectedProfit: Expected profit from liquidation
 *          - liquidationBonus: Bonus percentage in bps
 * @throws Error if no position data is returned
 */
export function getLiquidationStatus(
    runtime: Runtime<Config>,
    user: Address,
    collateral: Address,
    chain: number
): LiquidationStatus {
    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: LiquidatorAdapter,
        functionName: 'getLiquidationStatus',
        args: [
            user as Address,
            collateral as Address
        ],
    })

    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.liiBorrowAdapter as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const status = decodeFunctionResult({
        abi: LiquidatorAdapter,
        functionName: 'getLiquidationStatus',
        data: bytesToHex(contractCall.data),
    })

    if (!status) {
        throw new Error('No position returned from contract!')
    }

    return {
        maxDebtToCover: status.maxDebtToCover,
        actualReturn: status.actualReturn,
        expectedReturn: status.expectedReturn,
        expectedProfit: status.expectedProfit,
        liquidationBonus: status.liquidationBonus
    }
}

/**
 * @notice Retrieves the current risk state of a user's position
 * @dev Queries the Liquidator Adapter to get the user's health factor and liquidation status
 * @param runtime - The CRE runtime instance
 * @param user - The borrower's wallet address
 * @param chain - The chain index for configuration lookup
 * @returns RiskState object containing:
 *          - liquidatable: Boolean indicating if position can be liquidated
 *          - riskMetric: Health factor or risk metric (normalized, 1e18 = HF of 1)
 *          - collateralUSD: Total collateral value in USD
 *          - debtUSD: Total debt value in USD
 * @throws Error if no position data is returned
 * 
 * @dev Risk Metric Thresholds:
 *      - liquidatable: riskMetric < 1.05e18 (HF < 1.05)
 *      - warm: riskMetric <= 1.15e18 (HF <= 1.15)
 *      - cold: riskMetric > 1.15e18 (HF > 1.15)
 */
export function getCurrentPosition(
    runtime: Runtime<Config>,
    user: Address,
    chain: number
): RiskState {
    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: LiquidatorAdapter,
        functionName: 'getRiskState',
        args: [user as Address]
    })

    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.liiBorrowAdapter as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const position = decodeFunctionResult({
        abi: LiquidatorAdapter,
        functionName: 'getRiskState',
        data: bytesToHex(contractCall.data),
    })

    if (!position) {
        throw new Error('No position returned from contract!')
    }

    return {
        liquidatable: position.liquidatable,
        riskMetric: position.riskMetric,
        collateralUSD: position.collateralUSD,
        debtUSD: position.debtUSD
    }
}

// 1. Encode all calls
// 2. Single Multicall3 aggregate call
// 3. Decode all results
// 4. Map back to positions

/**
 * @notice Batch retrieves risk states for multiple positions using Multicall3
 * @dev Optimizes RPC calls by aggregating multiple getRiskState queries into one
 *      multicall transaction, significantly reducing latency for bulk position checks
 * @param runtime - The CRE runtime instance
 * @param positions - Array of ReadPositionData containing user addresses
 * @param chain - The chain index for configuration lookup
 * @returns Array of PrepareWriteOutput objects with hf (health factor) and status
 * 
 * @dev Gas Optimization:
 *      - Uses Multicall3 (0xcA11bde05977b3631167028862bE2a173976CA11) for batched calls
 *      - Single RPC round-trip for multiple positions
 *      - allowFailure: true to continue processing even if individual calls fail
 * 
 * @dev Status Mapping:
 *      - 0 (HOT): riskMetric < 1.05e18 - Liquidatable
 *      - 1 (WARM): riskMetric <= 1.15e18 - At risk
 *      - 2 (COLD): riskMetric > 1.15e18 - Healthy
 */
export function batchGetRiskStates(
    runtime: Runtime<Config>,
    positions: ReadPositionData[],
    chain: number
): PrepareWriteOutput[] {
    const evmConfig = runtime.config.evms[chain];
    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    });

    if (!network) throw new Error(`Network not found for chain: ${evmConfig.chainSelectorName}`);

    const evmClient = new EVMClient(network.chainSelector.selector);

    // 1. Encode all getRiskState calls as Multicall3 calls
    const calls = positions.map((position) => ({
        target: evmConfig.liiBorrowAdapter as Address,
        allowFailure: true,
        callData: encodeFunctionData({
            abi: LiquidatorAdapter,
            functionName: 'getRiskState',
            args: [position.user as Address],
        }),
    }));

    // 2. Encode the multicall aggregate3 call
    const multicallData = encodeFunctionData({
        abi: Multicall3,
        functionName: 'aggregate3',
        args: [calls],
    });

    // 3. Single RPC call
    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: MULTICALL3_ADDRESS,
                data: multicallData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result();

    // 4. Decode aggregate3 results
    const results = decodeFunctionResult({
        abi: Multicall3,
        functionName: 'aggregate3',
        data: bytesToHex(contractCall.data),
    });

    // 5. Map back to positions
    return results.map((result, i) => {
        if (!result.success) {
            runtime.log(`Failed to get risk state for ${positions[i].user}`)
            return { hf: "0", status: 0 }
        }

        const position = decodeFunctionResult({
            abi: LiquidatorAdapter,
            functionName: 'getRiskState',
            data: result.returnData,
        });

        let status: 0 | 1 | 2 = 0;
        if (position.riskMetric < HOT_HF) status = 0;
        else if (position.riskMetric <= WARM_HF) status = 1;
        else status = 2;

        return {
            hf: position.riskMetric.toString(),
            status,
        };
    });
}

/**
 * @title Aave V3 Pool Data Queries
 * @description Functions for retrieving pool-level data from Aave V3 for protocol monitoring
 */

/**
 * @notice Retrieves aggregated account data for the LiiBorrow pool
 * @dev Queries Aave V3's getUserAccountData for the LiiBorrow proxy address
 * @param runtime - The CRE runtime instance
 * @param chain - The chain index for configuration lookup
 * @returns PoolAccountData object containing:
 *          - collateralUSD: Total collateral in USD
 *          - debtUSD: Total debt in USD
 *          - canBorrowUSD: Available borrowing power in USD
 *          - canBorrowUSDC: Available borrowing power in USDC
 *          - lltv: Protocol's maximum loan-to-value ratio
 *          - ltv: Current loan-to-value ratio
 * @throws Error if no data is returned from the contract
 */
export function getPoolAccountData(
    runtime: Runtime<Config>,
    chain: number
): PoolAccountData {
    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: Aave,
        functionName: 'getUserAccountData',
        args: [evmConfig.liiBorrowAddress as Address],
    })

    // Contract call
    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.AaveAddress as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const resp = decodeFunctionResult({
        abi: Aave,
        functionName: 'getUserAccountData',
        data: bytesToHex(contractCall.data),
    })

    if (!resp) {
        throw new Error('No position returned from contract!')
    }

    return {
        collateralUSD: resp[0],
        debtUSD: resp[1],
        canBorrowUSD: resp[2],
        canBorrowUSDC: resp[3],
        lltv: resp[4],
        ltv: resp[5],
    }
}

/**
 * @notice Retrieves the pool's aggregate health factor
 * @dev Queries Aave V3's getHealthFactor for the LiiBorrow proxy address
 * @param runtime - The CRE runtime instance
 * @param chain - The chain index for configuration lookup
 * @returns HealthFactor object containing:
 *          - healthFactor: The pool's health factor (1e18 = HF of 1)
 *          - status: Risk status (0 = critical, 1 = warning, 2 = healthy)
 * @throws Error if no data is returned
 * 
 * @dev Status Codes:
 *      - 0: healthFactor < 1e18 (below 1, critically undercollateralized)
 *      - 1: healthFactor <= 1.1e18 (between 1 and 1.1, warning zone)
 *      - 2: healthFactor > 1.1e18 (above 1.1, healthy)
 */
export function getPoolHealthFactor(
    runtime: Runtime<Config>,
    chain: number
): HealthFactor {
    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: Aave,
        functionName: 'getHealthFactor',
        args: [evmConfig.liiBorrowAddress as Address],
    })

    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.AaveAddress as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const resp = decodeFunctionResult({
        abi: Aave,
        functionName: 'getHealthFactor',
        data: bytesToHex(contractCall.data),
    })

    if (!resp) {
        throw new Error('No position returned from contract!')
    }

    return {
        healthFactor: resp[0],
        status: resp[1]
    }
}

/**
 * @notice Retrieves the variable debt balance for a specific asset
 * @dev Queries Aave V3 to get the current variable rate debt for an asset
 * @param runtime - The CRE runtime instance
 * @param chain - The chain index for configuration lookup
 * @param asset - The token address to query debt for
 * @returns AaveAmount object containing the debt amount in raw token units
 * @throws Error if no data is returned
 */
export function getVariableDebt(
    runtime: Runtime<Config>,
    chain: number,
    asset: Address
): AaveAmount {
    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: Aave,
        functionName: 'getVariableDebt',
        args: [evmConfig.liiBorrowAddress as Address, asset],
    })

    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.AaveAddress as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const resp = decodeFunctionResult({
        abi: Aave,
        functionName: 'getVariableDebt',
        data: bytesToHex(contractCall.data),
    })

    if (!resp) {
        throw new Error('No position returned from contract!')
    }

    return {
        amount: resp
    }
}

/**
 * @notice Retrieves the supply (aToken) balance for a specific asset
 * @dev Queries Aave V3 to get the current supply balance for an asset
 * @param runtime - The CRE runtime instance
 * @param chain - The chain index for configuration lookup
 * @param asset - The token address to query supply for
 * @returns AaveAmount object containing the supply amount in raw token units
 * @throws Error if no data is returned
 */
export function getSupplyBalance(
    runtime: Runtime<Config>,
    chain: number,
    asset: Address
): AaveAmount {
    // Fetch config
    const evmConfig = runtime.config.evms[chain];

    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: true,
    })

    if (!network) {
        throw new Error(`Network not found for chain selector name: ${evmConfig.chainSelectorName}`)
    }

    // Create instance
    const evmClient = new EVMClient(network.chainSelector.selector)

    // Encode the contract call data for getNativeBalances
    const callData = encodeFunctionData({
        abi: Aave,
        functionName: 'getSupplyBalance',
        args: [evmConfig.liiBorrowAddress as Address, asset],
    })

    const contractCall = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: evmConfig.AaveAddress as Address,
                data: callData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result()

    // Decode the result
    const resp = decodeFunctionResult({
        abi: Aave,
        functionName: 'getSupplyBalance',
        data: bytesToHex(contractCall.data),
    })

    if (!resp) {
        throw new Error('No position returned from contract!')
    }

    return {
        amount: resp
    }
}

/**
 * @title Report Encoding Helpers
 * @description Utility functions for encoding liquidation report data
 */

/**
 * @notice Encodes liquidation report data for on-chain submission
 * @dev Packages liquidatable positions into ABI-encoded bytes for the Liiquidate contract
 * @param reports - Array of LiquidatablePositions to encode
 * @returns string representing the report data ABI-encoded byte
 * 
 * @dev Encoding Structure:
 *      tuple[] where each tuple contains:
 *      - user: address - Borrower's wallet address
 *      - collateralAsset: address - Collateral token to seize
 *      - debtAsset: address - Debt token (USDC)
 *      - debtToCover: uint256 - Amount of debt to cover
 *      - protocol: string - Protocol identifier
 */
export const makeReportData = (reports: LiquidatablePositions[]) =>
    encodeAbiParameters(
        [
            {
                type: 'tuple[]',
                components: [
                    { name: 'user', type: 'address' },
                    { name: 'collateralAsset', type: 'address' },
                    { name: 'debtAsset', type: 'address' },
                    { name: 'debtToCover', type: 'uint256' },
                    { name: 'protocol', type: 'string' }, // ← last
                ],
            },
        ],
        [
            reports.map((r) => ({
                user: r.user as Address,
                collateralAsset: r.collateralAsset as Address,
                debtAsset: r.debtAsset as Address,
                debtToCover: r.debtToCover,
                protocol: r.protocol,
            })),
        ]
    );