/// <reference types="bun-types" />

import {afterAll, beforeAll, beforeEach, describe, expect, test, mock} from "bun:test"

import {installWithRuntimeReload} from "../../utils/storeInstallRuntime"
import {configure, resetForTests} from "../../runtime/bootstrap"
import type {MentraJSRouter} from "../MentraJSRouter"

// --- Mock the launcher's heavy module deps before importing it. ------------

// getActiveVersion is mutable so a test can force an "unresolvable" bundle.
let activeVersion = "1.0.0"
let available = true
let releaseSource = "bundled_asset"
let releaseStorePackageName: string | undefined

mock.module("../AppRegistry", () => ({
  default: {
    getActiveVersion: async () => activeVersion,
    getReleaseIdentity: () => ({source: releaseSource, storePackageName: releaseStorePackageName}),
    getMiniappEntryPaths: (_packageName: string, version: string) => ({
      background: `file:///bundle/${version}/bg.js`,
      ui: `file:///bundle/${version}/ui.html`,
    }),
    getMiniappManifest: () => ({permissions: [{type: "MICROPHONE"}], hardwareRequirements: []}),
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
  unregisterDevApp: () => {},
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
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
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

let miniappLauncher: typeof import("../MiniappLauncher").miniappLauncher

beforeAll(async () => {
  configure({
    auth: {getSubjectToken: async () => ({token: "test", type: "test"})},
    config: {
      isMiniappAvailable: () => available,
      bundledSystemMiniappPackages: ["com.mentra.store", "com.mentra.notes"],
      bundledStoreMiniappPackages: ["com.mentra.store"],
      bundledSystemMiniappStoreOwners: {
        "com.mentra.store": "com.mentra.store",
        "com.mentra.notes": "com.mentra.store",
      },
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
    releaseSource = "bundled_asset"
    releaseStorePackageName = undefined
    waitForConnectCalls = []
    mockRouter = buildMockRouter()
    miniappLauncher.configure({router: mockRouter.router})
  })

  test("a disabled Store cannot resolve UI or launch through the runtime", async () => {
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

  test.each([false, true])("explicit updates hold launches through install/rollback (failure=%s)", async (fail) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let began!: () => void
    const downloading = new Promise<void>((resolve) => {
      began = resolve
    })
    const update = installWithRuntimeReload(
      miniappLauncher,
      "com.x",
      async () => {
        began()
        await pending
        if (fail) throw new Error("install failed")
        activeVersion = "2.0.0"
      },
      {
        restorePreviousVersion: () => {
          activeVersion = "1.0.0"
          available = true
        },
      },
    )
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
    expect(launched.uiUri).toBe(`file:///bundle/${fail ? "1.0.0" : "2.0.0"}/ui.html`)
  })

  test("explicit updates wait for an already-starting context and restart the new bundle", async () => {
    const launch = miniappLauncher.ensureRunning("com.x")
    const update = installWithRuntimeReload(
      miniappLauncher,
      "com.x",
      async () => {
        activeVersion = "2.0.0"
      },
      {
        restorePreviousVersion: () => {
          activeVersion = "1.0.0"
          available = true
        },
      },
    )
    await Promise.all([launch, update])
    expect(mockRouter.spawnCalls.map((call) => call.src)).toEqual(["BG SOURCE", "UPDATED SOURCE"])
    expect(mockRouter.unregisterCalls).toEqual(["com.x"])
  })

  test("automatic installs skip a running background context without stopping it", async () => {
    await miniappLauncher.ensureRunning("com.x", undefined, {projectRunning: false})
    const install = mock(async () => {})
    await expect(miniappLauncher.installWhenIdle("com.x", install)).rejects.toThrow("is running")
    expect(install).not.toHaveBeenCalled()
    expect(mockRouter.unregisterCalls).toEqual([])
    expect(miniappLauncher.isRunning("com.x")).toBe(true)
  })

  test("a launch during download wins and defers activation", async () => {
    let activate!: () => void
    let finishDownload!: () => void
    const downloading = new Promise<void>((resolve) => {
      finishDownload = resolve
    })
    const install = miniappLauncher.installWhenIdle("com.x", async (beforeActivate) => {
      activate = beforeActivate
      await downloading
      activate()
    })
    // It need not have finished spawning to reserve the old bundle.
    const launch = miniappLauncher.ensureRunning("com.x")
    finishDownload()
    await expect(install).rejects.toThrow("is running")
    await launch
    expect(mockRouter.spawnCalls).toHaveLength(1)
    expect(mockRouter.unregisterCalls).toEqual([])
  })

  test.each([false, true])("launch waits for activation to commit or roll back (failure=%s)", async (fail) => {
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
    expect(result.uiUri).toBe(`file:///bundle/${fail ? "1.0.0" : "2.0.0"}/ui.html`)
    expect(mockRouter.unregisterCalls).toEqual([])
  })

  test("an automatic update becomes eligible once the miniapp stops", async () => {
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

  test("ensureRunning spawns the background context when not registered", async () => {
    const result = await miniappLauncher.ensureRunning("com.x")
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(mockRouter.spawnCalls[0].packageName).toBe("com.x")
    expect(mockRouter.spawnCalls[0].src).toBe("BG SOURCE")
    expect(mockRouter.spawnCalls[0].permissions).toEqual(["MICROPHONE"])
    // Hands the resolved UI entry back to the host (for the WebView mount).
    expect(result.uiUri).toBe("file:///bundle/1.0.0/ui.html")
    expect(result.uiBaseDir).toBe("file:///bundle/1.0.0/")
    expect(miniappLauncher.isRunning("com.x")).toBe(true)
  })

  test("ensureRunning is idempotent — no second spawn for a live context", async () => {
    await miniappLauncher.ensureRunning("com.x")
    await miniappLauncher.ensureRunning("com.x")
    expect(mockRouter.spawnCalls.length).toBe(1)
  })

  test("marks only a host-bundled allowlisted package as SYSTEM-trusted", async () => {
    await miniappLauncher.ensureRunning("com.mentra.store")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(true)

    await miniappLauncher.ensureRunning("com.example.store")
    expect(mockRouter.spawnCalls[1].hostTrustedSystem).toBe(false)
  })

  test("launches a bundled package from a consumer dev URL without SYSTEM authority", async () => {
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
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("launches a manually installed bundled package without SYSTEM authority", async () => {
    releaseSource = "direct_download"
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(false)
  })

  test("does not trust a normal Store release for a build-owned package", async () => {
    releaseSource = "store"
    await miniappLauncher.ensureRunning("com.mentra.store")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(false)
  })

  test("trusts a build-owned package updated by its bundled Store channel", async () => {
    releaseSource = "system_store"
    releaseStorePackageName = "com.mentra.store"
    await miniappLauncher.ensureRunning("com.mentra.notes")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(true)
  })

  test("coalesces concurrent launches of the same package onto one spawn", async () => {
    // Both apps.ts start() and the WebView mount can call this before the first
    // spawn resolves — they must share one spawn, not race into a double-spawn.
    const [a, b] = await Promise.all([miniappLauncher.ensureRunning("com.x"), miniappLauncher.ensureRunning("com.x")])
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(a.uiUri).toBe("file:///bundle/1.0.0/ui.html")
    expect(b.uiUri).toBe("file:///bundle/1.0.0/ui.html")
  })

  test("stale view props after an update cannot select an inactive bundle", async () => {
    activeVersion = "2.0.0"
    const launched = await miniappLauncher.ensureRunning("com.x", {version: "1.0.0"})
    const reopened = await miniappLauncher.ensureRunning("com.x", {version: "1.0.0"})
    expect(mockRouter.spawnCalls.map((call) => call.src)).toEqual(["UPDATED SOURCE"])
    expect(launched.uiUri).toBe("file:///bundle/2.0.0/ui.html")
    expect(reopened.uiUri).toBe(launched.uiUri)
  })

  test("ensureConnected spawns then waits for the CONNECT handshake", async () => {
    await miniappLauncher.ensureConnected("com.x", 5000)
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(waitForConnectCalls).toEqual(["com.x"])
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
    expect(result).toEqual({uiUri: null, uiBaseDir: null})
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
