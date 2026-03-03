import {
  ok,
  HTTPClient,
  type HTTPSendRequester,
  type Runtime,
  consensusIdenticalAggregation
} from '@chainlink/cre-sdk'
import '../contracts/abi'
import { type Config, PositionWriteData, ReadPositionData, OracleWriteData, ReadOracleData, WriteResponse } from "./types";

/**
 * @title Supabase Database Operations
 * @description Module for reading and writing position and oracle data to Supabase.
 *              Handles all database interactions for position tracking, oracle prices,
 *              and liquidation queue management.
 * @author Liidia Team
 * @version 1.0.0
 */

const BASE_POSITION_URL = 'https://elyzpintovurrcxcrumg.supabase.co/rest/v1/positions'
const BASE_ORACLE_URL = 'https://elyzpintovurrcxcrumg.supabase.co/rest/v1/oracles'

/**
 * @title Position Write Operations
 * @description Functions for persisting position data to Supabase
 */

/**
 * @notice Writes/updates position data in Supabase
 * @dev Uses HTTP client to POST position data with upsert (merge on conflict)
 *      Conflict resolution: user + protocol + chain + collateral
 * @param runtime - The CRE runtime instance containing secrets
 * @param data - Array of PositionWriteData to upsert
 * @returns 'Success' or 'Failure' string
 * 
 * @dev Database Schema (positions table):
 *      - user: string - Borrower address
 *      - protocol: string - Protocol identifier (e.g., "LIIBORROW_v1")
 *      - chain: number - Chain ID
 *      - collateral: string - Collateral token address
 *      - hf: string - Health factor (wei scale)
 *      - status: number - Risk status (0=HOT, 1=WARM, 2=COLD)
 * 
 * @dev HTTP Request:
 *      - Method: POST
 *      - Header: Prefer: resolution=merge-duplicates,return=minimal
 *      - Upsert key: user, protocol, chain, collateral
 */
export function writePositionsToSupabase(
  runtime: Runtime<Config>,
  data: PositionWriteData[]
): string {
  runtime.log(`>>> Writing position to Supabase`)

  // Fetch the Supabase service key from secrets
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  // Create http client
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      upsertPositionData(data, supabaseServiceKey.value),
      consensusIdenticalAggregation<boolean>()
    )()
    .result()

  return result ? 'Success' : 'Failure'
}

const upsertPositionData =
  (dataToSend: PositionWriteData[], secretKey: string) =>
    (sendRequester: HTTPSendRequester): boolean => {
      // Serialize to JSON => encode as bytes => convert to base64
      const bodyBytes = new TextEncoder().encode(JSON.stringify(dataToSend))
      const body = Buffer.from(bodyBytes).toString("base64")

      // construct POST request
      const req = {
        url: `${BASE_POSITION_URL}?on_conflict=user,protocol,chain,collateral`,
        method: "POST" as const,
        body,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "apikey": secretKey,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        cacheSettings: {
          store: true,
        },
      }

      // Send request
      const resp = sendRequester.sendRequest(req).result()

      if (!ok(resp)) {
        throw new Error(`HTTP request failed with status: ${resp.statusCode}`)
      }

      return true;

    }

////////////////////////// READ POSITIONS ////////////////////////////

/**
 * @title Position Read Operations
 * @description Functions for querying position data from Supabase
 */

/**
 * @notice Retrieves all positions from the database
 * @dev Fetches all position records without filtering
 * @param runtime - The CRE runtime instance containing secrets
 * @returns Array of ReadPositionData (user, protocol, chain, collateral)
 */
export function readAllPositionsFromSupabase(
  runtime: Runtime<Config>
): ReadPositionData[] {
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      readAllPositions(supabaseServiceKey.value),
      consensusIdenticalAggregation<ReadPositionData[]>()
    )()
    .result()

  runtime.log(`Successfully read data`)
  return result
}

