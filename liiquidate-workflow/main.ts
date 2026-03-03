/**
 * @title Liiquidate Workflow
 * @description Chainlink CRE workflow for monitoring and liquidating undercollateralized positions
 *              on the LIIBORROW lending protocol. Monitors user positions, oracle prices, and pool
 *              health to automatically trigger liquidations when positions become unsafe.
 * @author Liidia Team
 * @version 1.0.0
 */

import {
	bytesToHex,
	handler,
	EVMClient,
	type EVMLog,
	getNetwork,
	hexToBase64,
	Runner,
	CronCapability,
	type Runtime,
} from '@chainlink/cre-sdk'
import {
	Address,
	keccak256,
	toBytes,
	decodeEventLog,
	formatUnits,
} from 'viem'
import '../contracts/abi'
import { configSchema, type Config, PositionWriteData, OracleWriteData, ReadPositionData } from "./types"
import './supabase'
import './evm'
import {
	checkIfLiquidatable,
	getRiskStatus,
	isStale,
	ORACLES_MAP,
	supportedAssets,
	ASSET_DATA,
	updatePositions,
	BASE_HF
} from './helper'
import { liidiaV1EventAbi, chainlinkPriceOracleEventAbi } from './eventAbi'
import {
	writePositionsToSupabase,
	readOraclesFromSupabase,
	writeOracleToSupabase,
	readPositionsFromSupabase,
	readUserPositionFromSupabase
} from './supabase'
import {
	liquidatePositions,
	getPoolAccountData,
	getPoolHealthFactor,
	getVariableDebt,
	getSupplyBalance
} from './evm'


/**
 * @notice Handles Liidia V1 protocol events (Supply, Withdraw, Borrow, Repay, Liquidated)
 * @dev Decodes events from the LiiBorrow protocol and updates position risk status in Supabase.
 *      If a position becomes liquidatable (status=0), triggers liquidation via the liquidator.
 * @param runtime - The CRE runtime instance containing config, secrets, and logging
 * @param log - The EVM log containing event data from the LiiBorrow contract
 * @returns A string describing the outcome (liquidation tx hash or database update result)
 * 
 * @dev Event Processing Flow:
 *      1. Decode event (Supply/Withdraw/Liquidated for collateral updates, Borrow/Repay for debt updates)
 *      2. Retrieve or infer user's collateral token
 *      3. Query on-chain for current health factor and risk status
 *      4. If liquidatable (HF < 1.05), attempt liquidation
 *      5. Otherwise, upsert position data to Supabase for monitoring
 * 
 * @dev Status Codes:
 *      - 0 (HOT): Liquidatable, HF < 1.05
 *      - 1 (WARM): At risk, HF <= 1.15
 *      - 2 (COLD): Healthy, HF > 1.15
 */
