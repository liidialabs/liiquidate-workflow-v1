import {
  CronCapability,
  HTTPClient,
  handler,
  ok,
  consensusIdenticalAggregation,
  type Runtime,
  type HTTPSendRequester,
  Runner,
} from "@chainlink/cre-sdk"
import { z } from "zod"

// Config schema
const configSchema = z.object({
  webhookUrl: z.string(),
  schedule: z.string(),
})

type Config = z.infer<typeof configSchema>

// Data to be sent
type MyData = {
  message: string
  value: number
}

// Response for consensus
type PostResponse = {
  statusCode: number
}

export const postData = (sendRequester: HTTPSendRequester, config: Config): PostResponse => {
  // 1. Prepare the data to be sent
  const dataToSend: MyData = {
    message: "Hello there!",
    value: 77,
  }

  // 2. Serialize the data to JSON and encode as bytes
  const bodyBytes = new TextEncoder().encode(JSON.stringify(dataToSend))

  // 3. Convert to base64 for the request
  const body = Buffer.from(bodyBytes).toString("base64")

  // 4. Construct the POST request with cacheSettings
  const req = {
    url: config.webhookUrl,
    method: "POST" as const,
    body,
    headers: {
      "Content-Type": "application/json",
    },
    cacheSettings: {
      store: true, // Enable reading from cache
      maxAgeMs: 60000, // Accept cached responses up to 60 seconds old
    },
  }

  // 5. Send the request and wait for the response
  const resp = sendRequester.sendRequest(req).result()

  if (!ok(resp)) {
    throw new Error(`HTTP request failed with status: ${resp.statusCode}`)
  }

  return { statusCode: resp.statusCode }
}

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const httpClient = new HTTPClient()

  const result = httpClient
    .sendRequest(
      runtime,
      postData,
      consensusIdenticalAggregation<PostResponse>()
    )(runtime.config) // Call with config
    .result()

  runtime.log(`Successfully sent data to webhook. Status: ${result.statusCode}`)
  return "Success"
}

const initWorkflow = (config: Config) => {
  return [
    handler(
      new CronCapability().trigger({
        schedule: config.schedule,
      }),
      onCronTrigger
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema,
  })
  await runner.run(initWorkflow)
}
