/// <reference types="bun-types" />

import {afterAll, beforeAll, beforeEach, describe, expect, test, mock, spyOn} from "bun:test"

import {reactNative} from "./reactNativeTestMock"

import {configure, resetForTests} from "../../runtime/bootstrap"
import {installWithRuntimeReload} from "../../utils/storeInstallRuntime"
import type {MentraJSRouter} from "../MentraJSRouter"

// --- Mock the launcher's heavy module deps before importing it. ------------

// getActiveVersion is mutable so a test can force an "unresolvable" bundle.
let activeVersion = "1.0.0"
let available = true
let backgroundAvailable = false
let releaseSource = "bundled_asset"
let releaseStorePackageName: string | undefined
let selectedSnapshot: string | null = null
let storedDevUrl: string | null = null
let publisherFingerprint: string | null = null
let snapshotVersions: string[] = []
let uiPath = "ui/index.html"
const revoked = new Set<string>()

mock.module("../AppRegistry", () => ({
  default: {
    isMiniappAccessRevoked: (packageName: string) => revoked.has(packageName),
    getActiveVersion: async () => activeVersion,
    getPublisherKeyFingerprint: () => publisherFingerprint,
    getSelectedDevSnapshot: () => selectedSnapshot,
    getMiniappEntryPaths: (_package: string, version: string) => {
      snapshotVersions.push(version)
      return {
        background: `file:///bundle/${version}/bg.js`,
        ui: `file:///bundle/${version}/${uiPath}`,
        rootDir: `file:///bundle/${version}/`,
        uiPath,
      }
    },
    getMiniappManifest: () => ({permissions: [{type: "MICROPHONE"}], hardwareRequirements: []}),
    getReleaseIdentity: () => ({source: releaseSource, storePackageName: releaseStorePackageName}),
    getLatestDevSnapshotVersion: () => null,
    hasDevSnapshot: () => false,
    installFromUrl: async () => ({is_ok: () => true, is_error: () => false}),
    gcDevVersions: () => {},
  },
  // MiniappLauncher imports these named exports for its autostart path; none of
  // these tests exercise autostart, but the bindings must exist for the module
  // graph to load. Keep them inert.
  getLocalAppRunningState: () => false,
  saveLocalAppRunningState: () => {},
}))
mock.module("../DevServerBridge", () => ({default: {connect: () => {}}}))

let waitForConnectCalls: string[] = []
mock.module("../LocalMiniappRuntime", () => ({
  default: {
    waitForConnect: async (packageName: string) => {
      waitForConnectCalls.push(packageName)
    },
  },
}))
// No dev url stored → released (file://) path; resolveDevPort also misses.
// Because there's no dev url, decideDevLaunchRoute is never reached here, so we
// deliberately do NOT mock.module("../../utils/devMiniappLaunch"): that mock is
// process-global in Bun and would leak into devMiniappLaunch.test.ts.
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) => ({is_ok: () => key.endsWith("_dev_url") && !!storedDevUrl, value: storedDevUrl}),
    save: () => ({is_ok: () => true}),
  },
}))
mock.module("expo-file-system", () => ({
  File: class {
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    textSync() {
      return this.uri.includes("/2.0.0/") ? "UPDATED SOURCE" : "BG SOURCE"
    }
  },
}))

mock.module("../../stores/settings", () => ({SETTINGS: {super_mode: {key: "super_mode"}}, useSettingsStore: {getState: () => ({getSetting: () => false})}}))

let miniappLauncher: typeof import("../MiniappLauncher").miniappLauncher

beforeAll(async () => {
  configure({
    auth: {},
    config: {
      isMiniappAvailable: (_packageName, mode) => available || (mode === "background" && backgroundAvailable),
      bundledSystemMiniappPackages: ["com.mentra.notes"],
    },
  })
  const mod = await import("../MiniappLauncher")
  miniappLauncher = mod.miniappLauncher
})

afterAll(resetForTests)

// Fresh router (mutable registered set) per test.
function buildMockRouter() {
  const registered = new Set<string>()
  const projected = new Set<string>()
  const spawnCalls: Array<{
    packageName: string
    src: string
    permissions?: string[]
    hostTrustedSystem?: boolean
    projectRunning?: boolean
  }> = []
  const unregisterCalls: string[] = []
  const router = {
    registeredPackages: () => Array.from(registered),
    spawnAndRegister: async (
      packageName: string,
      src: string,
      opts?: {permissions?: string[]; hostTrustedSystem?: boolean; projectRunning?: boolean},
    ) => {
      spawnCalls.push({
        packageName,
        src,
        permissions: opts?.permissions,
        hostTrustedSystem: opts?.hostTrustedSystem,
        projectRunning: opts?.projectRunning,
      })
      registered.add(packageName)
      if (opts?.projectRunning ?? true) projected.add(packageName)
      return true
    },
    projectRunning: (packageName: string) => projected.add(packageName),
    isProjectedRunning: (packageName: string) => projected.has(packageName),
    unregister: async (packageName: string) => {
      unregisterCalls.push(packageName)
      registered.delete(packageName)
      projected.delete(packageName)
    },
  } as unknown as MentraJSRouter
  return {router, registered, spawnCalls, unregisterCalls}
}

