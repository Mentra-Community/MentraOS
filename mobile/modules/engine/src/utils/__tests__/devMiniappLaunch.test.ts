/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// devMiniappLaunch.ts pulls in ./storage/storage, which wraps react-native-mmkv —
// unavailable outside the RN runtime. Stub it before importing the module under
// test; decideDevLaunchRoute only touches storage.save() on a "live" resolution.
const savedKeys: Array<{key: string; value: unknown}> = []
const stored = new Map<string, unknown>()
mock.module("../storage/storage", () => ({
  storage: {
    save: (key: string, value: unknown) => {
      savedKeys.push({key, value})
      stored.set(key, value)
    },
    load: <T>(key: string) => {
      if (!stored.has(key)) return {is_ok: () => false as const}
      return {is_ok: () => true as const, value: stored.get(key) as T}
    },
  },
}))

mock.module("../../runtime/bootstrap", () => ({
  getConfigValues: () => ({}),
}))

const {decideDevLaunchRoute} = await import("../devMiniappLaunch")

const DEV_URL = "http://192.168.1.50:3000"

let fetchCalls = 0
let fetchImpl: (url: string) => Promise<Response>

beforeEach(() => {
  fetchCalls = 0
  savedKeys.length = 0
  stored.clear()
  ;(globalThis as {fetch: typeof fetch}).fetch = (async (input: RequestInfo | URL, ..._args: unknown[]) => {
    fetchCalls++
    const url = typeof input === "string" ? input : input.toString()
    return fetchImpl(url)
  }) as typeof fetch
})

describe("decideDevLaunchRoute", () => {
  test("resolves live on the first successful attempt", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({packageName: "com.dev.example", name: "Example"}), {status: 200})

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL)

    expect(result.decision).toBe("live")
    expect(result.resolvedUrl).toBe(DEV_URL)
    expect(fetchCalls).toBe(1)
    expect(savedKeys.some((s) => s.key === "com.dev.example_dev_last_reachable")).toBe(true)
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
    // Two attempts on the primary URL; no alternates configured.
    expect(fetchCalls).toBe(2)
  })

  test("does not retry a definitive non-OK HTTP response on the same URL", async () => {
    fetchImpl = async () => new Response("not found", {status: 404})

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL)

    expect(result.decision).toBe("offline")
    expect(fetchCalls).toBe(1)
  })

  test("failovers to an alternate host and persists the working URL", async () => {
    fetchImpl = async (url) => {
      const lower = url.toLowerCase()
      if (lower.includes("192.168.1.50")) throw new TypeError("timed out")
      if (lower.includes("mentas-macbook-pro.local")) {
        return new Response(JSON.stringify({packageName: "com.dev.example", name: "Example"}), {status: 200})
      }
      throw new TypeError(`unexpected host: ${url}`)
    }

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL, {
      alternateHosts: ["Mentas-MacBook-Pro.local"],
    })

    expect(result.decision).toBe("live")
    // URL() canonicalizes hostnames to lowercase.
    expect(result.resolvedUrl).toBe("http://mentas-macbook-pro.local:3000")
    expect(savedKeys.some((s) => s.key === "com.dev.example_dev_url" && s.value === result.resolvedUrl)).toBe(true)
  })

  test("failover leaves a cached file:// icon alone and rehosts a served icon", async () => {
    fetchImpl = async (url) => {
      if (url.includes("192.168.1.50")) throw new TypeError("timed out")
      return new Response(JSON.stringify({packageName: "com.dev.example"}), {status: 200})
    }
    const readMeta = () => {
      const saved = savedKeys.filter((s) => s.key === "com.dev.example_dev_meta").pop()
      return JSON.parse(String(saved?.value)) as {devUrl?: string; iconUrl?: string}
    }

    stored.set(
      "com.dev.example_dev_meta",
      JSON.stringify({devUrl: DEV_URL, iconUrl: "file:///var/mobile/dev-icons/com.dev.example.png"}),
    )
    await decideDevLaunchRoute("com.dev.example", DEV_URL, {alternateHosts: ["Mentas-MacBook-Pro.local"]})
    expect(readMeta().iconUrl).toBe("file:///var/mobile/dev-icons/com.dev.example.png")

    savedKeys.length = 0
    stored.set(
      "com.dev.example_dev_meta",
      JSON.stringify({devUrl: DEV_URL, iconUrl: "http://192.168.1.50:3000/icon.png"}),
    )
    await decideDevLaunchRoute("com.dev.example", DEV_URL, {alternateHosts: ["Mentas-MacBook-Pro.local"]})
    expect(readMeta().iconUrl).toBe("http://mentas-macbook-pro.local:3000/icon.png")

    savedKeys.length = 0
    stored.set(
      "com.dev.example_dev_meta",
      JSON.stringify({devUrl: DEV_URL, iconUrl: "http://192.168.1.50:9999/other-service/icon.png"}),
    )
    await decideDevLaunchRoute("com.dev.example", DEV_URL, {alternateHosts: ["Mentas-MacBook-Pro.local"]})
    // Same hostname, different port — leave the unrelated service icon alone.
    expect(readMeta().iconUrl).toBe("http://192.168.1.50:9999/other-service/icon.png")
  })

  test("reads stored mDNS host as an alternate", async () => {
    stored.set("com.dev.example_dev_mdns", "Mentas-MacBook-Pro.local")
    fetchImpl = async (url) => {
      if (url.includes("192.168.1.50")) throw new TypeError("timed out")
      return new Response(JSON.stringify({packageName: "com.dev.example"}), {status: 200})
    }

    const result = await decideDevLaunchRoute("com.dev.example", DEV_URL)

    expect(result.decision).toBe("live")
    expect(result.resolvedUrl).toBe("http://mentas-macbook-pro.local:3000")
  })
})
