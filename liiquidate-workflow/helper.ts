/**
 * @title Helper Functions & Constants
 * @description Core utility functions for risk assessment, position checking, and
 *              liquidation eligibility. Contains health factor thresholds, asset
 *              configurations, and oracle mappings.
 * @author Liidia Team
 * @version 1.0.0
 */

import {
    PrepareWriteOutput,
    Config,
    LiquidatablePositions,
    ReadPositionData,
    AssetInfo,
    PositionWriteData,
    RiskState,
    UserSuppliedCollateral,
    LiquidationStatus,
    EvmConfig,
    PoolAccountData,
    HealthFactor,
    AaveAmount
} from './types'
import {
    getCurrentPosition,
    batchGetRiskStates
} from './evm'
import {
    Runtime,
    EVMClient,
    getNetwork,
    LATEST_BLOCK_NUMBER,
    encodeCallMsg
} from '@chainlink/cre-sdk'
import {
    parseEther,
    Address,
    decodeFunctionResult,
    encodeFunctionData,
    Hex,
    bytesToHex,
    zeroAddress,
} from 'viem'
import { readAllPositionsFromSupabase, writePositionsToSupabase } from './supabase'
import { LiquidatorAdapter, LiiBorrowV1, Multicall3, Aave } from '../contracts/abi'

// Constants
export const BASE_HF = parseEther("1")
export const HOT_HF = parseEther("1.05")
export const WARM_HF = parseEther("1.10")
const STALENESS_THRESHOLD = 3600n

// Debt Asset
export const USDC: Address = '0x8ca959E4c4745df0E2fE5CE5fAcFD3F35ae509e9'
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Map oracle to asset
export const ORACLES_MAP: Record<string, string> = {
    "0x1e1e2a398eba72c5d4bdea909f3bc928efff4505": "0x49C954F846e870FE5402C7F65cD035592c81aadB", // WETH/USD
} as const

// Map protocol name to protocol address
export const HASH_MAP: Record<string, Address> = {
    LIIBORROW_v1: "0x4E0Af3287669D331BB5B858B738B0be069b7C750",
} as const

// Supported Assets
export const supportedAssets: Array<string> = ['WETH']

// Map asset name to its address
export const ASSET_DATA: Record<string, AssetInfo> = {
    WETH: {
        address: "0x49C954F846e870FE5402C7F65cD035592c81aadB",
        decimals: 18,
    },
    USDC: {
        address: USDC,
        decimals: 6,
    },
} as const

/**
 * @notice Determines risk status for a user's position
 * @dev Queries on-chain for current health factor and maps to status code
 * @param runtime - The CRE runtime instance
 * @param user - The borrower's wallet address
 * @param chain - The chain index for configuration lookup
 * @returns PrepareWriteOutput with:
 *          - hf: Health factor as string (wei scale)
 *          - status: 0=HOT, 1=WARM, 2=COLD
 * 
 * @dev Status Thresholds:
 *      - HOT (0): HF < 1.05 - Should be liquidated
 *      - WARM (1): HF <= 1.10 - Monitor closely
 *      - COLD (2): HF > 1.10 - Healthy
 */
export function getRiskStatus(
    runtime: Runtime<Config>,
    user: Address,
    chain: number
): PrepareWriteOutput {
    // fetch hf
    const { riskMetric } = getCurrentPosition(runtime, user, chain);
    // Determine status
    let status: 0 | 1 | 2 = 0;
    if (riskMetric < HOT_HF)
        status = 0; // HOT - Should be liquidated
    else if (riskMetric <= WARM_HF)
        status = 1; // WARM - Should be closely monitored
    else
        status = 2; // COLD - Out of risk region

    return {
        hf: riskMetric.toString(),
        status: status
    }
}

/**
 * @notice Checks if oracle price data is stale
 * @dev Compares last update timestamp against current time
 * @param last - Last update timestamp in seconds (unix epoch)
 * @returns true if price data is older than STALENESS_THRESHOLD (1 hour)
 * 
 * @dev Staleness Threshold: 3600 seconds (1 hour)
 *      Used to ensure we're not making decisions on outdated price data
 */
export function isStale(last: bigint): boolean {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return now - last > STALENESS_THRESHOLD;
}