const readAllPositions =
  (secretKey: string) =>
    (sendRequester: HTTPSendRequester): ReadPositionData[] => {

      const filter = `select=user,protocol,chain,collateral`

      const req = {
        url: `${BASE_POSITION_URL}?${filter}`,
        method: "GET" as const,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'apikey': secretKey,
        },
        cacheSettings: {
          store: true,
        },
      };

      const resp = sendRequester.sendRequest(req).result();
      if (!ok(resp)) throw new Error(`HTTP request failed with status: ${resp.statusCode}`);

      const bodyText = new TextDecoder().decode(resp.body);
      return JSON.parse(bodyText) as ReadPositionData[]
    }

/**
 * @notice Retrieves liquidatable (HOT) positions for a specific collateral
 * @dev Filters positions by status=0 (HOT) and collateral token address
 * @param runtime - The CRE runtime instance containing secrets
 * @param token - The collateral token address to filter by
 * @returns Array of ReadPositionData for liquidatable positions
 * 
 * @dev Query Filter:
 *      - status = eq.0 (liquidatable/HOT)
 *      - collateral = eq.{token}
 *      - Selects: user, protocol, chain, collateral
 */
export function readPositionsFromSupabase(
  runtime: Runtime<Config>,
  token: string
): ReadPositionData[] {
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      readPositions(supabaseServiceKey.value, token),
      consensusIdenticalAggregation<ReadPositionData[]>()
    )()
    .result()

  runtime.log(`Successfully read data`)
  return result
}

const readPositions =
  (secretKey: string, token: string) =>
    (sendRequester: HTTPSendRequester): ReadPositionData[] => {

      const filter = `status=eq.0&collateral=eq.${token}&select=user,protocol,chain,collateral`

      const req = {
        url: `${BASE_POSITION_URL}?${filter}`,
        method: "GET" as const,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'apikey': secretKey,
        },
        cacheSettings: {
          store: true,
        },
      };

      const resp = sendRequester.sendRequest(req).result();
      if (!ok(resp)) throw new Error(`HTTP request failed with status: ${resp.statusCode}`);

      const bodyText = new TextDecoder().decode(resp.body);
      return JSON.parse(bodyText) as ReadPositionData[]
    }

/**
 * @notice Retrieves position data for a specific user on a specific chain
 * @dev Used to get collateral info when processing Borrow/Repay events
 * @param runtime - The CRE runtime instance containing secrets
 * @param user wallet address
 * - The borrower's @param chain - The chain ID
 * @returns ReadPositionData with collateral information
 * @throws Error if no position found for user
 * 
 * @dev Query Filter:
 *      - user = eq.{user}
 *      - chain = eq.{chain}
 *      - Selects: collateral only
 */
export function readUserPositionFromSupabase(
  runtime: Runtime<Config>,
  user: string,
  chain: number
): ReadPositionData {
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      readUserPositions(supabaseServiceKey.value, user, chain),
      consensusIdenticalAggregation<ReadPositionData>()
    )()
    .result()

  runtime.log(`Successfully read user's position data`)
  return result
}

const readUserPositions =
  (secretKey: string, user: string, chain: number) =>
    (sendRequester: HTTPSendRequester): ReadPositionData => {

      const filter = `user=eq.${user}&chain=eq.${chain}&select=collateral`

      const req = {
        url: `${BASE_POSITION_URL}?${filter}`,
        method: "GET" as const,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'apikey': secretKey,
        },
        cacheSettings: {
          store: true,
        },
      };

      const resp = sendRequester.sendRequest(req).result();
      if (!ok(resp)) throw new Error(`HTTP request failed with status: ${resp.statusCode}`);

      const bodyText = new TextDecoder().decode(resp.body);
      const data = JSON.parse(bodyText) as ReadPositionData[]

      if (data.length === 0) {
        throw new Error(`No position data found for user: ${user} on chain: ${chain}`)
      }

      return {
        collateral: data[0].collateral
      }
    }