const onLogTriggerLiidiaV1 = (runtime: Runtime<Config>, log: EVMLog): string => {
	runtime.log('Running Liidia LogTrigger ...')

	// Convert topics and data to hex format for viem
	const topics = log.topics.map((topic) => bytesToHex(topic)) as [Address, ...Address[]]
	const data = bytesToHex(log.data)

	// Decode the event
	const decodedLog = decodeEventLog({
		abi: liidiaV1EventAbi,
		data,
		topics,
	})

	// Protocol Hash
	const protocolName = "LIIBORROW_v1"
	// CurrentChain
	const chain = 0;
	// Data to send to supabase
	const dataToSend: PositionWriteData = {
		user: "",
		protocol: protocolName,
		chain: chain,
		collateral: "",
		hf: "",
		status: 0
	}

	// Normalize events to get user and collateral token

	const SUPPLY_EVENT_MAP = {
		Supply: (args: any) => ({ user: args.user, token: args.token }),
		Withdraw: (args: any) => ({ user: args.redeemFrom, token: args.token }),
		Liquidated: (args: any) => ({ user: args.from, token: args.token }),
	} as const;

	const normalizer1 = SUPPLY_EVENT_MAP[decodedLog.eventName as keyof typeof SUPPLY_EVENT_MAP];
	if (normalizer1) {
		// get user and collateral
		const { user, token } = normalizer1(decodedLog.args)
		runtime.log(`>>> Decoding ${decodedLog.eventName} Event <<<`)
		runtime.log(`- User: ${user}`)
		runtime.log(`- Collateral: ${token}`)
		// get risk status
		const { hf, status } = getRiskStatus(runtime, user, chain)
		runtime.log(`- Health Factor: ${hf}`)
		runtime.log(`- Status: ${status}`)
		// build data to send
		dataToSend.user = user
		dataToSend.collateral = token as string
		dataToSend.hf = hf
		dataToSend.status = status
	}

	// Normalize events to get user for borrow and repay events

	const BORROW_EVENT_MAP = {
		Borrow: (args: any) => args.user,
		RepayUsdc: (args: any) => args.user,
	} as const;

	const normalizer2 = BORROW_EVENT_MAP[decodedLog.eventName as keyof typeof BORROW_EVENT_MAP];
	if (normalizer2) {
		const user = normalizer2(decodedLog.args);
		runtime.log(`>>> Decoding ${decodedLog.eventName} Event <<<`)
		runtime.log(`- User: ${user}`)
		// get supplie collaterals
		const { collateral } = readUserPositionFromSupabase(runtime, user, chain)
		// get risk status
		const { hf, status } = getRiskStatus(runtime, user, chain)
		runtime.log(`- Health Factor: ${hf}`)
		runtime.log(`- Status: ${status}`)
		// build data to send
		dataToSend.user = user
		dataToSend.collateral = collateral as string
		dataToSend.hf = hf
		dataToSend.status = status
	}

	// check if position is liquidatable and if yes liquidate

	if (dataToSend.status === 0 && BigInt(dataToSend.collateral ?? 0) < BASE_HF) {
		// build position data to send
		const positionData: ReadPositionData = {
			user: dataToSend.user,
			protocol: dataToSend.protocol,
			chain: dataToSend.chain,
			collateral: dataToSend.collateral as string
		}
		// confirm user is still liquidatable & build liquidatable position data
		const liquidPositions = checkIfLiquidatable(
			runtime,
			chain,
			[positionData]
		)
		// liquidate position
		if (liquidPositions.length > 0) {
			const txHash = liquidatePositions(runtime, liquidPositions, chain)
			return `- Liquidation Complete: ${txHash}`
		}
	} else {
		// if not liquidatable just insert/update the position data
		const resp = writePositionsToSupabase(runtime, [dataToSend])
		runtime.log(`- Result: ${resp}`)
	}

	return `Updated ${dataToSend.user} position in supabase`
}

/**
 * @notice Handles Chainlink oracle price update events
 * @dev Monitors price feed updates from Chainlink oracles. When price drops for a collateral
 *      asset, checks all HOT positions for that collateral and triggers liquidations if needed.
 * @param runtime - The CRE runtime instance containing config, secrets, and logging
 * @param log - The EVM log containing AnswerUpdated event from Chainlink oracle
 * @returns A string describing the outcome (liquidation tx hashes or "no action" message)
 * 
 * @dev Oracle Trigger Logic:
 *      1. Decode AnswerUpdated event to get new price and timestamp
 *      2. Compare with previous price from Supabase
 *      3. If price DROPPED: fetch all HOT positions for that collateral
 *      4. Batch check each position for liquidation eligibility
 *      5. Execute liquidations in batches of 5 (gas optimization)
 *      6. If price INCREASED or no liquidations: return without action
 * 
 * @dev Batch Limitation:
 *      - Max 5 positions per liquidation tx to manage gas costs
 *      - Multiple txs sent if more than 5 positions need liquidation
 */
const onLogTriggerOracles = (runtime: Runtime<Config>, log: EVMLog): string => {
	runtime.log('Running Oracles LogTrigger')

	// Convert topics and data to hex format for viem
	const topics = log.topics.map((topic) => bytesToHex(topic)) as [Address, ...Address[]]
	const data = bytesToHex(log.data)

	// Decode the event
	const decodedLog = decodeEventLog({
		abi: chainlinkPriceOracleEventAbi,
		data,
		topics,
	})

	runtime.log(`>>> ${decodedLog.eventName} Event <<<`)

	// Protocol Address
	const oracleAddress = bytesToHex(log.address)
	runtime.log(`- oracleAddress: ${oracleAddress}`)
	// collateral
	const collateral = ORACLES_MAP[oracleAddress as string]
	runtime.log(`- collateral: ${collateral}`)
	// CurrentChain 
	const chain = 0
	// decode 
	const { current, updatedAt } = decodedLog.args

	// fetch previous data from 
	const { price } = readOraclesFromSupabase(runtime, collateral)
	runtime.log(`- Previous price: ${price}`)
	runtime.log(`- Current price: ${current}`)

	// check staleness
	// const stale = isStale(BigInt(updatedAt || 0))
	// if(stale) return "Price Is Stale!";

	// update price data in db
	const dataToSend: OracleWriteData = {
		collateral: collateral as Address,
		chain: chain,
		price: current.toString(),
		last_update: updatedAt.toString()
	}
	const resp = writeOracleToSupabase(runtime, dataToSend)
	runtime.log(`- Result: ${resp}`)

	// check if price dropped then check for liquidatable positions
	if (current < BigInt(price || 0)) {
		// fetch positions with hot statuses
		const positions = readPositionsFromSupabase(runtime, collateral)

		// check for empty array
		if (positions.length == 0) return "No Liquidatable Position Found!"

		// check with contract if liquiditable
		const liquidPositions = checkIfLiquidatable(
			runtime,
			chain,
			positions
		)

		// check if positions exist then batch them as 5 and send tx
		if (liquidPositions.length > 0) {
			const txHashes: string[] = [];

			for (let i = 0; i < liquidPositions.length; i += 5) {
				const batch = liquidPositions.slice(i, i + 5);
				const txHash = liquidatePositions(runtime, batch, chain);
				txHashes.push(txHash);
			}

			return `- Liquidation Complete: ${txHashes.join(", ")}`;
		}
	}

	return "No need to check as price increased!"
}