/**
 * @notice Determines which positions can be liquidated
 * @dev For each position:
 *      1. Checks if position is liquidatable (HF < 1)
 *      2. Gets user's collateral positions
 *      3. Calculates max debt to cover and expected return
 *      4. Validates collateral value >= actual return
 * @param runtime - The CRE runtime instance
 * @param chain - The chain index for configuration lookup
 * @param positions - Array of ReadPositionData to check
 * @returns Array of LiquidatablePositions ready for liquidation
 * 
 * @dev Validation Steps:
 *      1. Query getCurrentPosition to check liquidatable flag
 *      2. Get all collateral supplied by user via getUserCollateral
 *      3. Get liquidation params via getLiquidationStatus
 *      4. Convert USD debt to USDC tokens via getUsdcAmount
 *      5. Verify collateral value >= actual return before adding
 * 
 * @dev Logging:
 *      - Logs each valid position: protocol, user, collateral, debt, debtToCover
 */
export function checkIfLiquidatable(
    runtime: Runtime<Config>,
    chain: number,
    positions: ReadPositionData[]
): LiquidatablePositions[] {
    runtime.log(">>> Checking for liquidatable positions.");

    const evmConfig = runtime.config.evms[chain];
    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: false,
    });
    if (!network) throw new Error(`Network not found for chain: ${evmConfig.chainSelectorName}`);

    const evmClient = new EVMClient(network.chainSelector.selector);

    // ── 1 RPC call: get all risk states ──
    const riskStates = _batchGetRiskStates(runtime, evmClient, evmConfig, positions);

    // Filter only liquidatable
    const liquidatable = positions.filter((_, i) => riskStates[i].liquidatable);

    if (liquidatable.length === 0) {
        runtime.log("No liquidatable positions found.");
        return [];
    }

    // ── 2 RPC calls: collateral + liquidation status + usdc amount ──
    const liquidationData = _batchGetLiquidationData(runtime, evmClient, evmConfig, liquidatable);

    // ── Build final result ──
    const validPositions: LiquidatablePositions[] = [];

    for (let i = 0; i < liquidatable.length; i++) {
        const { collaterals, liquidationStatus, usdcAmount } = liquidationData[i];

        for (let j = 0; j < collaterals.length; j++) {
            if (collaterals[j].value < liquidationStatus.actualReturn) continue;

            const position: LiquidatablePositions = {
                protocol: liquidatable[i].protocol as string,
                user: liquidatable[i].user as Address,
                collateralAsset: collaterals[j].collateral,
                debtAsset: USDC,
                debtToCover: usdcAmount,
            };

            runtime.log(`Protocol: ${position.protocol}, User: ${position.user}, Collateral: ${position.collateralAsset}, Debt: ${position.debtAsset}, DebtToCover: ${position.debtToCover}`);
            validPositions.push(position);
        }
    }

    return validPositions;
}

/**
 * @notice Batch updates all positions with current health factors
 * @dev Reads all positions from Supabase, groups by chain, queries risk states
 *      in batch via Multicall3, then performs single batch upsert to database
 * @param runtime - The CRE runtime instance
 * 
 * @dev Processing Flow:
 *      1. Fetch all positions from Supabase
 *      2. Group positions by chain (for multi-chain support)
 *      3. For each chain: batch query risk states via Multicall3
 *      4. Build update array with hf and status for each position
 *      5. Single batch upsert to Supabase
 * 
 * @dev Performance Optimization:
 *      - Uses batchGetRiskStates for RPC efficiency
 *      - Single database upsert for all updates
 *      - Logs each user's health factor for transparency
 */
export function updatePositions(runtime: Runtime<Config>): void {
    const positions = readAllPositionsFromSupabase(runtime);

    // Group positions by chain
    const byChain = positions.reduce((acc, position) => {
        const chain = position.chain ?? 0;
        if (!acc[chain]) acc[chain] = [];
        acc[chain].push(position);
        return acc;
    }, {} as Record<number, ReadPositionData[]>);

    const updates: PositionWriteData[] = [];

    // One multicall per chain
    for (const chain in byChain) {
        const chainPositions = byChain[chain];
        const riskStates = batchGetRiskStates(runtime, chainPositions, Number(chain));

        for (let i = 0; i < chainPositions.length; i++) {
            runtime.log(`User: ${chainPositions[i].user}, HF: ${riskStates[i].hf}`)
            updates.push({
                user: chainPositions[i].user ?? "",
                protocol: chainPositions[i].protocol ?? "",
                chain: Number(chain),
                collateral: chainPositions[i].collateral,
                hf: riskStates[i].hf,
                status: riskStates[i].status,
            });
        }
    }

    // Single batch upsert
    const resp = writePositionsToSupabase(runtime, updates);
    runtime.log(`Batch updated ${updates.length} positions: ${resp}`);
}