////////////////////////// WRITE ORACLES ////////////////////////////

/**
 * @title Oracle Write Operations
 * @description Functions for persisting oracle price data to Supabase
 */

/**
 * @notice Writes/updates oracle price data in Supabase
 * @dev Stores Chainlink oracle price updates with upsert on conflict
 * @param runtime - The CRE runtime instance containing secrets
 * @param data - OracleWriteData containing collateral, chain, price, last_update
 * @returns 'Success' or 'Failure' string
 * 
 * @dev Database Schema (oracles table):
 *      - collateral: string - Token address
 *      - chain: number - Chain ID
 *      - price: string - Current price (wei scale)
 *      - last_update: string - Unix timestamp of last update
 * 
 * @dev HTTP Request:
 *      - Method: POST
 *      - Upsert key: collateral, chain
 */
export function writeOracleToSupabase(
  runtime: Runtime<Config>,
  data: OracleWriteData
): string {
  runtime.log(`>>> Writing new price to Supabase`)

  // Fetch the Supabase service key from secrets
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  // Create http client
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      upsertOracleData(data, supabaseServiceKey.value),
      consensusIdenticalAggregation<boolean>()
    )()
    .result()

  return result ? 'Success' : 'Failure'
}

const upsertOracleData =
  (dataToSend: OracleWriteData, secretKey: string) =>
    (sendRequester: HTTPSendRequester): boolean => {
      // Serialize to JSON => encode as bytes => convert to base64
      const bodyBytes = new TextEncoder().encode(JSON.stringify(dataToSend))
      const body = Buffer.from(bodyBytes).toString("base64")

      // construct POST request
      const req = {
        url: `${BASE_ORACLE_URL}?on_conflict=collateral,chain`,
        method: "POST" as const,
        body,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "apikey": secretKey,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        cacheSettings: {
          store: true,
        },
      }

      // Send request
      const resp = sendRequester.sendRequest(req).result()

      if (!ok(resp)) {
        throw new Error(`HTTP request failed with status: ${resp.statusCode}`)
      }

      return true;
    }

////////////////////////// READ ORACLES ////////////////////////////

/**
 * @title Oracle Read Operations
 * @description Functions for querying oracle price data from Supabase
 */

/**
 * @notice Retrieves oracle price data for a specific collateral token
 * @param runtime - The CRE runtime instance containing secrets
 * @param collateral - The collateral token address to query
 * @returns ReadOracleData with price and last_update
 * @dev Returns default values (price: "0", last_update: "0") if no record exists
 * 
 * @dev Query Filter:
 *      - collateral = eq.{collateral}
 *      - Selects: price, last_update
 */
export function readOraclesFromSupabase(
  runtime: Runtime<Config>,
  collateral: string
): ReadOracleData {
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      readOracles(supabaseServiceKey.value, collateral),
      consensusIdenticalAggregation<ReadOracleData>()
    )()
    .result()

  runtime.log(`- Successfully read oracle data!`)

  return result
}

const readOracles =
  (secretKey: string, collateral: string) =>
    (sendRequester: HTTPSendRequester): ReadOracleData => {

      const filter = `collateral=eq.${collateral}&select=price,last_update`

      const req = {
        url: `${BASE_ORACLE_URL}?${filter}`,
        method: "GET" as const,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'apikey': secretKey,
          'Accept': 'application/json'
        },
        cacheSettings: {
          store: true,
        },
      };

      const resp = sendRequester.sendRequest(req).result();
      if (!ok(resp)) throw new Error(`HTTP request failed with status: ${resp.statusCode}`);

      const bodyText = new TextDecoder().decode(resp.body);
      const row = JSON.parse(bodyText)

      // return 0 values if row does not exist
      if (row.length == 0) {
        return {
          price: '0',
          last_update: '0'
        }
      }

      return row[0] as ReadOracleData
    }
