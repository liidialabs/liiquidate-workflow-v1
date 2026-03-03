/**
 * @title Event ABIs
 * @description ABI definitions for decoding protocol and oracle events
 * @author Liidia Team
 * @version 1.0.0
 */

import { parseAbi } from "viem"

/**
 * @title LiiBorrow Protocol Events
 * @description ABI for decoding user position change events
 * 
 * @dev Events:
 *      - Supply: User deposits collateral
 *      - Withdraw: User removes collateral
 *      - Liquidated: Position was liquidated
 *      - Borrow: User takes out a loan
 *      - RepayUsdc: User repays debt
 */
export const liidiaV1EventAbi = parseAbi([
  "event Supply(address indexed user, address indexed token, uint256 amount)",
  "event Withdraw(address indexed redeemFrom, address indexed redeemTo, address indexed token, uint256 amount)",
  "event Liquidated(address indexed by, address indexed from, address indexed token, uint256 collateralSeized, uint256 debtCovered, uint32 timestamp)",
  "event Borrow(address indexed user, uint256 amount, uint32 timestamp)",
  "event RepayUsdc(address indexed user, uint256 amount, uint32 timestamp)"
])

// ChainLink Price Oracles Event ABI
export const chainlinkPriceOracleEventAbi = parseAbi([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)"
])