/**
 * @notice Retrieves comprehensive pool data for a specific chain from Aave V3
 * @dev Uses Multicall3 to aggregate multiple Aave pool queries in a single RPC call
 *      for efficient batch retrieval of account data, health factor, debt, and supply balances
 * @param runtime - The CRE runtime instance for state management and logging
 * @param chain - The chain selector number identifying the EVM network
 * @returns Object containing:
 *          - accountData: PoolAccountData with collateralUSD, debtUSD, canBorrowUSD, canBorrowUSDC, lltv, ltv
 *          - hf: HealthFactor with healthFactor (wei scale) and status
 *          - variableDebt: AaveAmount containing the variable debt amount for USDC
 *          - supplyBalances: Array of AaveAmount for each supported asset's supply balance
 * 
 * @dev Implementation Details:
 *      - Builds array of Multicall3 calls for: getUserAccountData, getHealthFactor, getVariableDebt, getSupplyBalance
 *      - Queries the LII Borrow Address configured for the chain
 *      - Uses supportedAssets list to determine which supply balances to fetch
 *      - Single RPC call reduces network overhead
 * 
 * @dev Calls Made:
 *      [0] getUserAccountData - returns collateral, debt, borrow limits, LTV, LLTV
 *      [1] getHealthFactor - returns health factor in wei (1e18 = HF of 1)
 *      [2] getVariableDebt - returns variable debt for USDC
 *      [3..N] getSupplyBalance - returns supply balance for each supported asset
 * 
 * @dev Performance:
 *      - Reduces 3+N RPC calls to 1 (where N = number of supported assets)
 *      - Uses Multicall3 aggregate3 for atomic execution
 * 
 * @throws Error if network is not found for the given chain selector
 * @throws Error if multicall execution fails
 */
export function getPoolData(
    runtime: Runtime<Config>,
    chain: number
): { 
    accountData: PoolAccountData, 
    hf: HealthFactor, 
    variableDebt: AaveAmount, 
    supplyBalances: AaveAmount[] 
} {
    const evmConfig = runtime.config.evms[chain];
    const network = getNetwork({
        chainFamily: 'evm',
        chainSelectorName: evmConfig.chainSelectorName,
        isTestnet: false,
    });
    if (!network) throw new Error(`Network not found: ${evmConfig.chainSelectorName}`);

    const evmClient = new EVMClient(network.chainSelector.selector);
    const aaveTarget = evmConfig.AaveAddress as Address;

    // ── Build all calls ──
    const calls = [
        // [0] getPoolAccountData
        {
            target: aaveTarget,
            allowFailure: false,
            callData: encodeFunctionData({
                abi: Aave,
                functionName: 'getUserAccountData',
                args: [evmConfig.liiBorrowAddress as Address],
            }),
        },
        // [1] getPoolHealthFactor
        {
            target: aaveTarget,
            allowFailure: false,
            callData: encodeFunctionData({
                abi: Aave,
                functionName: 'getHealthFactor',
                args: [evmConfig.liiBorrowAddress as Address],
            }),
        },
        // [2] getVariableDebt (USDC)
        {
            target: aaveTarget,
            allowFailure: false,
            callData: encodeFunctionData({
                abi: Aave,
                functionName: 'getVariableDebt',
                args: [evmConfig.liiBorrowAddress as Address, ASSET_DATA['USDC'].address as Address],
            }),
        },
        // [3..N] getSupplyBalance for each supported asset
        ...supportedAssets.map(asset => ({
            target: aaveTarget,
            allowFailure: false,
            callData: encodeFunctionData({
                abi: Aave,
                functionName: 'getSupplyBalance',
                args: [evmConfig.liiBorrowAddress as Address, ASSET_DATA[asset].address as Address],
            }),
        })),
    ];

    // ── Single RPC call ───────────────────────────────────────────────────────
    const results = _executeMulticallPoolData(runtime, evmClient, calls);

    // ── Decode results ────────────────────────────────────────────────────────
    const accountDataRaw = decodeFunctionResult({ abi: Aave, functionName: 'getUserAccountData', data: results[0].returnData });
    const hfRaw = decodeFunctionResult({ abi: Aave, functionName: 'getHealthFactor', data: results[1].returnData });
    const debtRaw = decodeFunctionResult({ abi: Aave, functionName: 'getVariableDebt', data: results[2].returnData });
    const supplyRaw = supportedAssets.map((_, i) =>
        decodeFunctionResult({ abi: Aave, functionName: 'getSupplyBalance', data: results[3 + i].returnData })
    );

    return {
        accountData: {
            collateralUSD: accountDataRaw[0],
            debtUSD: accountDataRaw[1],
            canBorrowUSD: accountDataRaw[2],
            canBorrowUSDC: accountDataRaw[3],
            lltv: accountDataRaw[4],
            ltv: accountDataRaw[5],
        },
        hf: {
            healthFactor: hfRaw[0],
            status: hfRaw[1],
        },
        variableDebt: { amount: debtRaw },
        supplyBalances: supplyRaw.map(r => ({ amount: r })),
    };
}

