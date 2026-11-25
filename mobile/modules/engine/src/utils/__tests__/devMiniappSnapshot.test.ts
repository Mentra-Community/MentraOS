/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"
import {invalidateDevSnapshotRequests} from "../devSnapshotRequests"

const stored = new Map<string, unknown>()
let hasSnapshot = false
let latestVersion: string | null = null
const installCalls: string[] = []
const installOptions: Array<{versionOverride?: string; expectedBundleSha256?: string}> = []
let installOk = true
let downloadWait: Promise<void> | undefined
let activated = false
let collected = false
let fetchImpl: (url: string) => Promise<Response>

mock.module("../../services/AppRegistry", () => ({
  default: {
    hasDevSnapshot: () => hasSnapshot,
    getLatestDevSnapshotVersion: () => latestVersion,
    installFromUrl: async (
      url: string,
      opts: {beforeActivate?: () => void; versionOverride?: string; expectedBundleSha256?: string},
    ) => {
      installCalls.push(url)
      installOptions.push(opts)
      await downloadWait
      try {
        opts.beforeActivate?.()
      } catch (error) {
        return {is_ok: () => false, is_error: () => true, error}
      }
      activated = installOk
      if (installOk) latestVersion = opts.versionOverride ?? null
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

const {
  decideDevOpenRoute,
  ensureDevSnapshot,
  resetDevSnapshotsForTests,
  resolveDevBundleSource,
  servedBundleSha256,
  snapshotCandidateUrls,
} = await import("../devMiniappSnapshot")

const DEV_URL = "http://192.168.1.50:3000"

beforeEach(() => {
  hasSnapshot = false
  latestVersion = null
  installCalls.length = 0
  installOptions.length = 0
  resetDevSnapshotsForTests()
  servedSha = SHA_A
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

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
let servedSha = SHA_A

function liveManifest(): Response {
  return new Response(
    JSON.stringify({packageName: "com.dev.example", name: "Example", bundle: {url: "bundle.zip", sha256: servedSha}}),
    {status: 200},
  )
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
  test("runs the server's current bundle from a snapshot, held to the hash the server names", async () => {
    servedSha = SHA_A
    fetchImpl = async () => liveManifest()
    const result = await resolveDevBundleSource("com.dev.example", DEV_URL)
    expect(result.kind).toBe("live")
    if (result.kind !== "live") return
    expect(result.resolvedUrl).toBe(DEV_URL)
    expect(result.version).toMatch(/^dev-\d+$/)
    expect(result.version).toBe(latestVersion!)
    expect(installCalls).toEqual([`${DEV_URL}/bundle.zip`])
    expect(installOptions[0]!.expectedBundleSha256).toBe(SHA_A)
  })

  test("fetches the bundle again only when its hash changed", async () => {
    servedSha = SHA_A
    fetchImpl = async () => liveManifest()
    const first = await resolveDevBundleSource("com.dev.example", DEV_URL)
    const again = await resolveDevBundleSource("com.dev.example", DEV_URL)
    expect(again).toEqual(first)
    expect(installCalls).toHaveLength(1)
    servedSha = SHA_B
    await new Promise((resolve) => setTimeout(resolve, 2))
    const changed = await resolveDevBundleSource("com.dev.example", DEV_URL)
    expect(installCalls).toHaveLength(2)
    expect(changed.kind === "live" && first.kind === "live" && changed.version !== first.version).toBe(true)
  })

  test("runs the last snapshot when the server answers but its bundle doesn't download", async () => {
    fetchImpl = async () => liveManifest()
    installOk = false
    latestVersion = "dev-1700000000000"
    const result = await resolveDevBundleSource("com.dev.example", DEV_URL)
    expect(result).toEqual({kind: "snapshot", version: "dev-1700000000000"})
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

describe("servedBundleSha256", () => {
  test("reads a valid SHA-256 and nothing else", () => {
    expect(servedBundleSha256({bundle: {sha256: SHA_A.toUpperCase()}})).toBe(SHA_A)
    expect(servedBundleSha256({bundle: {sha256: "abc"}})).toBeNull()
    expect(servedBundleSha256({})).toBeNull()
    expect(servedBundleSha256(null)).toBeNull()
  })
})

describe("ensureDevSnapshot", () => {
  test("concurrent calls for the same bundle share one download", async () => {
    const [a, b] = await Promise.all([
      ensureDevSnapshot("com.dev.other", DEV_URL, SHA_A),
      ensureDevSnapshot("com.dev.other", DEV_URL, SHA_A),
    ])
    expect(a).toBe(b)
    expect(installCalls.length).toBe(1)
  })
})

test("a delayed dev download cannot activate or collect snapshots after release selection", async () => {
  let finish!: () => void
  downloadWait = new Promise<void>((resolve) => {
    finish = resolve
  })
  const superseded = ensureDevSnapshot("com.mentra.notes", DEV_URL, SHA_A)
  invalidateDevSnapshotRequests("com.mentra.notes")
  finish()
  expect(await superseded).toBeNull()
  expect(activated).toBe(false)
  expect(collected).toBe(false)
  expect(installCalls).toHaveLength(1) // no obsolete sidecar retry
  downloadWait = undefined
  expect(await ensureDevSnapshot("com.mentra.notes", DEV_URL, SHA_A)).toMatch(/^dev-/)
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
