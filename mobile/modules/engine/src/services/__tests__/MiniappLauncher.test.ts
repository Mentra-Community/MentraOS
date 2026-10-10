/// <reference types="bun-types" />

import {beforeAll, beforeEach, describe, expect, test, mock} from "bun:test"

import {installWithRuntimeReload} from "../../utils/storeInstallRuntime"
import type {MentraJSRouter} from "../MentraJSRouter"

// --- Mock the launcher's heavy module deps before importing it. ------------

// getActiveVersion is mutable so a test can force an "unresolvable" bundle.
let activeVersion = "1.0.0"
let selectedSnapshot: string | null = null
let superMode = false
let storedDevUrl: string | null = null
let publisherFingerprint: string | null = null
let snapshotVersions: string[] = []

mock.module("../AppRegistry", () => ({
  default: {
    getActiveVersion: async () => activeVersion,
    getPublisherKeyFingerprint: () => publisherFingerprint,
    getSelectedDevSnapshot: () => selectedSnapshot,
    getMiniappEntryPaths: (_package: string, version: string) => {
      snapshotVersions.push(version)
      return {background: `file:///bundle/${version}/bg.js`, ui: `file:///bundle/${version}/ui.html`}
    },
    getMiniappManifest: () => ({permissions: [{type: "MICROPHONE"}], hardwareRequirements: []}),
    getReleaseIdentity: () => null,
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
  storage: {load: (key: string) => ({is_ok: () => key.endsWith("_dev_url") && !!storedDevUrl, value: storedDevUrl})},
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

mock.module("../../stores/settings", () => ({SETTINGS: {super_mode: {key: "super_mode"}}, useSettingsStore: {getState: () => ({getSetting: () => superMode})}}))

let miniappLauncher: typeof import("../MiniappLauncher").miniappLauncher

beforeAll(async () => {
  const mod = await import("../MiniappLauncher")
  miniappLauncher = mod.miniappLauncher
})

// Fresh router (mutable registered set) per test.
function buildMockRouter() {
  const registered = new Set<string>()
  const spawnCalls: Array<{packageName: string; src: string; permissions?: string[]}> = []
  const unregisterCalls: string[] = []
  const router = {
    registeredPackages: () => Array.from(registered),
    spawnAndRegister: async (packageName: string, src: string, opts?: {permissions?: string[]}) => {
      spawnCalls.push({packageName, src, permissions: opts?.permissions})
      registered.add(packageName)
      return true
    },
    unregister: async (packageName: string) => {
      unregisterCalls.push(packageName)
      registered.delete(packageName)
    },
  } as unknown as MentraJSRouter
  return {router, registered, spawnCalls, unregisterCalls}
}

describe("MiniappLauncher", () => {
  let mockRouter: ReturnType<typeof buildMockRouter>

  beforeEach(() => {
    activeVersion = "1.0.0"
    selectedSnapshot = null
    superMode = false
    storedDevUrl = null
    publisherFingerprint = null
    snapshotVersions = []
    waitForConnectCalls = []
    mockRouter = buildMockRouter()
    miniappLauncher.configure({router: mockRouter.router})
  })

  test.each(["http://reachable.local:3000", "http://unreachable.local:3000"])("explicit packed snapshot wins over scanned URL %s", async url => {
    superMode = true
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

  test("coalesces concurrent launches of the same package onto one spawn", async () => {
    // Both apps.ts start() and the WebView mount can call this before the first
    // spawn resolves — they must share one spawn, not race into a double-spawn.
    const [a, b] = await Promise.all([miniappLauncher.ensureRunning("com.x"), miniappLauncher.ensureRunning("com.x")])
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(a.uiUri).toBe("file:///bundle/1.0.0/ui.html")
    expect(b.uiUri).toBe("file:///bundle/1.0.0/ui.html")
  })

  test("runs the installed bundle instead of live dev code for a package with a publisher signature", async () => {
    publisherFingerprint = "sha256:publisher"
    superMode = true
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
    expect(launched.uiUri).toBe(`file:///bundle/${fail ? "1.0.0" : "2.0.0"}/ui.html`)
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
    expect(result.uiUri).toBe("file:///bundle/2.0.0/ui.html")
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