/**
 * @notice Executes a batch of EVM calls via Multicall3 in a single RPC request
 * @dev Internal helper that aggregates multiple contract calls into one multicall transaction
 *      to reduce RPC overhead and improve performance
 * @param runtime - The CRE runtime instance for state management and logging
 * @param evmClient - EVM client instance for chain interactions
 * @param calls - Array of call structures containing:
 *                - target: contract address to call
 *                - allowFailure: whether call failure should be tolerated
 *                - callData: encoded function call data (Hex)
 * @returns Array of result objects, each containing:
 *          - success: boolean indicating if the call succeeded
 *          - returnData: the returned data as Hex
 * 
 * @dev Implementation Details:
 *      - Uses Multicall3's aggregate3 function for atomic batch execution
 *      - Targets the Multicall3 contract at MULTICALL3_ADDRESS
 *      - Executes against the latest block number
 *      - Returns decoded results from the aggregate3 response
 * 
 * @dev Performance:
 *      - Batches N calls into single network request
 *      - Reduces latency compared to sequential calls
 * 
 * @throws Error if the multicall execution fails or returns invalid data
 */
function _executeMulticallPoolData(
    runtime: Runtime<Config>,
    evmClient: EVMClient,
    calls: { target: Address, allowFailure: boolean, callData: Hex }[]
): { success: boolean, returnData: Hex }[] {
    const result = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: MULTICALL3_ADDRESS,
                data: encodeFunctionData({
                    abi: Multicall3,
                    functionName: 'aggregate3',
                    args: [calls],
                }),
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result();

    return [...decodeFunctionResult({
        abi: Multicall3,
        functionName: 'aggregate3',
        data: bytesToHex(result.data),
    })];
}

/**
 * @notice Batch retrieves risk states for multiple positions in a single RPC call
 * @dev Uses Multicall3 to aggregate getRiskState calls to the Liquidator Adapter
 *      for efficient batch querying of borrower health factors
 * @param runtime - The CRE runtime instance for state management and logging
 * @param evmClient - EVM client instance for chain interactions
 * @param evmConfig - Chain-specific configuration containing adapter addresses
 * @param positions - Array of ReadPositionData containing user addresses and protocols
 * @returns Array of RiskState objects containing:
 *          - liquidatable: boolean indicating if position can be liquidated
 *          - riskMetric: health factor in wei scale (1e18 = HF of 1)
 *          - collateralUSD: total collateral value in USD (wei)
 *          - debtUSD: total debt value in USD (wei)
 * 
 * @dev Implementation Details:
 *      - Maps each position to a Multicall3 call structure
 *      - Targets the Liquidator Adapter contract's getRiskState function
 *      - Executes all calls in a single aggregate3 transaction
 *      - Throws if any individual getRiskState call fails
 * 
 * @dev Performance:
 *      - Reduces N RPC calls to 1 for N positions
 *      - Uses allowFailure=true to continue on partial failures
 *      - Total complexity: O(n) where n = number of positions
 * 
 * @example
 * ```typescript
 * const positions = [{ user: "0x123...", protocol: "LIIBORROW_v1" }];
 * const riskStates = _batchGetRiskStates(runtime, client, config, positions);
 * // riskStates[0].liquidatable === true means position is liquidatable
 * ```
 */
