// types.ts
// Type definitions and schemas for the prediction market settlement workflow.
// Includes configuration validation, Gemini API types, and Firestore data structures.

import { z } from "zod";
import { Abi , Address } from "viem";

/*********************************
 * Configuration Schemas
 *********************************/

/**
 * Schema for individual EVM chain configuration.
 * Validates chain selector name, market contract address, and gas limit.
 */
const evmConfigSchema = z.object({
  WethUsdPriceOracle: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "WethUsdPriceOracle must be a 0x-prefixed 20-byte hex"),
  WbtcUsdPriceOracle: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "WbtcUsdPriceOracle must be a 0x-prefixed 20-byte hex"),
  proxyAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "proxyAddress must be a 0x-prefixed 20-byte hex"),
  liiBorrowAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "liiBorrowAddress must be a 0x-prefixed 20-byte hex"),
  liiBorrowAdapter: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "liiBorrowAdapter must be a 0x-prefixed 20-byte hex"),
  chainSelectorName: z
    .string()
    .min(1),
  gasLimit: z
    .string()
    .regex(/^\d+$/, "gasLimit must be a numeric string")
    .refine(val => Number(val) > 0, { message: "gasLimit must be greater than 0" }),
});

/**
 * Schema for the main workflow configuration file (config.json).
 * Validates Gemini model name and array of EVM configurations.
 */
export const configSchema = z.object({
  evms: z.array(evmConfigSchema).min(1, "At least one EVM config is required"),
});

/** Type inferred from the validated config schema. */
export type Config = z.infer<typeof configSchema>;

/* ----------------------------------------------------------------------- */

export type LiquidatablePositions = {
  protocol: string;
  user: Address;
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
}

// export type LiquidatablePositionsTuple = readonly [
//   string,
//   Address,
//   Address,
//   Address,
//   bigint
// ];

export type LiquidatablePositionsTuple = {
  protocol: string;
  user: Address;
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
};

export type RiskState = {
  liquidatable: boolean;
  riskMetric: bigint; // HF, LLTV breach, shortfall (normalized)
  collateralUSD: bigint;
  debtUSD: bigint;
}

export type LiquidationStatus = {
  maxDebtToCover: bigint; // In USD
  actualReturn: bigint;
  expectedReturn: bigint;
  expectedProfit: bigint;
  liquidationBonus: bigint; // bps
}

export type UserSuppliedCollateral = {
  symbol: string;
  collateral: Address;
  amount: bigint;
  value: bigint;
}

export type PrepareWriteOutput = {
  hf: string;
  status: 0 | 1 | 2;
}

// Position data to send
export type PositionWriteData = {
  user: string;
  protocol: string;
  chain: number;
  collateral?: string;
  hf: string;
  status: 0 | 1 | 2;
}

// Position data to send
export type ReadPositionData = {
  user?: string;
  protocol?: string;
  chain?: number;
  collateral: string;
}

// Oracle data to send
export type OracleWriteData = {
  collateral: string;
  price: string;
  last_update: string;
}

// Oracle data to read
export type ReadOracleData = {
  price: string;
  last_update: string;
}

// Oracle write Response
export type WriteResponse = {
  id: number;
}