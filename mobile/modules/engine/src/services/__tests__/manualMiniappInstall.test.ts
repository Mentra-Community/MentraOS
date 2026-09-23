import {afterAll, beforeEach, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"
import {assertMiniappUpdateVersion} from "../miniappInstallIdentity"
import {configure, resetForTests} from "../../runtime/bootstrap"

let active = "1.0.0"
let running = true
let failInstall = false
let failLaunch = false
let devRecord: {packageName: string; devUrl: string; name: string; iconUrl: string} | undefined
const events: string[] = []
let installOptions: Record<string, unknown> | undefined
mock.module("../AppRegistry", () => ({
  getDevAppRecords: () => (devRecord ? [devRecord] : []),
  registerDevApp: async (record: NonNullable<typeof devRecord>) => {
    devRecord = record
  },
  default: {
    assertCanInstallVersion: (pkg: string, version: string) => assertMiniappUpdateVersion(pkg, version, [active]),
    wasUserUninstalled: () => false,
    getActiveVersion: async () => active,
    setActiveVersion: (_pkg: string, version: string) => {
      active = version
      return Res.ok(undefined)
    },
    installFromUrl: async (_url: string, options: Record<string, unknown>) => {
      events.push("install")
      installOptions = options
      if (failInstall) return Res.error(new Error("Invalid archive"))
      devRecord = undefined
      active = "2.0.0"
      return Res.ok(undefined)
    },
  },
}))
mock.module("../MiniappLauncher", () => ({
  miniappLauncher: {
    installWhenIdle: async (_pkg: string, action: (guard: () => void) => Promise<void>) => {
      if (running) throw new Error("App is running")
      return action(() => {})
    },
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
const {installMiniappRelease} = await import("../miniappReleaseInstall")
const originalFetch = globalThis.fetch
beforeEach(() => {
  resetForTests()
  configure({auth: {}, config: {bundledSystemMiniappPackages: ["com.mentra.notes"]}})
  active = "1.0.0"
  running = true
  failInstall = false
  failLaunch = false
  devRecord = undefined
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
    beforeActivate: expect.any(Function),
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

test("same-version release QR uses the same installer as an upgrade", async () => {
  active = "2.0.0"
  const result = await installMiniappFromJsonUrl("https://manual.example")
  expect(result.is_ok()).toBe(true)
  expect(events).toEqual(["pause", "stop", "install", "launch 2.0.0", "refresh"])
  expect(running).toBe(true)
})

test("a committed release stays installed when its runtime fails to launch", async () => {
  active = "dev-123"
  devRecord = {packageName: "com.mentra.notes", devUrl: "http://localhost:8081", name: "Local Notes", iconUrl: ""}
  failLaunch = true
  expect((await installMiniappFromJsonUrl("https://manual.example")).is_ok()).toBe(true)
  expect(events).toEqual(["pause", "stop", "install", "launch 2.0.0", "refresh"])
  expect(running).toBe(false)
  expect(active).toBe("2.0.0")
  expect(devRecord).toBeUndefined()
})

test("release QR rejects a downgrade before stopping the installed miniapp", async () => {
  active = "3.0.0"
  const result = await installMiniappFromJsonUrl("https://manual.example")
  expect(result.is_error()).toBe(true)
  expect(events).toEqual([])
  expect(active).toBe("3.0.0")
  expect(running).toBe(true)
})

test.each(["1.0.0", "2.0.0"])("Store installs use the shared upgrade/reinstall flow from %s", async (installed) => {
  active = installed
  await installMiniappRelease("https://store.example/bundle.zip", {
    expectedPackageName: "com.mentra.notes",
    expectedVersion: "2.0.0",
    releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
  })
  expect(events).toEqual(["pause", "stop", "install", "launch 2.0.0", "refresh"])
})

test("Store downgrade is rejected by the same preflight as QR", async () => {
  active = "3.0.0"
  await expect(
    installMiniappRelease("https://store.example/bundle.zip", {
      expectedPackageName: "com.mentra.notes",
      expectedVersion: "2.0.0",
      releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
    }),
  ).rejects.toThrow("3.0.0 is already installed")
  expect(events).toEqual([])
})

test("automatic installation defers without stopping a running miniapp", async () => {
  await expect(
    installMiniappRelease("https://store.example/bundle.zip", {
      expectedPackageName: "com.mentra.notes",
      expectedVersion: "2.0.0",
      onlyIfStopped: true,
    }),
  ).rejects.toThrow("App is running")
  expect(events).toEqual([])
  expect(active).toBe("1.0.0")
})

test("automatic installation uses the shared installer when idle", async () => {
  running = false
  await installMiniappRelease("https://store.example/bundle.zip", {
    expectedPackageName: "com.mentra.notes",
    expectedVersion: "2.0.0",
    onlyIfStopped: true,
  })
  expect(events).toEqual(["install", "refresh"])
  expect(running).toBe(false)
})
