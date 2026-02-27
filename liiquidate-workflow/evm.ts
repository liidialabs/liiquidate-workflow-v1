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
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER
} from "@chainlink/cre-sdk";
import {
    encodeAbiParameters, 
    parseAbiParameters, 
    type Address, 
    decodeFunctionResult, 
    encodeFunctionData, 
    zeroAddress
} from "viem";
import type { 
    Config, 
    LiquidatablePositions, 
    LiquidatablePositionsTuple, 
    RiskState, 
    LiquidationStatus,
    UserSuppliedCollateral
} from "./types";
import { LiiBorrowV1, LiquidatorAdapter } from "../contracts/abi";
import { USDC } from "./helper"

/* -------------------------------------- */

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

/*********************************
 * Helper Functions
 *********************************/

// ----
const _makeReportData = (reports: LiquidatablePositions[]) =>
    encodeAbiParameters(
        parseAbiParameters("(string protocol,address user,address collateralAsset,address debtAsset,uint256 debtToCover)[]"),
        [
            reports.map((r): LiquidatablePositionsTuple => ({
                protocol: r.protocol,
                user: r.user as Address,
                collateralAsset: r.collateralAsset as Address,
                debtAsset: r.debtAsset as Address,
                debtToCover: r.debtToCover,
            }))
        ]
    );

// Option B — reorder TypeScript encoding to put protocol last
const makeReportData = (reports: LiquidatablePositions[]) =>
    encodeAbiParameters(
        [
            {
                type: 'tuple[]',
                components: [
                    { name: 'user',            type: 'address' },
                    { name: 'collateralAsset', type: 'address' },
                    { name: 'debtAsset',       type: 'address' },
                    { name: 'debtToCover',     type: 'uint256' },
                    { name: 'protocol',        type: 'string'  }, // ← last
                ],
            },
        ],
        [
            reports.map((r) => ({
                user:            r.user as Address,
                collateralAsset: r.collateralAsset as Address,
                debtAsset:       r.debtAsset as Address,
                debtToCover:     r.debtToCover,
                protocol:        r.protocol,
            })),
        ]
    );