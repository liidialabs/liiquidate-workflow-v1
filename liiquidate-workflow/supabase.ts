import {
	ok,
	HTTPClient,
	type HTTPSendRequester,
	type Runtime,
	consensusIdenticalAggregation
} from '@chainlink/cre-sdk'
import '../contracts/abi'
import { type Config, PositionWriteData, ReadPositionData, OracleWriteData, ReadOracleData, WriteResponse } from "./types";

const BASE_POSITION_URL = 'https://elyzpintovurrcxcrumg.supabase.co/rest/v1/positions'
const BASE_ORACLE_URL = 'https://elyzpintovurrcxcrumg.supabase.co/rest/v1/oracles'

////////////////////////// WRITE POSITIONS ////////////////////////////

export function writePositionToSupabase(
  runtime: Runtime<Config>,
  data: PositionWriteData
): string {
  runtime.log(`>>> Writing to Supabase`)

  // Fetch the Supabase service key from secrets
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  // Create client
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
  (dataToSend: PositionWriteData, secretKey: string) => 
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
        store: true
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

// Read all potential positions that are liquidatable for a specific collateral

export function readPositionFromSupabase(
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
        maxAgeMs: 60_000,
      },
    };

    const resp = sendRequester.sendRequest(req).result();
    if (!ok(resp)) throw new Error(`HTTP request failed with status: ${resp.statusCode}`);

    const bodyText = new TextDecoder().decode(resp.body);
    return JSON.parse(bodyText) as ReadPositionData[]
  }

// Read position for a specific user and chain

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

    if(data.length === 0) {
      throw new Error(`No position data found for user: ${user} on chain: ${chain}`)
    }

    return {
      collateral: data[0].collateral
    }
  }

////////////////////////// WRITE ORACLES ////////////////////////////

export function writeOracleToSupabase(
  runtime: Runtime<Config>,
  data: OracleWriteData
): string {
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      upsertOracleData(data, supabaseServiceKey.value),
      consensusIdenticalAggregation<boolean>()
    )()
    .result()

  runtime.log(`Successfully sent data to Supabase. Status: ${result ? 'Success' : 'Failure'}`)
  return "Success"
}

const upsertOracleData = 
  (dataToSend: OracleWriteData, secretKey: string) => 
  (sendRequester: HTTPSendRequester): boolean => {
    // Serialize to JSON => encode as bytes => convert to base64
    const bodyBytes = new TextEncoder().encode(JSON.stringify(dataToSend))
    const body = Buffer.from(bodyBytes).toString("base64")

    // construct POST request
    const req = {
      url: `${BASE_ORACLE_URL}?on_conflict=collateral`,
      method: "POST" as const,
      body,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "apikey": secretKey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates, return=minimal'
      },
      cacheSettings: {
        store: true, 
        maxAgeMs: 60000
      },
    }

    // Send request
    const resp = sendRequester.sendRequest(req).result()

    if (!ok(resp)) {
      throw new Error(`HTTP request failed with status: ${resp.statusCode}`)
    }
    
    if (resp.statusCode !== 201 && resp.statusCode !== 204) {
      throw new Error(`Unexpected status code: ${resp.statusCode}`)
    }

    return true;
  }

////////////////////////// READ ORACLES ////////////////////////////

// filters: collateral=eq.0x98A7234c06461479C657F9439B2ED46a04f3A5c4&select=price,last_update

export function readOraclesFromSupabase(
  runtime: Runtime<Config>,
  oracle: string
): ReadOracleData {
  const supabaseServiceKey = runtime.getSecret({ id: "SUPABASE_KEY" }).result();
  const httpClient = new HTTPClient();

  const result = httpClient
    .sendRequest(
      runtime,
      readOracles(supabaseServiceKey.value, oracle),
      consensusIdenticalAggregation<ReadOracleData>()
    )()
    .result()

  runtime.log(`Successfully read oracle data!`)

  return result
}

const readOracles = 
  (secretKey: string, oracle: string) =>
  (sendRequester: HTTPSendRequester): ReadOracleData => {

    const req = {
      url: `${BASE_ORACLE_URL}?oracle=eq.${oracle}&select=price,last_update`,
      method: "GET" as const,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'apikey': secretKey,
        'Accept': 'application/vnd.pgrst.object+json'
      },
      cacheSettings: {
        store: true,
        maxAgeMs: 60_000,
      },
    };

    const resp = sendRequester.sendRequest(req).result();
    if (!ok(resp)) throw new Error(`HTTP request failed with status: ${resp.statusCode}`);

    const bodyText = new TextDecoder().decode(resp.body);
    return JSON.parse(bodyText) as ReadOracleData
  }
