import {PrepareWriteOutput, Config, LiquidatablePositions, ReadPositionData} from './types'
import { getCurrentPosition, getUserCollateral, getLiquidationStatus, getUsdcAmount } from './evm'
import { Runtime } from '@chainlink/cre-sdk'
import { parseEther, Address } from 'viem'

const HOT_HF = parseEther("1.05")
const WARM_HF = parseEther("1.15")
const STALENESS_THRESHOLD = 3600n

export const USDC: Address = '0xf8340a3BB21282Af32B567e0ACE1Cc5c4eF63a73'

// Map oracle to asset
export const ORACLES_MAP: Record<Address, Address> = {
  "0xaeEffddcC3095DC4037D58B654a371b7Ff679F30": "0x394A1145Cc4480cD047ad065a5Ece23D4fcC2E1d", // WETH/USD
}

// Map protocol name to protocol address
export const HASH_MAP: Record<string, Address> = {
  "LIIBORROW_v1": "0x3f26685991D09eCd40227Efb7649Ca2A371708CC",
}

// should return [user, collateral, hf & status
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

// check for price staleness
export function isStale(last: bigint): boolean {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return now - last > STALENESS_THRESHOLD;
}

// get liquidatable positions
export function checkIfLiquidatable(
    runtime: Runtime<Config>, 
    chain: number, 
    positions: ReadPositionData[]
): LiquidatablePositions[] {
    runtime.log(">>> Checking for liquidatable positions.")

    // array to hold liquidatable positions
    const validPositions:LiquidatablePositions[] = []

    for(let i = 0; i < positions.length; i++) {
        // check if user is liquid
        const { liquidatable } = getCurrentPosition(
            runtime, 
            positions[i].user as Address, 
            chain
        )
        if(!liquidatable) continue

        // collaterals supplied
        const allCollateralSupply = getUserCollateral(runtime, positions[i].user as Address, chain)

        // get max debt to cover and the minimum return after liquidation
        const { maxDebtToCover, actualReturn } = getLiquidationStatus(
            runtime, 
            positions[i].user as Address, 
            positions[i].collateral as Address, 
            chain
        )

        // get USDC amount from USD max to cover
        const usdcAmount = getUsdcAmount(runtime, maxDebtToCover, chain)

        // value of collateral to size should be => actual return
        for(let j = 0; j < allCollateralSupply.length; j++) {
            // Skip if less collateral value
            if(allCollateralSupply[j].value < actualReturn) continue

            const position: LiquidatablePositions = {
                protocol: positions[i].protocol as string,
                user: positions[i].user as Address,
                collateralAsset: allCollateralSupply[j].collateral,
                debtAsset: USDC,
                debtToCover: usdcAmount
            }

            runtime.log(`Protocol: ${position.protocol}, User: ${position.user}, Collateral: ${position.collateralAsset} Debt: ${position.debtAsset}, DebtoCover: ${position.debtToCover}`)

            validPositions.push(position)
        }
    }

    return validPositions
}