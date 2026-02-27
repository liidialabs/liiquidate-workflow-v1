import {
	bytesToHex,
	handler,
	EVMClient,
	type EVMLog,
	getNetwork,
	hexToBase64,
	Runner,
	type Runtime,
} from '@chainlink/cre-sdk'
import { 
	Address, 
	keccak256, 
	toBytes, 
	decodeEventLog
} from 'viem'
import '../contracts/abi'
import { configSchema, type Config, PositionWriteData, OracleWriteData, LiquidatablePositions, ReadPositionData } from "./types"
import './supabase'
import './evm'
import { checkIfLiquidatable, getRiskStatus, isStale, ORACLES_MAP } from './helper'
import { liidiaV1EventAbi, chainlinkPriceOracleEventAbi } from './eventAbi'
import { 
	writePositionToSupabase, 
	readOraclesFromSupabase, 
	writeOracleToSupabase, 
	readPositionFromSupabase,
	readUserPositionFromSupabase
} from './supabase'
import { liquidatePositions, getCurrentPosition } from './evm'


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

	if(dataToSend.status === 0) {
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
		if(liquidPositions.length > 0) {
			const txHash = liquidatePositions(runtime, liquidPositions, chain)
			return `- Liquidation Complete: ${txHash}`
		}
	} else {
		// if not liquidatable just insert/update the position data
		const resp = writePositionToSupabase(runtime, dataToSend)
		runtime.log(`- Result: ${resp}`)
	}

	return `Updated ${dataToSend.user} position in supabase`
}

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

	runtime.log(`Event name: ${decodedLog.eventName}`)

	// Protocol Address
	const oracleAddress = bytesToHex(log.address)
	// collateral
	const collateral = ORACLES_MAP[oracleAddress]
	// CurrentChain
	const chain = 0
	// decode 
	const { current, updatedAt } = decodedLog.args

	// fetch previous data from 
	const filter =  `collateral=eq.${collateral}`
	const { price } = readOraclesFromSupabase(runtime, filter)

	// check staleness
	const stale = isStale(BigInt(updatedAt || 0))
	if(stale) return "";

	// update price data in db
	const dataToSend: OracleWriteData = {
		collateral: oracleAddress,
		price: current.toString(),
		last_update: updatedAt.toString()
	}
	writeOracleToSupabase(runtime, dataToSend)

	// check if price dropped then check for liquidatable positions
	if(current < BigInt(price || 0)) {
		// fetch positions with hot statuses
		const filter =  `status=eq.0&collateral=eq.${collateral}`
		const positions = readPositionFromSupabase(runtime, filter)

		// check with contract if liquiditable
		const liquidPositions = checkIfLiquidatable(
			runtime, 
			chain, 
			positions
		)

		runtime.log('Liquidating Positions!')
		const txHash = liquidatePositions(runtime, liquidPositions, chain)

		return `Liquidation Complete: ${txHash}`
	}

	return "No need to check as price incresed!"
}

const initWorkflow = (config: Config) => {
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
					{ values: [
						hexToBase64(supplyEventHash),
						hexToBase64(withdrawEventHash),
						hexToBase64(liquidatedEventHash),
						hexToBase64(borrowEventHash),
						hexToBase64(repayUsdcEventHash)
					] },
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
				}]
			}),
			onLogTriggerOracles,
		),
	]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({
		configSchema,
	})
	await runner.run(initWorkflow)
}
