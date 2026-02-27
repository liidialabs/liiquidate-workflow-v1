import { parseAbi } from "viem"

// Liidia V1 Event ABI
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