describe("MiniappLauncher", () => {
  let mockRouter: ReturnType<typeof buildMockRouter>

  beforeEach(() => {
    activeVersion = "1.0.0"
    available = true
    backgroundAvailable = false
    releaseSource = "bundled_asset"
    releaseStorePackageName = undefined
    selectedSnapshot = null
    storedDevUrl = null
    publisherFingerprint = null
    snapshotVersions = []
    uiPath = "ui/index.html"
    ;(reactNative.Platform as {OS: string}).OS = "android"
    waitForConnectCalls = []
    revoked.clear()
    mockRouter = buildMockRouter()
    miniappLauncher.configure({router: mockRouter.router})
  })

  test("a miniapp whose access was revoked is refused with a revocation error, spawning nothing", async () => {
    const {MiniappAccessRevokedError} = await import("../MiniappLauncher")
    revoked.add("com.mentra.notes")
    await expect(miniappLauncher.ensureRunning("com.mentra.notes")).rejects.toBeInstanceOf(MiniappAccessRevokedError)
    expect(mockRouter.spawnCalls).toHaveLength(0)
    revoked.delete("com.mentra.notes")
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls).toHaveLength(1)
  })

  test("an unavailable Store cannot resolve UI or launch", async () => {
    available = false
    expect(await miniappLauncher.resolveBundle("com.mentra.store")).toBeNull()
    await expect(miniappLauncher.ensureRunning("com.mentra.store")).rejects.toThrow("disabled")
    expect(mockRouter.spawnCalls).toHaveLength(0)
  })

  test("disabling availability during bundle resolution prevents the pending spawn", async () => {
    const launch = miniappLauncher.ensureRunning("com.mentra.store")
    available = false
    await expect(launch).rejects.toThrow()
    expect(mockRouter.spawnCalls).toHaveLength(0)
  })

  test("a background-only Store runs maintenance without becoming launchable or exposing its UI", async () => {
    available = false
    backgroundAvailable = true
    await miniappLauncher.ensureConnected("com.mentra.store", 5000, undefined, {projectRunning: false})
    expect(waitForConnectCalls).toEqual(["com.mentra.store"])
    expect(mockRouter.spawnCalls[0].projectRunning).toBe(false)
    expect(miniappLauncher.isProjectedRunning("com.mentra.store")).toBe(false)
    expect(await miniappLauncher.resolveBundle("com.mentra.store")).toBeNull()
    await expect(miniappLauncher.ensureRunning("com.mentra.store")).rejects.toThrow("disabled")
    expect(mockRouter.spawnCalls).toHaveLength(1)
    expect(miniappLauncher.isProjectedRunning("com.mentra.store")).toBe(false)
  })

  test("background execution cannot bypass a host policy that disables both modes", async () => {
    available = false
    await expect(
      miniappLauncher.ensureConnected("com.mentra.store", 5000, undefined, {projectRunning: false}),
    ).rejects.toThrow("disabled")
    expect(mockRouter.spawnCalls).toHaveLength(0)
  })

  test("background availability is rechecked after resolving the bundle", async () => {
    available = false
    backgroundAvailable = true
    const launch = miniappLauncher.ensureConnected("com.mentra.store", 5000, undefined, {projectRunning: false})
    backgroundAvailable = false
    await expect(launch).rejects.toThrow()
    expect(mockRouter.spawnCalls).toHaveLength(0)
  })

  test("an automatic update skips a running background context without stopping it", async () => {
    await miniappLauncher.ensureRunning("com.x", undefined, {projectRunning: false})
    const install = mock(async () => {})
    await expect(miniappLauncher.installWhenIdle("com.x", install)).rejects.toThrow("is running")
    expect(install).not.toHaveBeenCalled()
    expect(mockRouter.unregisterCalls).toEqual([])
    expect(miniappLauncher.isRunning("com.x")).toBe(true)
  })

  test("a launch during the download wins and defers activation", async () => {
    let finishDownload!: () => void
    const downloading = new Promise<void>((resolve) => {
      finishDownload = resolve
    })
    const install = miniappLauncher.installWhenIdle("com.x", async (beforeActivate) => {
      await downloading
      beforeActivate()
    })
    const launch = miniappLauncher.ensureRunning("com.x")
    finishDownload()
    await expect(install).rejects.toThrow("is running")
    await launch
    expect(mockRouter.spawnCalls).toHaveLength(1)
    expect(mockRouter.unregisterCalls).toEqual([])
  })

  test.each([false, true])("a launch waits for activation to commit or roll back (failure=%s)", async (fail) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const install = miniappLauncher.installWhenIdle("com.x", async (beforeActivate) => {
      beforeActivate()
      await pending
      if (fail) throw new Error("activation failed")
      activeVersion = "2.0.0"
    })
    let launched = false
    const launch = miniappLauncher.ensureRunning("com.x", {version: "1.0.0"}).then((result) => {
      launched = true
      return result
    })
    await Promise.resolve()
    expect(launched).toBe(false)
    expect(mockRouter.spawnCalls).toHaveLength(0)
    finish()
    if (fail) await expect(install).rejects.toThrow("activation failed")
    else await install
    const result = await launch
    expect(launched).toBe(true)
    expect(mockRouter.spawnCalls).toHaveLength(1)
    expect(mockRouter.spawnCalls[0].src).toBe(fail ? "BG SOURCE" : "UPDATED SOURCE")
    expect(result.uiRootDir).toBe(`file:///bundle/${fail ? "1.0.0" : "2.0.0"}/`)
    expect(mockRouter.unregisterCalls).toEqual([])
  })

  test("an automatic update becomes possible once the miniapp stops", async () => {
    await miniappLauncher.ensureRunning("com.x")
    await miniappLauncher.stop("com.x")
    const install = mock(async (beforeActivate: () => void) => {
      beforeActivate()
      return "updated"
    })
    await expect(miniappLauncher.installWhenIdle("com.x", install)).resolves.toBe("updated")
    expect(install).toHaveBeenCalledTimes(1)
    expect(miniappLauncher.isRunning("com.x")).toBe(false)
  })

  test("marks only a host-provenance bundled package as SYSTEM-trusted", async () => {
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(true)

    await miniappLauncher.ensureRunning("com.example.notes")
    expect(mockRouter.spawnCalls[1].hostTrustedSystem).toBe(false)
  })

  test("launches a bundled package from a dev URL without SYSTEM trust", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) =>
      url.endsWith("/miniapp.json")
        ? new Response(JSON.stringify({packageName: "com.mentra.notes", entry: {background: "bg.js", ui: "ui.html"}}))
        : new Response("DEV SOURCE")) as typeof fetch
    try {
      const resolved = await miniappLauncher.resolveBundle("com.mentra.notes", {devUrl: "http://localhost:8081"})
      expect(resolved?.devUrl).toBe("http://localhost:8081")
      expect(resolved?.bgSource).toBe("DEV SOURCE")
      expect(resolved?.hostTrustedSystem).toBe(false)
      // A live development build keeps loading its screen from its server.
      expect(resolved?.uiUri).toBe("http://localhost:8081/dist/ui.html")
      expect(resolved?.uiOrigin).toBe("http://localhost:8081")
      expect(resolved?.uiRootDir).toBeNull()
      expect(resolved?.devBuild).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("launches a manually installed bundled package without SYSTEM trust", async () => {
    releaseSource = "direct_download"
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(false)
  })

  test("does not trust a Store's release of a bundled package", async () => {
    releaseSource = "store"
    releaseStorePackageName = "com.mentra.store"
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(false)
  })

  test("trusts a bundled package the retired Mentra Store updated, and no other Store's", async () => {
    releaseSource = "system_store"
    releaseStorePackageName = "com.mentra.store"
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(true)
    releaseStorePackageName = "com.other.store"
    await miniappLauncher.stop("com.mentra.notes")
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls[1].hostTrustedSystem).toBe(false)
  })

  test("a transient wake does not project into user-visible running state", async () => {
    await miniappLauncher.ensureConnected("com.x", 5000, undefined, {projectRunning: false})
    expect(mockRouter.spawnCalls[0].projectRunning).toBe(false)
    expect(miniappLauncher.isRunning("com.x")).toBe(true)
    expect(miniappLauncher.isProjectedRunning("com.x")).toBe(false)
  })

  test("a user open promotes an existing transient context without a second spawn", async () => {
    await miniappLauncher.ensureConnected("com.x", 5000, undefined, {projectRunning: false})
    await miniappLauncher.ensureRunning("com.x")
    expect(mockRouter.spawnCalls).toHaveLength(1)
    expect(miniappLauncher.isProjectedRunning("com.x")).toBe(true)
  })

  test.each(["http://reachable.local:3000", "http://unreachable.local:3000"])("explicit packed snapshot wins over scanned URL %s", async url => {
    selectedSnapshot = "dev-1234-a"
    storedDevUrl = url
    await miniappLauncher.resolveBundle("com.x", {devUrl: url})
    expect(snapshotVersions).toEqual([selectedSnapshot])
  })

  test("ensureRunning spawns the background context when not registered", async () => {
    const result = await miniappLauncher.ensureRunning("com.x")
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(mockRouter.spawnCalls[0].packageName).toBe("com.x")
    expect(mockRouter.spawnCalls[0].src).toBe("BG SOURCE")
    expect(mockRouter.spawnCalls[0].permissions).toEqual(["MICROPHONE"])
    // Hands the resolved UI entry back to the host (for the WebView mount): the
    // package's own origin, serving the active version's bundle root.
    expect(result).toEqual({
      uiUri: "https://com.x.miniapp.invalid/ui/index.html",
      uiOrigin: "https://com.x.miniapp.invalid",
      uiRootDir: "file:///bundle/1.0.0/",
      devBuild: false,
    })
    expect(miniappLauncher.isRunning("com.x")).toBe(true)
  })

  test("loads an installed screen from the package's own origin on iOS", async () => {
    ;(reactNative.Platform as {OS: string}).OS = "ios"
    const result = await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(result).toEqual({
      uiUri: "miniapp://com.mentra.notes/ui/index.html",
      uiOrigin: "miniapp://com.mentra.notes",
      uiRootDir: "file:///bundle/1.0.0/",
      devBuild: false,
    })
  })

  test("writes an underscore as a hyphen in the Android host and encodes the entry path", async () => {
    uiPath = "ui/main page.html"
    const resolved = await miniappLauncher.resolveBundle("com.example_corp.my_app")
    expect(resolved?.uiUri).toBe("https://com.example-corp.my-app.miniapp.invalid/ui/main%20page.html")
    expect(resolved?.uiOrigin).toBe("https://com.example-corp.my-app.miniapp.invalid")
  })

  test.each(["com.Example.notes", "com.example.my-app"])(
    "gives %s no screen, never a file URL, when its name can't have an origin",
    async (packageName) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {})
      try {
        const result = await miniappLauncher.ensureRunning(packageName)
        expect(result).toEqual({uiUri: null, uiOrigin: null, uiRootDir: null, devBuild: false})
        // The background still runs; only the screen is refused.
        expect(mockRouter.spawnCalls.map((call) => call.packageName)).toEqual([packageName])
      } finally {
        warn.mockRestore()
      }
    },
  )

  test("gives no screen for a UI entry that leaves the bundle", async () => {
    uiPath = "../other/index.html"
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const resolved = await miniappLauncher.resolveBundle("com.x")
      expect(resolved?.uiUri).toBeNull()
      expect(resolved?.uiRootDir).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  test("a development snapshot loads from the package's origin and is marked a development build", async () => {
    selectedSnapshot = "dev-1234-a"
    const resolved = await miniappLauncher.resolveBundle("com.x")
    expect(resolved?.uiUri).toBe("https://com.x.miniapp.invalid/ui/index.html")
    expect(resolved?.uiRootDir).toBe("file:///bundle/dev-1234-a/")
    expect(resolved?.devBuild).toBe(true)
  })

  test("ensureRunning is idempotent — no second spawn for a live context", async () => {
    await miniappLauncher.ensureRunning("com.x")
    await miniappLauncher.ensureRunning("com.x")
    expect(mockRouter.spawnCalls.length).toBe(1)
  })

  test("coalesces concurrent launches of the same package onto one spawn", async () => {
    // Both apps.ts start() and the WebView mount can call this before the first
    // spawn resolves — they must share one spawn, not race into a double-spawn.
    const [a, b] = await Promise.all([miniappLauncher.ensureRunning("com.x"), miniappLauncher.ensureRunning("com.x")])
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(a.uiUri).toBe("https://com.x.miniapp.invalid/ui/index.html")
    expect(b.uiUri).toBe("https://com.x.miniapp.invalid/ui/index.html")
  })

  test("runs the installed bundle instead of live dev code for a package with a publisher signature", async () => {
    publisherFingerprint = "sha256:publisher"
    storedDevUrl = "http://localhost:8081"
    const originalFetch = globalThis.fetch
    const fetched: string[] = []
    globalThis.fetch = (async (url: string) => {
      fetched.push(url)
      return new Response("DEV SOURCE")
    }) as typeof fetch
    try {
      const resolved = await miniappLauncher.resolveBundle("com.example.signed", {devUrl: "http://localhost:8081"})
      expect(fetched).toEqual([])
      expect(resolved?.devUrl).toBeNull()
      expect(resolved?.bgSource).toBe("BG SOURCE")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test.each([false, true])("explicit installs hold launches through install/rollback (failure=%s)", async (fail) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let began!: () => void
    const downloading = new Promise<void>((resolve) => {
      began = resolve
    })
    const update = installWithRuntimeReload(miniappLauncher, "com.x", async () => {
      began()
      await pending
      if (fail) throw new Error("install failed")
      activeVersion = "2.0.0"
    })
    const outcome = update.catch((error) => error)
    await downloading
    const launch = miniappLauncher.ensureRunning("com.x", {version: "1.0.0"})
    await Promise.resolve()
    expect(mockRouter.spawnCalls).toHaveLength(0)
    finish()
    const result = await outcome
    if (fail) expect(result.message).toBe("install failed")
    const launched = await launch
    expect(mockRouter.spawnCalls.map((call) => call.src)).toEqual([fail ? "BG SOURCE" : "UPDATED SOURCE"])
    expect(launched.uiRootDir).toBe(`file:///bundle/${fail ? "1.0.0" : "2.0.0"}/`)
  })

  test("explicit installs wait for an already-starting context and restart the new bundle", async () => {
    const launch = miniappLauncher.ensureRunning("com.x")
    const update = installWithRuntimeReload(miniappLauncher, "com.x", async () => {
      activeVersion = "2.0.0"
    })
    await Promise.all([launch, update])
    expect(mockRouter.spawnCalls.map((call) => call.src)).toEqual(["BG SOURCE", "UPDATED SOURCE"])
    expect(mockRouter.unregisterCalls).toEqual(["com.x"])
  })

  test("refuses a second explicit install of a package while one is activating", async () => {
    const release = await miniappLauncher.pauseLaunches("com.x")
    await expect(miniappLauncher.pauseLaunches("com.x")).rejects.toThrow("already activating")
    release()
    const next = await miniappLauncher.pauseLaunches("com.x")
    next()
  })

  test("stale view props after an install cannot select an inactive bundle", async () => {
    activeVersion = "2.0.0"
    const result = await miniappLauncher.ensureRunning("com.x", {version: "1.0.0"})
    expect(mockRouter.spawnCalls[0].src).toBe("UPDATED SOURCE")
    expect(result.uiRootDir).toBe("file:///bundle/2.0.0/")
  })

  test("ensureConnected spawns then waits for the CONNECT handshake", async () => {
    await miniappLauncher.ensureConnected("com.x", 5000)
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(waitForConnectCalls).toEqual(["com.x"])
  })

  test("ensureRunning rejects when the bundle cannot be resolved", async () => {
    activeVersion = "" // no installed version → resolveBundle returns null
    await expect(miniappLauncher.ensureRunning("com.missing")).rejects.toThrow(/cannot resolve bundle/)
    expect(mockRouter.spawnCalls.length).toBe(0)
  })

  test("ensureRunning returns null UI for an already-registered package whose resolve fails", async () => {
    // First launch succeeds and registers the package. Later the bundle becomes
    // unresolvable (e.g. the mentra-miniapp dev server dropped). Headless
    // callers must not throw — LocalMiniappView routes null uiUri + devUrl to
    // /applet/dev-offline instead.
    await miniappLauncher.ensureRunning("com.x")
    expect(mockRouter.spawnCalls.length).toBe(1)
    activeVersion = ""
    const result = await miniappLauncher.ensureRunning("com.x")
    expect(result).toEqual({uiUri: null, uiOrigin: null, uiRootDir: null, devBuild: false})
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(miniappLauncher.isRunning("com.x")).toBe(true)
  })

  test("stop tears the background context down via the router", async () => {
    await miniappLauncher.ensureRunning("com.x")
    expect(miniappLauncher.isRunning("com.x")).toBe(true)
    await miniappLauncher.stop("com.x")
    expect(mockRouter.unregisterCalls).toEqual(["com.x"])
    expect(miniappLauncher.isRunning("com.x")).toBe(false)
  })

  test("isRunning is false for an unconfigured / unknown package", () => {
    expect(miniappLauncher.isRunning("com.unknown")).toBe(false)
  })
})
