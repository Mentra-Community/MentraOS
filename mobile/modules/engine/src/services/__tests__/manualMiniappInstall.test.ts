import {afterAll, beforeEach, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"
import {configure, resetForTests} from "../../runtime/bootstrap"

let active = "1.0.0"
let running = true
let failInstall = false
let failLaunch = false
let devRecord: {packageName: string; devUrl: string; name: string; iconUrl: string} | undefined
let retainedDevSnapshot = false
const events: string[] = []
let installOptions: Record<string, unknown> | undefined
mock.module("../AppRegistry", () => ({
  getDevAppRecords: () => (devRecord ? [devRecord] : []),
  registerDevApp: async (record: NonNullable<typeof devRecord>) => {
    devRecord = record
  },
  default: {
    getInstalledVersions: () => [active],
    gcDevVersions: () => {
      retainedDevSnapshot = false
    },
    getActiveVersion: async () => active,
    setActiveVersion: (_pkg: string, version: string) => {
      active = version
      return Res.ok(undefined)
    },
    installFromUrl: async (_url: string, options: Record<string, unknown>) => {
      events.push("install")
      installOptions = options
      if (failInstall) return Res.error(new Error("Invalid archive"))
      retainedDevSnapshot = Boolean(devRecord && options.preserveDevSnapshots)
      devRecord = undefined
      active = "2.0.0"
      return Res.ok(undefined)
    },
  },
}))
mock.module("../MiniappLauncher", () => ({
  miniappLauncher: {
    pauseLaunches: async () => {
      events.push("pause")
      return () => {}
    },
    isRunning: () => running,
    stop: async () => {
      events.push("stop")
      running = false
    },
    ensureRunning: async () => {
      events.push(`launch ${active}`)
      if (failLaunch && active === "2.0.0") throw new Error("Replacement cannot launch")
      if (active.startsWith("dev-") && (!retainedDevSnapshot || !devRecord)) throw new Error("Missing prior dev build")
      running = true
    },
  },
}))
mock.module("../../stores/apps", () => ({
  useAppStatusStore: {
    getState: () => ({
      runUpdate: async (_pkg: string, action: () => Promise<void>) => action(),
      refresh: async () => {
        events.push("refresh")
      },
    }),
  },
}))
const {installMiniappFromJsonUrl} = await import("../manualMiniappInstall")
const originalFetch = globalThis.fetch
beforeEach(() => {
  resetForTests()
  configure({auth: {}, config: {bundledSystemMiniappPackages: ["com.mentra.notes"]}})
  active = "1.0.0"
  running = true
  failInstall = false
  failLaunch = false
  devRecord = undefined
  retainedDevSnapshot = false
  events.length = 0
  installOptions = undefined
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({packageName: "com.mentra.notes", version: "2.0.0", name: "Notes"}))) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = originalFetch
  resetForTests()
})

test("release QR replaces a running bundled miniapp and binds the ZIP to its manifest", async () => {
  const result = await installMiniappFromJsonUrl("https://manual.example/")
  expect(result.is_ok()).toBe(true)
  expect(events).toEqual(["pause", "stop", "install", "launch 2.0.0", "refresh"])
  expect(installOptions).toEqual({
    expectedPackageName: "com.mentra.notes",
    expectedVersion: "2.0.0",
    rejectExistingVersion: true,
    preserveDevSnapshots: true,
    releaseIdentity: {source: "direct_download"},
  })
})

test("an invalid manual bundle restores the previously running miniapp", async () => {
  failInstall = true
  expect((await installMiniappFromJsonUrl("https://manual.example")).is_error()).toBe(true)
  expect(events).toEqual(["pause", "stop", "install", "launch 1.0.0"])
  expect(active).toBe("1.0.0")
})

test("workspace manual installs are rejected before stopping or downloading a miniapp", async () => {
  configure({auth: {}, config: {localMiniappPolicy: {systemPackageNames: null, managed: []}}})
  expect((await installMiniappFromJsonUrl("https://manual.example")).is_error()).toBe(true)
  expect(events).toEqual([])
})

test("same-version release QR is rejected without stopping the working miniapp", async () => {
  active = "2.0.0"
  const result = await installMiniappFromJsonUrl("https://manual.example")
  expect(result.is_error()).toBe(true)
  expect(events).toEqual([])
  expect(running).toBe(true)
})

test("a release that cannot launch restores the live-dev registration and retained snapshot", async () => {
  active = "dev-123"
  devRecord = {packageName: "com.mentra.notes", devUrl: "http://localhost:8081", name: "Local Notes", iconUrl: ""}
  failLaunch = true
  expect((await installMiniappFromJsonUrl("https://manual.example")).is_error()).toBe(true)
  expect(events).toEqual(["pause", "stop", "install", "launch 2.0.0", "launch 2.0.0", "launch dev-123"])
  expect(running).toBe(true)
  expect(active).toBe("dev-123")
  expect(retainedDevSnapshot).toBe(true)
  expect(devRecord?.devUrl).toBe("http://localhost:8081")
})
