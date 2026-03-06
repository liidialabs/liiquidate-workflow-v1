# Liiquidate Workflow

A Chainlink CRE (Chainlink Runtime Environment) workflow for automated liquidation detection and execution on LiiBorrow lending protocol.

## Overview

Liiquidate-flow is a proof-of-reserve style workflow that monitors borrower positions in LiiBorrow, identifies undercollateralized positions eligible for liquidation, and prepares the necessary data for liquidation execution. The workflow leverages Chainlink's CRE framework to run as an off-chain automation service that queries on-chain state, performs risk assessment, and outputs actionable liquidation candidates.

## What It Does

### Core Functionality

1. **Position Monitoring**
   - Reads borrower positions from a Supabase database
   - Groups positions by chain for multi-chain support
   - Queries current health factors via on-chain contracts

2. **Risk Assessment**
   - Evaluates each position's health factor (HF)
   - Categorizes positions into risk tiers:
     - **HOT (0)**: HF < 1.05 — closely monitored
     - **WARM (1)**: 1.05 ≤ HF ≤ 1.10 — standard monitoring 
     - **COLD (2)**: HF > 1.10 — healthy, no action needed

3. **Liquidation Detection**
   - Filters positions where HF < 1 (undercollateralized)
   - Fetches user's supplied collateral positions
   - Calculates liquidation parameters (max debt to cover, expected return)
   - Validates that collateral value ≥ expected return

4. **Liquidation Execution**
   - When liquidatable positions are detected, they are passed to `liquidatePositions()`
   - Encodes liquidation report data with user, collateral, debt, and protocol info
   - Signs the report using CRE's ECDSA signing with keccak256 hashing
   - Submits signed report to the Liiquidate Consumer contract via `onReport()`
   - The Liiquidate contract executes the actual liquidation on-chain

5. **Batch Processing**
   - Uses Multicall3 for efficient RPC aggregation
   - Reduces N+1 query problems to constant-time batch calls
   - Single database upsert for all position updates

### Supported Assets

- **WETH** (Wrapped Ether) — Primary collateral asset
- **WBTC** (Wrapped Bitcoin) — collateral asset
- **USDC** — Debt asset for all borrowings

### Architecture

```
┌─────────────────┐      ┌──────────────────┐     ┌────────────────────────────────────────────┐
│   Supabase DB   │────▶│  CRE Workflow    │────▶│   Read Contracts                           │
│ (Position Store)│      │ (Risk Assessment)│     │ (LiiBorrowV1 + LiiBorrowAdapter + Aave)    │
└─────────────────┘      └──────────────────┘     └────────────────────────────────────────────┘
        │                        │                        │
        │ read positions         │ batch query HF         │
        │───────────────────────▶───────────────────────▶│
        │                        │                        │
        │ batch write updates    │ updated positions      │
        │◀──────────────────────◀────────────────────────┤
                                 │
                                 │
               ┌────────────────────────────────────┐
               │  check for liquidatable positions  │
               │  from listening to price and user  │
               │  interaction events                │
               └────────────────────────────────────┘
                                │                        
                                ▼                        
                  ┌────────────────────────┐      ┌──────────────────┐     ┌─────────────────────────┐
                  │ Liquidatable Positions │────▶│  writeReport     │────▶│ Liiquidate Consumer     │
                  │ (encode + sign)        │      │ (submit signed)  │     │ (on-chain execution)    │
                  └────────────────────────┘      └──────────────────┘     └─────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `helper.ts` | Core utilities: batch risk queries, liquidation checks, Multicall3 execution |
| `evm.ts` | EVM client setup and chain interaction helpers |
| `supabase.ts` | Database read/write operations for position data |
| `types.ts` | TypeScript type definitions and Zod validation schemas |
| `main.ts` | Workflow entry point and trigger handlers |

### Technology Stack

- **Chainlink CRE**: Off-chain automation runtime
- **TypeScript**: Type-safe contract interactions
- **Viem**: Ethereum ABI encoding/decoding
- **Supabase**: Position data persistence
- **Multicall3**: Batch contract calls for gas efficiency
- **Tenderly**: Virtual TestNet for Mainnet simulations

## Getting Started

### Prerequisites

- Bun runtime
- Chainlink CRE CLI (`cre`)
- Access to an EVM testnet, mainnet or virtual testnet (`RPC_URL`)
- Supabase project for position storage

### Configuration

1. Copy `.env.example` to `.env` and configure:
   - `CRE_ETH_PRIVATE_KEY`: Wallet private key (dummy key for read-only workflows)
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase anonymous key

2. Update `project.yaml` with your RPC endpoints and chain configuration

3. Configure liquidation thresholds in `helper.ts`:
   - `BASE_HF`: Base health factor (1.0)
   - `HOT_HF`: Hot threshold (1.05)
   - `WARM_HF`: Warm threshold (1.10)

4. Configure supabase REST URL in `supabase.ts`:
   - `BASE_URL`: Your Supabase project REST URL

### Running the Workflow

```bash
# Set up environment variables
cp .env.example .env
# Edit .env with your private keys and RPC URLs

# Install dependencies
cd liiquidate-workflow && bun install

# Simulate 
make simulate

# Simulate with broadcast
make simulate-bc
```

## Database Schema

This project uses two Supabase tables to store position and oracle data.

### Tables

#### `oracles`

Stores collateral token price data. Used to validate that liquidation returns are sufficient.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigint` | PK, auto-generated | Primary key |
| `collateral` | `text` | unique, check (42 chars, 0x... format) | Token contract address (ERC-20) |
| `price` | `text` | nullable | Current price of collateral (as string for precision) |
| `last_update` | `text` | not null | Timestamp of last price update |
| `chain` | `bigint` | default 0 | Index of the evm config being used |

