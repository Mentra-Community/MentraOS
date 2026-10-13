/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"
import {invalidateDevSnapshotRequests} from "../devSnapshotRequests"

const stored = new Map<string, unknown>()
let hasSnapshot = false
let latestVersion: string | null = null
const installCalls: string[] = []
let installOk = true
let downloadWait: Promise<void> | undefined
let activated = false
let collected = false
let fetchImpl: (url: string) => Promise<Response>

mock.module("../../services/AppRegistry", () => ({
  default: {
    hasDevSnapshot: () => hasSnapshot,
    getLatestDevSnapshotVersion: () => latestVersion,
    installFromUrl: async (url: string, opts: {beforeActivate?: () => void}) => {
      installCalls.push(url)
      await downloadWait
      try {
        opts.beforeActivate?.()
      } catch (error) {
        return {is_ok: () => false, is_error: () => true, error}
      }
      activated = installOk
      return {
        is_ok: () => installOk,
        is_error: () => !installOk,
        error: installOk ? undefined : new Error("download failed"),
      }
    },
    gcDevVersions: () => {
      collected = true
    },
  },
  getLocalAppRunningState: () => false,
  saveLocalAppRunningState: () => {},
}))

mock.module("../storage/storage", () => ({
  storage: {
    save: (key: string, value: unknown) => stored.set(key, value),
    load: <T>(key: string) => {
      if (!stored.has(key)) return {is_ok: () => false as const}
      return {is_ok: () => true as const, value: stored.get(key) as T}
    },
  },
}))

mock.module("../../runtime/bootstrap", () => ({
  getConfigValues: () => ({}),
}))

const {decideDevOpenRoute, resolveDevBundleSource, snapshotCandidateUrls, queueDevSnapshot} = await import(
  "../devMiniappSnapshot"
)

const DEV_URL = "http://192.168.1.50:3000"

beforeEach(() => {
  hasSnapshot = false
  latestVersion = null
  installCalls.length = 0
  installOk = true
  downloadWait = undefined
  activated = false
  collected = false
  stored.clear()
  fetchImpl = async () => {
    throw new TypeError("Unable to resolve host")
  }
  ;(globalThis as {fetch: typeof fetch}).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    return fetchImpl(url)
  }) as typeof fetch
})

function liveManifest(): Response {
  return new Response(JSON.stringify({packageName: "com.dev.example", name: "Example"}), {status: 200})
}

describe("snapshotCandidateUrls", () => {
  test("tries same-origin bundle.zip then the sidecar zip", () => {
    expect(snapshotCandidateUrls(DEV_URL)).toEqual([
      `${DEV_URL}/bundle.zip`,
      "http://192.168.1.50:3001/__mentra_dev/bundle.zip",
    ])
  })

  test("uses an explicit sidecar port when provided", () => {
    expect(snapshotCandidateUrls(DEV_URL, 4001)).toEqual([
      `${DEV_URL}/bundle.zip`,
      "http://192.168.1.50:4001/__mentra_dev/bundle.zip",
    ])
  })
})

describe("decideDevOpenRoute", () => {
  test("returns live and queues a snapshot when the laptop answers", async () => {
    fetchImpl = async () => liveManifest()
    const result = await decideDevOpenRoute("com.dev.example", DEV_URL)
    expect(result.decision).toBe("live")
    await Promise.resolve()
    await Promise.resolve()
    expect(installCalls[0]).toBe(`${DEV_URL}/bundle.zip`)
  })

  test("returns cached when the laptop is down but a snapshot exists", async () => {
    hasSnapshot = true
    const result = await decideDevOpenRoute("com.dev.example", DEV_URL)
    expect(result).toEqual({decision: "cached"})
    expect(installCalls).toEqual([])
  })

  test("returns offline when the laptop is down and no snapshot exists", async () => {
    const result = await decideDevOpenRoute("com.dev.example", DEV_URL)
    expect(result).toEqual({decision: "offline"})
  })
})

describe("resolveDevBundleSource", () => {
  test("prefers live HTTP when the laptop answers", async () => {
    fetchImpl = async () => liveManifest()
    const result = await resolveDevBundleSource("com.dev.example", DEV_URL)
    expect(result.kind).toBe("live")
    if (result.kind === "live") {
      expect(result.resolvedUrl).toBe(DEV_URL)
    }
  })

  test("falls back to an on-disk snapshot when the laptop is gone", async () => {
    latestVersion = "dev-1700000000000"
    const result = await resolveDevBundleSource("com.dev.example", DEV_URL)
    expect(result).toEqual({kind: "snapshot", version: "dev-1700000000000"})
  })

  test("returns none when there is no laptop and no snapshot", async () => {
    const result = await resolveDevBundleSource("com.dev.example", DEV_URL)
    expect(result).toEqual({kind: "none"})
  })
})

describe("queueDevSnapshot", () => {
  test("coalesces concurrent snapshot installs for the same package", async () => {
    queueDevSnapshot("com.dev.other", DEV_URL)
    queueDevSnapshot("com.dev.other", DEV_URL)
    await Promise.resolve()
    await Promise.resolve()
    expect(installCalls.length).toBe(1)
  })
})

test("a delayed dev download cannot activate or collect snapshots after release selection", async () => {
  let finish!: () => void
  downloadWait = new Promise<void>((resolve) => {
    finish = resolve
  })
  queueDevSnapshot("com.mentra.notes", DEV_URL)
  invalidateDevSnapshotRequests("com.mentra.notes")
  finish()
  await new Promise((resolve) => setImmediate(resolve))
  expect(activated).toBe(false)
  expect(collected).toBe(false)
  expect(installCalls).toHaveLength(1) // no obsolete sidecar retry
  downloadWait = undefined
  queueDevSnapshot("com.mentra.notes", DEV_URL)
  await new Promise((resolve) => setImmediate(resolve))
  expect(activated).toBe(true) // a newly selected dev session may cache normally
})

test("a dev probe started before release selection cannot queue a snapshot afterward", async () => {
  let answer!: (response: Response) => void
  fetchImpl = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  const probe = decideDevOpenRoute("com.dev.example", DEV_URL)
  invalidateDevSnapshotRequests("com.dev.example")
  answer(liveManifest())
  await probe
  expect(installCalls).toEqual([])
})