/**
 * @notice Cron job for periodic pool health monitoring and position recalculation
 * @dev Runs on a scheduled interval (configurable via config.evms[0].schedule) to:
 *      1. Log pool-level account data from Aave (collateral, debt, borrowing capacity)
 *      2. Log pool health factor to track overall protocol health
 *      3. Log debt and supply balances for each supported asset
 *      4. Recalculate all position health factors and update Supabase
 * @param runtime - The CRE runtime instance containing config, secrets, and logging
 * @returns A string confirming the update completion
 * 
 * @dev Pool Metrics Logged:
 *      - collateralUSD: Total collateral value in USD
 *      - debtUSD: Total debt value in USD
 *      - canBorrowUSD: Available borrowing power in USD
 *      - canBorrowUSDC: Available borrowing power in USDC
 *      - lltv: Protocol's maximum loan-to-value ratio
 *      - ltv: User's calculated loan-to-value ratio
 *      - healthFactor: Pool's aggregate health factor
 * 
 * @dev Scheduled Execution:
 *      - Interval set by config.evms[0].schedule
 *      - Ensures positions are regularly checked even without event triggers
 */
const onCronTriggerPoolHealth = (runtime: Runtime<Config>,): string => {
	runtime.log("Checking Pool Health")

	// chain
	const chain = 0
	// const HOT = parseEther('1.1')
	// const WARM = parseEther('1.3')
	// const COOL = parseEther('1.5')

	// account data
	const accountData = getPoolAccountData(runtime, chain)
	runtime.log("POOL ACCOUNT DATA")
	runtime.log(">---------------------------------<")
	runtime.log(`collateralUSD: ${accountData.collateralUSD}`)
	runtime.log(`debtUSD: ${accountData.debtUSD}`)
	runtime.log(`canBorrowUSD: ${accountData.canBorrowUSD}`)
	runtime.log(`canBorrowUSDC: ${accountData.canBorrowUSDC}`)
	runtime.log(`lltv: ${accountData.lltv}`)
	runtime.log(`ltv: ${accountData.ltv}`)
	runtime.log("_______________________________________")

	// health factor
	const hf = getPoolHealthFactor(runtime, chain)
	runtime.log("POOL HEALTH FACTOR")
	runtime.log(">---------------------------------<")
	runtime.log(`health factor: ${formatUnits(hf.healthFactor, 18)}`)
	runtime.log(`status: ${hf.status}`)
	runtime.log("_______________________________________")

	// Debt & Supply Balances
	runtime.log(" SUPPLY ")
	runtime.log(">---------------------------------<")
	const assetInfo = ASSET_DATA['USDC']
	const variableDebt = getVariableDebt(runtime, chain, assetInfo.address as Address)
	runtime.log(`> USDC: ${formatUnits(variableDebt.amount, assetInfo.decimals)}`)
	runtime.log("_______________________________________")

	runtime.log(" DEBT ")
	runtime.log(">---------------------------------<")
	for (let i = 0; i < supportedAssets.length; i++) {
		const assetInfo = ASSET_DATA[supportedAssets[i]]
		const supplyAmount = getSupplyBalance(runtime, chain, assetInfo.address as Address)
		runtime.log(` > ${supportedAssets[i]}: ${formatUnits(supplyAmount.amount, assetInfo.decimals)}`)
	}

	// Recalculate Positions
	updatePositions(runtime)

	return "Updation Complete!"
}