#### `positions`

Stores borrower positions with their risk status. Updated by the workflow after each health factor check.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigint` | PK, auto-generated | Primary key |
| `user` | `text` | unique index, check (42 chars, 0x... format) | Borrower's wallet address |
| `protocol` | `text` | not null | Protocol identifier (e.g., "liiborrow") |
| `chain` | `bigint` | not null | Index of the evm config being used |
| `collateral` | `text` | not null, FK → oracles(collateral) | Collateral token address |
| `hf` | `text` | nullable | Current health factor (as string) |
| `status` | `smallint` | nullable, check (0-2) | Risk status: 0=HOT, 1=WARM, 2=COLD |
| `updated_at` | `timestamptz` | not null, auto-updated | Last update timestamp |

**Unique Constraint:** `("user", protocol, chain, collateral)` — one position per user per protocol per chain per collateral.

**Status Values:**
- `0` (HOT): Health factor < 1.05, needs close monitoring
- `1` (WARM): Health factor between 1.05-1.10, standard monitoring
- `2` (COLD): Health factor > 1.10, healthy position

### SQL Setup

```sql
-- Create oracles table
create table public.oracles (
  id bigint generated by default as identity not null,
  collateral text not null,
  price text null,
  last_update text not null,
  chain bigint not null default '0'::bigint,
  constraint oracles_pkey primary key (id),
  constraint oracles_token_key unique (collateral),
  constraint oracles_unique unique (collateral, chain),
  constraint oracles_token_check check (
    (length(collateral) = 42) and (collateral ~ '^0x[a-fA-F0-9]{40}$'::text)
  )
);

-- Create positions table
create table public.positions (
  id bigint generated by default as identity not null,
  "user" text not null,
  protocol text not null,
  chain bigint not null,
  collateral text not null,
  hf text null,
  status smallint null,
  updated_at timestamp with time zone not null default now(),
  constraint positions_pkey primary key (id),
  constraint positions_unique unique ("user", protocol, chain, collateral),
  constraint positions_collateral_fkey foreign key (collateral) references oracles (collateral),
  constraint positions_collateral_check check (
    (length(collateral) = 42) and (collateral ~ '^0x[a-fA-F0-9]{40}$'::text)
  ),
  constraint positions_status_check check ((status >= 0) and (status < 3)),
  constraint positions_user_check check (
    (length("user") = 42) and ("user" ~ '^0x[a-fA-F0-9]{40}$'::text)
  )
);

-- enable RLS
ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "oracles" ENABLE ROW LEVEL SECURITY;

-- backend (workflow) can do everything
CREATE POLICY "backend_full_access" ON "positions"
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "backend_full_access" ON "oracles"
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for fast lookups
create unique index if not exists unique_position_index
  on public.positions using btree ("user", protocol, chain, collateral);

-- Create set_updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger to auto-update updated_at (requires extension)
create trigger trigger_set_updated_at
  before update on positions for each row
  execute function set_updated_at();
```

## Risk Categories

The workflow implements a three-tier risk classification system:

| Status | Code | Health Factor | Action |
|--------|------|----------------|--------|
| HOT | 0 | HF < 1.05 | Monitor Closely |
| WARM | 1 | 1.05 ≤ HF ≤ 1.10 | Standard Monitoring |
| COLD | 2 | HF > 1.10 | No action |

## Contract Interactions

The workflow interacts with three contract types:

### Read Contracts (Data Queries)

1. **LiiBorrowV1**: Core lending protocol
   - `getUserSuppliedCollateralAmount(user)`: Returns user's collateral positions
   - `getCollateralAmount(debtAsset, amount)`: Converts debt to collateral amount

2. **LiquidatorAdapter**: Risk assessment and liquidation helper
   - `getRiskState(user)`: Returns health factor and collateral/debt values
   - `getLiquidationStatus(user, collateral)`: Calculates liquidation parameters

### Write Contract (Liquidation Execution)

3. **Liiquidate Consumer Contract** (`proxyAddress`): Executes liquidations on-chain
   - `onReport(report)`: Receives signed liquidation reports and executes liquidations
   - The workflow signs reports using ECDSA/keccak256 and submits via `writeReport()`

### Execution Flow

```
┌─────────────────────┐     ┌──────────────────────┐     ┌────────────────────────┐
│   Risk Assessment   │────▶│  liquidatePositions │────▶│ Liiquidate Consumer    │
│ (HF < 1, valid coll)│     │ (encode + sign)      │     │ Contract (onReport)    │
└─────────────────────┘     └──────────────────────┘     └────────────────────────┘
                                  │                                │
                                  │ sign (ECDSA/keccak256)         │ execute
                                  ▼                                ▼
                           ┌──────────────────────┐      ┌────────────────────────┐
                           │ writeReport (submit) │────▶│ On-chain liquidation   │
                           └──────────────────────┘      └────────────────────────┘
```

### Report Data Structure

When executing liquidations, the workflow submits a report containing:

| Field | Type | Description |
|-------|------|-------------|
| `user` | address | Borrower's wallet address |
| `collateralAsset` | address | Collateral token to seize |
| `debtAsset` | address | Debt token (USDC) |
| `debtToCover` | uint256 | Amount of debt to cover |
| `protocol` | string | Protocol identifier |

## License

MIT
