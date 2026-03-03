/**
 * @title Type Definitions & Configuration Schemas
 * @description Zod schemas for configuration validation and TypeScript types
 *              for positions, oracles, liquidation data, and contract responses.
 * @author Liidia Team
 * @version 1.0.0
 */

// types.ts
// Type definitions and schemas for the prediction market settlement workflow.
// Includes configuration validation, Gemini API types, and Firestore data structures.

import { z } from "zod";
import { Address } from "viem";

/*********************************
 * Configuration Schemas
 *********************************/

/**
 * Schema for individual EVM chain configuration.
 * Validates chain selector name, market contract address, and gas limit.
 */
const evmConfigSchema = z.object({
  schedule: z.string(),
  WethUsdPriceOracle: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "WethUsdPriceOracle must be a 0x-prefixed 20-byte hex"),
  WbtcUsdPriceOracle: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "WbtcUsdPriceOracle must be a 0x-prefixed 20-byte hex"),
  proxyAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "proxyAddress must be a 0x-prefixed 20-byte hex"),
  AaveAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "AaveAddress must be a 0x-prefixed 20-byte hex"),
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

/**  */
export type EvmConfig = Config["evms"][0]

/* ----------------------------------------------------------------------- */

/**
 * @title Data Types for Liquidation Operations
 * @description Core type definitions for positions, risk assessment, and database operations
 */

/**
 * @notice Represents a position ready for liquidation
 * @description Used when submitting liquidation reports to the Liiquidate contract
 */
export type LiquidatablePositions = {
  /** Protocol identifier (e.g., "LIIBORROW_v1") */
  protocol: string;
  /** Borrower's wallet address */
  user: Address;
  /** Collateral token address to seize */
  collateralAsset: Address;
  /** Debt token address (USDC) */
  debtAsset: Address;
  /** Amount of debt to cover in debtAsset tokens */
  debtToCover: bigint;
}

/**
 * @notice ABI-encoded tuple for liquidation report
 */
export type LiquidatablePositionsTuple = {
  protocol: string;
  user: Address;
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
};

/**
 * @notice Risk state of a user's position
 */
export type RiskState = {
  /** Whether position can be liquidated */
  liquidatable: boolean;
  /** Health factor or risk metric (1e18 = HF of 1) */
  riskMetric: bigint;
  /** Total collateral value in USD (wei) */
  collateralUSD: bigint;
  /** Total debt value in USD (wei) */
  debtUSD: bigint;
}

/**
 * @notice Liquidation calculation result from Liquidator Adapter
 */
export type LiquidationStatus = {
  /** Maximum debt that can be covered (in USD wei) */
  maxDebtToCover: bigint;
  /** Actual collateral return after liquidation */
  actualReturn: bigint;
  /** Expected collateral return */
  expectedReturn: bigint;
  /** Expected profit from liquidation */
  expectedProfit: bigint;
  /** Liquidation bonus in basis points (bps) */
  liquidationBonus: bigint;
}

/**
 * @notice Single collateral position supplied by a user
 */
export type UserSuppliedCollateral = {
  /** Token symbol (e.g., "WETH") */
  symbol: string;
  /** Token contract address */
  collateral: Address;
  /** Raw token amount supplied */
  amount: bigint;
  /** USD value of the collateral */
  value: bigint;
}

/**
 * @notice Health factor and status for database write
 */
export type PrepareWriteOutput = {
  /** Health factor as string (wei scale) */
  hf: string;
  /** Risk status: 0=HOT, 1=WARM, 2=COLD */
  status: 0 | 1 | 2;
}

/**
 * @title Database Data Types
 * @description Types for Supabase read/write operations
 */

/** Position data for writing to database */
export type PositionWriteData = {
  user: string;
  protocol: string;
  chain: number;
  collateral?: string;
  hf: string;
  status: 0 | 1 | 2;
}

/** Position data read from database */
export type ReadPositionData = {
  user?: string;
  protocol?: string;
  chain?: number;
  collateral: string;
}

/** Oracle data for writing to database */
export type OracleWriteData = {
  collateral: string;
  chain: number;
  price: string;
  last_update: string;
}

/** Oracle data read from database */
export type ReadOracleData = {
  price: string;
  last_update: string;
}

/** Oracle write response from database */
export type WriteResponse = {
  id: number;
}

/** Asset configuration information */
export type AssetInfo = {
  /** Token contract address */
  address: string;
  /** Token decimal places */
  decimals: number;
};

/**
 * @title Pool Data Types
 * @description Types for Aave V3 pool-level queries
 */

/** Pool account data from Aave V3 */
export type PoolAccountData = {
  /** Total collateral in USD (wei) */
  collateralUSD: bigint;
  /** Total debt in USD (wei) */
  debtUSD: bigint;
  /** Available to borrow in USD (wei) */
  canBorrowUSD: bigint;
  /** Available to borrow in USDC (wei) */
  canBorrowUSDC: bigint;
  /** Protocol maximum loan-to-value ratio */
  lltv: bigint;
  /** Current loan-to-value ratio */
  ltv: bigint
}

/** Pool health factor result */
export type HealthFactor = {
  /** Health factor (1e18 = HF of 1) */
  healthFactor: bigint,
  /** Risk status: 0=<1, 1=<=1.1, 2=>1.1 */
  status: number
}

/** Aave token balance result */
export type AaveAmount = {
  /** Token amount in raw units */
  amount: bigint
}