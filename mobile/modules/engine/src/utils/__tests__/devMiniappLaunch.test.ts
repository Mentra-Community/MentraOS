/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// devMiniappLaunch.ts pulls in ./storage/storage, which wraps react-native-mmkv —
// unavailable outside the RN runtime. Stub it before importing the module under
// test; decideDevLaunchRoute only touches storage.save() on a "live" resolution.
const savedKeys: Array<{key: string; value: unknown}> = []
mock.module("../storage/storage", () => ({
  storage: {
    save: (key: string, value: unknown) => {
      savedKeys.push({key, value})
    },
  },
}))

const {decideDevLaunchRoute} = await import("../devMiniappLaunch")

const DEV_URL = "http://192.168.1.50:3000"

let fetchCalls = 0
let fetchImpl: () => Promise<Response>

beforeEach(() => {
  fetchCalls = 0
  savedKeys.length = 0
  ;(globalThis as {fetch: typeof fetch}).fetch = (async (..._args: unknown[]) => {
    fetchCalls++
    return fetchImpl()
  }) as typeof fetch
})

describe("decideDevLaunchRoute", () => {
  test("resolves live on the first successful attempt", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({packageName: "com.dev.example", name: "Example"}), {status: 200})

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL)

    expect(result.decision).toBe("live")
    expect(fetchCalls).toBe(1)
    expect(savedKeys).toHaveLength(1)
  })

  test("retries once after a network-layer failure, then succeeds", async () => {
    fetchImpl = async () => {
      if (fetchCalls === 1) throw new TypeError("Unable to resolve host")
      return new Response(JSON.stringify({packageName: "com.dev.example", name: "Example"}), {status: 200})
    }

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL)

    expect(result.decision).toBe("live")
    expect(fetchCalls).toBe(2)
  })

  test("declares offline after exhausting retries on repeated network failure", async () => {
    fetchImpl = async () => {
      throw new TypeError("Unable to resolve host")
    }

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL)

    expect(result.decision).toBe("offline")
    expect(fetchCalls).toBe(2)
  })

  test("does not retry a definitive non-OK HTTP response", async () => {
    fetchImpl = async () => new Response("not found", {status: 404})

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL)

    expect(result.decision).toBe("offline")
    expect(fetchCalls).toBe(1)
  })
})