function _batchGetRiskStates(
    runtime: Runtime<Config>,
    evmClient: EVMClient,
    evmConfig: EvmConfig,
    positions: ReadPositionData[]
): RiskState[] {
    const calls = positions.map(p => ({
        target: evmConfig.liiBorrowAdapter as Address,
        allowFailure: true,
        callData: encodeFunctionData({
            abi: LiquidatorAdapter,
            functionName: 'getRiskState',
            args: [p.user as Address],
        }),
    }));

    const results = _executeMulticall(runtime, evmClient, calls);

    return results.map((result, i) => {
        if (!result.success) throw new Error(`getRiskState failed for ${positions[i].user}`);
        return decodeFunctionResult({
            abi: LiquidatorAdapter,
            functionName: 'getRiskState',
            data: result.returnData,
        });
    });
}

/**
 * @notice Batch retrieves liquidation data for all liquidatable positions
 * @dev Executes a two-round multicall strategy to gather collateral, liquidation
 *      status, and USDC conversion data efficiently. Round A fetches collateral
 *      and liquidation status, Round B converts debt to USDC amounts.
 * @param runtime - The CRE runtime instance for state management and logging
 * @param evmClient - EVM client instance for chain interactions
 * @param evmConfig - Chain-specific configuration containing protocol and adapter addresses
 * @param liquidatablePositions - Array of ReadPositionData for positions with HF < 1
 * @returns Array of liquidation data tuples containing:
 *          - collaterals: Array of UserSuppliedCollateral with symbol, address, amount, value
 *          - liquidationStatus: LiquidationStatus with maxDebtToCover, actualReturn, expectedReturn, expectedProfit, liquidationBonus
 *          - usdcAmount: BigInt amount of USDC needed to cover the debt
 * 
 * @dev Implementation Details:
 *      Round A (2 calls per position):
 *        1. getUserSuppliedCollateralAmount - Fetches all collateral positions from LiiBorrowV1
 *        2. getLiquidationStatus - Fetches liquidation params from Liquidator Adapter
 *      
 *      Round B (1 call per position):
 *        1. getCollateralAmount - Converts maxDebtToCover to USDC amount
 *      
 * @dev Data Flow:
 *      1. Build Round A calls: collateral + liquidation status for each position
 *      2. Execute Round A multicall (reduces 2N calls to 1)
 *      3. Decode Round A results, extract maxDebtToCover
 *      4. Build Round B calls: USDC amount conversion using maxDebtToCover
 *      5. Execute Round B multicall (reduces N calls to 1)
 *      6. Return combined results from both rounds
 * 
 * @dev Validation:
 *      - Filters collaterals where value >= actualReturn (prevents bad debt)
 *      - Each position requires 3 contract calls total (split into 2 rounds)
 *      - Throws on decode failures but continues on allowFailure calls
 * 
 * @dev Performance:
 *      - Original: 3N RPC calls for N positions
 *      - Optimized: 2 RPC calls total (1 per round)
 *      - Significant gas savings and reduced latency
 * 
 * @example
 * ```typescript
 * const liquidatable = [{ user: "0x123...", collateral: "0xETH..." }];
 * const data = _batchGetLiquidationData(runtime, client, config, liquidatable);
 * // data[0].liquidationStatus.maxDebtToCover === max debt USDC value
 * // data[0].usdcAmount === USDC needed to liquidate
 * ```
 */
