import {afterAll, beforeEach, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import {assertMiniappUpdateVersion} from "../miniappInstallIdentity"

let active = "1.0.0"
let running = true
let failInstall: Error | undefined
let failLaunch = false
const events: string[] = []
let installOptions: Record<string, unknown> | undefined
mock.module("../AppRegistry", () => ({
  default: {
    assertCanInstallVersion: (pkg: string, version: string) => assertMiniappUpdateVersion(pkg, version, [active]),
    installFromUrl: async (url: string, options: Record<string, unknown>) => {
      events.push(`install ${url}`)
      installOptions = options
      if (failInstall) return Res.error(failInstall)
      active = options.expectedVersion as string
      return Res.ok(undefined)
    },
  },
}))
mock.module("../MiniappLauncher", () => ({
  miniappLauncher: {
    pauseLaunches: async () => {
      events.push("pause")
      return () => events.push("resume")
    },
    isRunning: () => running,
    stop: async () => {
      events.push("stop")
      running = false
    },
    ensureRunning: async () => {
      events.push(`launch ${active}`)
      if (failLaunch) throw new Error("Replacement cannot launch")
      running = true
    },
  },
}))
mock.module("../../stores/apps", () => ({
  useAppStatusStore: {
    getState: () => ({
      refresh: async () => {
        events.push("refresh")
      },
    }),
  },
}))
const {installMiniappFromJsonUrl} = await import("../manualMiniappInstall")
const originalFetch = globalThis.fetch
let manifest: Record<string, unknown>

beforeEach(() => {
  active = "1.0.0"
  running = true
  failInstall = undefined
  failLaunch = false
  events.length = 0
  installOptions = undefined
  manifest = {packageName: "com.mentra.notes", version: "2.0.0", name: "Notes"}
  globalThis.fetch = (async () => new Response(JSON.stringify(manifest))) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

test("a release QR replaces a running miniapp and binds the ZIP to the manifest it showed", async () => {
  const result = await installMiniappFromJsonUrl("https://lan.example:6789/")
  expect(result.is_ok() && result.value).toEqual({packageName: "com.mentra.notes", version: "2.0.0", name: "Notes"})
  expect(events).toEqual([
    "pause",
    "stop",
    "install https://lan.example:6789/bundle.zip",
    "resume",
    "launch 2.0.0",
    "refresh",
  ])
  expect(installOptions).toEqual({
    expectedPackageName: "com.mentra.notes",
    expectedVersion: "2.0.0",
    releaseIdentity: {source: "direct_download"},
  })
})

test("a stopped miniapp stays stopped after a release QR install", async () => {
  running = false
  expect((await installMiniappFromJsonUrl("https://lan.example:6789")).is_ok()).toBe(true)
  expect(events).toEqual(["pause", "install https://lan.example:6789/bundle.zip", "resume", "refresh"])
})

test("an equal version reinstalls through the same installer as an upgrade", async () => {
  active = "2.0.0"
  expect((await installMiniappFromJsonUrl("https://lan.example:6789")).is_ok()).toBe(true)
  expect(events).toEqual([
    "pause",
    "stop",
    "install https://lan.example:6789/bundle.zip",
    "resume",
    "launch 2.0.0",
    "refresh",
  ])
})

test("a lower version is refused before stopping the installed miniapp or downloading", async () => {
  active = "3.0.0"
  const result = await installMiniappFromJsonUrl("https://lan.example:6789")
  expect(result.is_error() && result.error.message).toContain("3.0.0 is already installed")
  expect(events).toEqual([])
  expect(running).toBe(true)
})

test("a refused bundle restarts the previously running miniapp on its old version", async () => {
  failInstall = new Error("Publisher signature mismatch for installed miniapp com.mentra.notes")
  const result = await installMiniappFromJsonUrl("https://lan.example:6789")
  expect(result.is_error() && result.error.message).toContain("Publisher signature mismatch")
  expect(events).toEqual(["pause", "stop", "install https://lan.example:6789/bundle.zip", "resume", "launch 1.0.0"])
  expect(active).toBe("1.0.0")
})

test("a committed release stays installed when its runtime fails to launch", async () => {
  failLaunch = true
  expect((await installMiniappFromJsonUrl("https://lan.example:6789")).is_ok()).toBe(true)
  expect(active).toBe("2.0.0")
  expect(running).toBe(false)
})

test("a manifest without an identity is rejected before any install", async () => {
  manifest = {name: "Nameless"}
  const result = await installMiniappFromJsonUrl("https://lan.example:6789")
  expect(result.is_error() && result.error.message).toContain("missing packageName")
  expect(events).toEqual([])
})