/**
 * @notice Initializes the CRE workflow with event triggers and cron jobs
 * @dev Sets up three main trigger sources:
 *      1. Log trigger for LiiBorrow protocol events (Supply, Withdraw, Borrow, Repay, Liquidated)
 *      2. Log trigger for Chainlink oracle price updates (AnswerUpdated)
 *      3. Cron trigger for periodic pool health monitoring
 * @param config - The validated workflow configuration from config.json
 * @returns An array of handler configurations for the CRE runner
 * 
 * @dev Event Signatures Registered:
 *      - Supply(address,address,uint256)
 *      - Withdraw(address,address,address,uint256)
 *      - Liquidated(address,address,address,uint256,uint256,uint32)
 *      - Borrow(address,uint256,uint32)
 *      - RepayUsdc(address,uint256,uint32)
 *      - AnswerUpdated(int256,uint256,uint256)
 * 
 * @dev Trigger Addresses:
 *      - LiiBorrow: config.evms[0].liiBorrowAddress
 *      - Oracles: WETH/USD and WBTC/USD Chainlink price feeds
 */
const initWorkflow = (config: Config) => {
	// Cron
	const cron = new CronCapability()

	// Get network details
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: config.evms[0].chainSelectorName,
		isTestnet: true,
	})

	if (!network) {
		throw new Error(
			`Network not found for chain selector name: ${config.evms[0].chainSelectorName}`,
		)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)

	// Liidia Events Signature Hash

	const supplyEventHash = keccak256(toBytes("Supply(address,address,uint256)"))
	const withdrawEventHash = keccak256(toBytes("Withdraw(address,address,address,uint256)"))
	const liquidatedEventHash = keccak256(toBytes("Liquidated(address,address,address,uint256,uint256,uint32)"))
	const borrowEventHash = keccak256(toBytes("Borrow(address,uint256,uint32)"))
	const repayUsdcEventHash = keccak256(toBytes("RepayUsdc(address,uint256,uint32)"))

	// ChainLink Price Oracle Events Signature Hash

	const answerUpdatedEventHash = keccak256(toBytes("AnswerUpdated(int256,uint256,uint256)"))

	return [
		// Listen to Liidia Events
		handler(
			evmClient.logTrigger({
				addresses: [hexToBase64(config.evms[0].liiBorrowAddress)],
				topics: [
					{
						values: [
							hexToBase64(supplyEventHash),
							hexToBase64(withdrawEventHash),
							hexToBase64(liquidatedEventHash),
							hexToBase64(borrowEventHash),
							hexToBase64(repayUsdcEventHash)
						]
					},
				],
				confidence: "CONFIDENCE_LEVEL_FINALIZED"
			}),
			onLogTriggerLiidiaV1,
		),
		// Listen to Price Oracles Price Changes
		handler(
			evmClient.logTrigger({
				addresses: [
					hexToBase64(config.evms[0].WethUsdPriceOracle),
					hexToBase64(config.evms[0].WbtcUsdPriceOracle)
				],
				topics: [{
					values: [hexToBase64(answerUpdatedEventHash)]
				}],
				confidence: "CONFIDENCE_LEVEL_FINALIZED"
			}),
			onLogTriggerOracles,
		),
		// Check for Pool Health every 
		handler(
			cron.trigger(
				{ schedule: config.evms[0].schedule } // Runs every 1 min
			),
			onCronTriggerPoolHealth
		)
	]
}

/**
 * @notice Entry point for the Liiquidate CRE workflow
 * @dev Initializes the CRE Runner with configuration validation and starts the workflow.
 *      The runner will:
 *      1. Load and validate config.json against the configSchema
 *      2. Initialize event triggers and cron jobs via initWorkflow
 *      3. Begin listening for EVM events and cron schedules
 *      4. Execute corresponding handlers when triggers fire
 * @returns A Promise that resolves when the runner completes (typically never for long-running workflows)
 * 
 * @dev Configuration Requirements:
 *      - At least one EVM chain configuration required
 *      - Must include: liiBorrowAddress, liiBorrowAdapter, proxyAddress, AaveAddress
 *      - Chainlink oracle addresses for WETH/USD and WBTC/USD
 *      - Cron schedule string for periodic health checks
 *      - Gas limit for liquidation transactions
 */
export async function main() {
	const runner = await Runner.newRunner<Config>({
		configSchema,
	})
	await runner.run(initWorkflow)
}