function _batchGetLiquidationData(
    runtime: Runtime<Config>,
    evmClient: EVMClient,
    evmConfig: EvmConfig,
    liquidatablePositions: ReadPositionData[]
): { collaterals: readonly UserSuppliedCollateral[], liquidationStatus: LiquidationStatus, usdcAmount: bigint }[] {
    // Build all calls: 3 calls per position [collateral, liquidationStatus, usdcAmount]
    // We don't have maxDebtToCover yet for usdcAmount — so we split into 2 rounds
    // Round A: getUserSuppliedCollateralAmount + getLiquidationStatus
    const callsRoundA = liquidatablePositions.flatMap(p => [
        {
            target: evmConfig.liiBorrowAddress as Address,
            allowFailure: true,
            callData: encodeFunctionData({
                abi: LiiBorrowV1,
                functionName: 'getUserSuppliedCollateralAmount',
                args: [p.user as Address],
            }),
        },
        {
            target: evmConfig.liiBorrowAdapter as Address,
            allowFailure: true,
            callData: encodeFunctionData({
                abi: LiquidatorAdapter,
                functionName: 'getLiquidationStatus',
                args: [p.user as Address, p.collateral as Address],
            }),
        },
    ]);

    const resultsA = _executeMulticall(runtime, evmClient, callsRoundA);

    // Decode round A results (2 results per position)
    const roundADecoded = liquidatablePositions.map((p, i) => {
        const collaterals = decodeFunctionResult({
            abi: LiiBorrowV1,
            functionName: 'getUserSuppliedCollateralAmount',
            data: resultsA[i * 2].returnData,
        });
        const liquidationStatus = decodeFunctionResult({
            abi: LiquidatorAdapter,
            functionName: 'getLiquidationStatus',
            data: resultsA[i * 2 + 1].returnData,
        });
        return { collaterals, liquidationStatus };
    });

    // Round B: getUsdcAmount (now we have maxDebtToCover)
    const callsRoundB = roundADecoded.map(({ liquidationStatus }) => ({
        target: evmConfig.liiBorrowAddress as Address,
        allowFailure: true,
        callData: encodeFunctionData({
            abi: LiiBorrowV1,
            functionName: 'getCollateralAmount',
            args: [USDC, liquidationStatus.maxDebtToCover],
        }),
    }));

    const resultsB = _executeMulticall(runtime, evmClient, callsRoundB);

    return roundADecoded.map(({ collaterals, liquidationStatus }, i) => ({
        collaterals,
        liquidationStatus,
        usdcAmount: decodeFunctionResult({
            abi: LiiBorrowV1,
            functionName: 'getCollateralAmount',
            data: resultsB[i].returnData,
        }),
    }));
}

/**
 * @notice Executes a batch of EVM calls via Multicall3 aggregate3 function
 * @dev Wraps multiple contract calls into a single Multicall3 transaction,
 *      providing atomic execution and reduced RPC overhead. Uses aggregate3
 *      which supports individual call failure handling via allowFailure flag.
 * @param runtime - The CRE runtime instance for contract interaction and logging
 * @param evmClient - EVM client instance configured for the target chain
 * @param calls - Array of Multicall3 call structures containing:
 *                - target: Contract address to call
 *                - allowFailure: Boolean to continue on failure vs revert all
 *                - callData: Encoded function call data (selector + args)
 * @returns Array of result structures containing:
 *          - success: Boolean indicating if call succeeded
 *          - returnData: Bytes data returned from the call (hex encoded)
 * 
 * @dev Technical Details:
 *      - Encodes all calls using Multicall3's aggregate3 function
 *      - Executes as a single view call at latest block number
 *      - Decodes the aggregate3 return data into individual results
 *      - Returns raw bytes requiring downstream decoding via decodeFunctionResult
 * 
 * @dev Error Handling:
 *      - Uses allowFailure=true in calls to handle partial failures gracefully
 *      - Individual call failures result in success=false with empty returnData
 *      - Upstream functions must check success flag before decoding
 * 
 * @dev Gas Optimization:
 *      - Eliminates N sequential RPC round-trips
 *      - Single block lookup for entire batch
 *      - Reduces connection overhead and improves throughput
 * 
 * @dev Chain Compatibility:
 *      - Uses standard Multicall3 at 0xcA11bde05977b3631167028862bE2a173976CA11
 *      - Supported on all EVM-compatible chains (Eth, Polygon, Arbitrum, etc.)
 *      - Block number: LATEST_BLOCK_NUMBER (most recent finalized)
 * 
 * @example
 * ```typescript
 * const calls = [
 *   { target: "0xAdapter...", allowFailure: true, callData: "0x..." },
 *   { target: "0xProtocol...", allowFailure: true, callData: "0x..." }
 * ];
 * const results = _executeMulticall(runtime, client, calls);
 * // results[0].success === true means first call succeeded
 * // results[0].returnData contains the raw return bytes
 * ```
 */
function _executeMulticall(
    runtime: Runtime<Config>,
    evmClient: EVMClient,
    calls: { target: Address, allowFailure: boolean, callData: Hex }[]
): { success: boolean, returnData: Hex }[] {
    const multicallData = encodeFunctionData({
        abi: Multicall3,
        functionName: 'aggregate3',
        args: [calls],
    });

    const result = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: MULTICALL3_ADDRESS,
                data: multicallData,
            }),
            blockNumber: LATEST_BLOCK_NUMBER,
        })
        .result();

    return [...decodeFunctionResult({
        abi: Multicall3,
        functionName: 'aggregate3',
        data: bytesToHex(result.data),
    })];
}

