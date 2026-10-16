import {afterEach, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import {createBluetoothSdkApi} from "./bluetooth-sdk.api"
import {
  BLUETOOTH_SDK_DIST_TAGS_URL,
  BLUETOOTH_SDK_MIN_SUPPORTED_VERSION_ENV,
  BLUETOOTH_SDK_POSTHOG_CAPTURE_URL,
  BluetoothSdkUpdateService,
  type Fetcher,
} from "../../services/bluetooth-sdk-update.service"
import type {AppEnv} from "../../types/hono.types"

const TAGS = {latest: "3.2.1", beta: "3.2.1-beta.646", dev: "3.3.0-dev.821"}
const VALID = {
  install_id: "mentra-bt-sdk-0f0e",
  app_identifier: "com.example.glasses",
  sdk_version: "3.3.0-dev.700",
  sdk_platform: "android",
  sdk_surface: "react_native",
  app_version: "1.4.0",
  app_build: "140",
  app_build_type: "release",
  app_install_source: "com.android.vending",
  app_environment: "production",
  os_platform: "android",
  os_version: 34,
}

const savedMinimum = process.env[BLUETOOTH_SDK_MIN_SUPPORTED_VERSION_ENV]
afterEach(() => {
  if (savedMinimum === undefined) delete process.env[BLUETOOTH_SDK_MIN_SUPPORTED_VERSION_ENV]
  else process.env[BLUETOOTH_SDK_MIN_SUPPORTED_VERSION_ENV] = savedMinimum
})

interface Call {
  url: string
  init: RequestInit
}

/** A fresh app and service per test, so the dist-tag cache never leaks. */
function setup(
  options: {capture?: () => Promise<Response>; distTags?: () => Promise<Response>; posthogApiKey?: string | undefined} = {},
) {
  const calls: Call[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({url, init})
    if (url === BLUETOOTH_SDK_DIST_TAGS_URL) return (options.distTags ?? (async () => Response.json(TAGS)))()
    if (url === BLUETOOTH_SDK_POSTHOG_CAPTURE_URL) return (options.capture ?? (async () => new Response("{}")))()
    throw new Error(`unexpected fetch ${url}`)
  }
  const posthogApiKey = "posthogApiKey" in options ? options.posthogApiKey : "phc_test"
  const service = new BluetoothSdkUpdateService({fetch: fetcher, posthogApiKey: () => posthogApiKey})
  const app = new Hono<AppEnv>().route("/api/client/bluetooth-sdk", createBluetoothSdkApi(service))
  const post = (body: unknown) =>
    app.request("/api/client/bluetooth-sdk/update-check", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  const captures = () =>
    calls.filter((call) => call.url === BLUETOOTH_SDK_POSTHOG_CAPTURE_URL).map((call) => JSON.parse(call.init.body as string))
  return {post, calls, captures}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("POST /api/client/bluetooth-sdk/update-check validation", () => {
  test("rejects invalid bodies with 400 and records nothing", async () => {
    const {post, calls} = setup()
    const invalid: unknown[] = [
      "{not json",
      "",
      JSON.stringify([VALID]),
      {...VALID, install_id: undefined},
      {...VALID, app_identifier: "  "},
      {...VALID, sdk_version: undefined},
      {...VALID, sdk_platform: "windows"},
      {...VALID, sdk_surface: "flutter"},
      {...VALID, app_build_type: "profile"},
      {...VALID, app_version: "x".repeat(129)},
      {...VALID, install_id: "x".repeat(129)},
      {...VALID, filler: "x".repeat(20_000)},
    ]
    for (const body of invalid) {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({error: "invalid_request"})
    }
    await settle()
    expect(calls).toHaveLength(0)
  })

  test("accepts the minimal body and a numeric os_version", async () => {
    const {post} = setup()
    const minimal = await post({install_id: "i", app_identifier: "a", sdk_version: "3.2.1", sdk_platform: "ios"})
    expect(minimal.status).toBe(200)
    const numeric = await post(VALID)
    expect(numeric.status).toBe(200)
  })
})

describe("POST /api/client/bluetooth-sdk/update-check response", () => {
  test("answers with the flat status shape", async () => {
    const {post} = setup()
    const response = await post(VALID)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "update_available",
      channel: "dev",
      latestVersion: "3.3.0-dev.821",
      minimumSupportedVersion: null,
    })
  })

  test("reads the minimum supported version from the environment", async () => {
    process.env[BLUETOOTH_SDK_MIN_SUPPORTED_VERSION_ENV] = "3.1.0"
    const {post} = setup()
    expect(await (await post({...VALID, sdk_version: "3.0.5"})).json()).toEqual({
      status: "unsupported",
      channel: "latest",
      latestVersion: "3.2.1",
      minimumSupportedVersion: "3.1.0",
    })
    expect(await (await post({...VALID, sdk_version: "3.1.0-dev.3"})).json()).toMatchObject({
      status: "update_available",
      minimumSupportedVersion: "3.1.0",
    })
  })

  test("is unknown when npm has never answered", async () => {
    const {post} = setup({
      distTags: async () => {
        throw new Error("npm down")
      },
    })
    expect(await (await post(VALID)).json()).toEqual({
      status: "unknown",
      channel: "dev",
      latestVersion: null,
      minimumSupportedVersion: null,
    })
  })
})

describe("POST /api/client/bluetooth-sdk/update-check capture", () => {
  test("answers but records nothing when Core has no PostHog key", async () => {
    const {post, captures} = setup({posthogApiKey: undefined})
    const response = await post(VALID)
    await settle()
    expect(response.status).toBe(200)
    expect(captures()).toHaveLength(0)
  })

  test("records the check in PostHog as an anonymous install event", async () => {
    const {post, captures} = setup()
    await post({...VALID, unknown_field: "dropped"})
    await settle()
    const [capture] = captures()
    expect(captures()).toHaveLength(1)
    expect(capture).toMatchObject({
      api_key: "phc_test",
      event: "bluetooth_sdk_update_check",
      distinct_id: "mentra-bt-sdk-0f0e",
    })
    expect(typeof capture.uuid).toBe("string")
    expect(Number.isNaN(Date.parse(capture.timestamp))).toBe(false)
    expect(capture.properties).toEqual({
      ...VALID,
      os_version: "34",
      event_source: "mentra_bluetooth_sdk",
      update_status: "update_available",
      update_channel: "dev",
      latest_version: "3.3.0-dev.821",
      $process_person_profile: false,
      $geoip_disable: true,
    })
  })

  test("omits latest_version when it is unknown", async () => {
    const {post, captures} = setup()
    await post({...VALID, sdk_version: "garbage"})
    await settle()
    expect(captures()[0].properties).toMatchObject({update_status: "unknown", update_channel: "latest"})
    expect(captures()[0].properties).not.toHaveProperty("latest_version")
  })

  test("a failing or hanging capture does not change or delay the response", async () => {
    const expected = {status: "update_available", channel: "dev", latestVersion: "3.3.0-dev.821", minimumSupportedVersion: null}
    for (const capture of [
      async (): Promise<Response> => {
        throw new Error("posthog down")
      },
      async () => new Response("bad", {status: 500}),
      () => new Promise<Response>(() => {}),
    ]) {
      const {post, captures} = setup({capture})
      const response = await post(VALID)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expected)
      await settle()
      expect(captures()).toHaveLength(1)
    }
  })
})
