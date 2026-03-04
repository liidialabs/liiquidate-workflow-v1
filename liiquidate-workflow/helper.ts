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
    EvmConfig
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
import { LiquidatorAdapter, LiiBorrowV1, Multicall3 } from '../contracts/abi'

// Constants
export const BASE_HF = parseEther("1")
export const HOT_HF = parseEther("1.05")
export const WARM_HF = parseEther("1.15")
const STALENESS_THRESHOLD = 3600n

// Debt Asset
export const USDC: Address = '0x23256311E41354c00E880D5b923A64552f077FD3'
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Map oracle to asset
export const ORACLES_MAP: Record<string, string> = {
  "0x82a9d607cc8df65af2910e04211ebd7e989f5379": "0x6de4964bfEbCa1848c74FeaA6736b14898DfDB0c", // WETH/USD
} as const

// Map protocol name to protocol address
export const HASH_MAP: Record<string, Address> = {
  LIIBORROW_v1: "0xFB56BcBB16eF411Ad25EE507d7c2430e561ae3E0",
} as const

// Supported Assets
export const supportedAssets: Array<string> = ['WETH'] 

// Map asset name to its address
export const ASSET_DATA: Record<string, AssetInfo> = {
    WETH: {
        address: "0x6de4964bfEbCa1848c74FeaA6736b14898DfDB0c",
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
 *      - WARM (1): HF <= 1.15 - Monitor closely
 *      - COLD (2): HF > 1.15 - Healthy
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
    if(riskMetric < HOT_HF)
        status = 0; // HOT - Should be liquidated
    else if(riskMetric <= WARM_HF)
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
        isTestnet: true,
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

// ── Step 1: Batch getRiskState for ALL positions (1 RPC call) ──
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

// ─── Step 2: Batch collateral + liquidation + usdc for liquidatable positions ─
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

// ─── Multicall3 helper ──
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

// ─── Main function ──
