/// <reference types="bun-types" />

import {beforeAll, beforeEach, describe, expect, test, mock} from "bun:test"

import type {MentraJSRouter} from "../MentraJSRouter"

// --- Mock the launcher's heavy module deps before importing it. ------------

// getActiveVersion is mutable so a test can force an "unresolvable" bundle.
let activeVersion = "1.0.0"
let releaseSource = "bundled_asset"

mock.module("../AppRegistry", () => ({
  default: {
    getActiveVersion: async () => activeVersion,
    getReleaseIdentity: () => ({source: releaseSource}),
    getMiniappEntryPaths: () => ({background: "file:///bundle/bg.js", ui: "file:///bundle/ui.html"}),
    getMiniappManifest: () => ({permissions: [{type: "MICROPHONE"}], hardwareRequirements: []}),
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
  storage: {load: () => ({is_ok: () => false})},
}))
mock.module("expo-file-system", () => ({
  File: class {
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    textSync() {
      return "BG SOURCE"
    }
  },
}))

let miniappLauncher: typeof import("../MiniappLauncher").miniappLauncher

beforeAll(async () => {
  const mod = await import("../MiniappLauncher")
  miniappLauncher = mod.miniappLauncher
})

// Fresh router (mutable registered set) per test.
function buildMockRouter() {
  const registered = new Set<string>()
  const spawnCalls: Array<{packageName: string; src: string; permissions?: string[]; hostTrustedSystem?: boolean}> = []
  const unregisterCalls: string[] = []
  const router = {
    registeredPackages: () => Array.from(registered),
    spawnAndRegister: async (
      packageName: string,
      src: string,
      opts?: {permissions?: string[]; hostTrustedSystem?: boolean},
    ) => {
      spawnCalls.push({
        packageName,
        src,
        permissions: opts?.permissions,
        hostTrustedSystem: opts?.hostTrustedSystem,
      })
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
    releaseSource = "bundled_asset"
    waitForConnectCalls = []
    mockRouter = buildMockRouter()
    miniappLauncher.configure({router: mockRouter.router})
  })

  test("ensureRunning spawns the background context when not registered", async () => {
    const result = await miniappLauncher.ensureRunning("com.x")
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(mockRouter.spawnCalls[0].packageName).toBe("com.x")
    expect(mockRouter.spawnCalls[0].src).toBe("BG SOURCE")
    expect(mockRouter.spawnCalls[0].permissions).toEqual(["MICROPHONE"])
    // Hands the resolved UI entry back to the host (for the WebView mount).
    expect(result.uiUri).toBe("file:///bundle/ui.html")
    expect(result.uiBaseDir).toBe("file:///bundle/")
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

  test("does not trust an allowlisted package installed by a Store", async () => {
    releaseSource = "store"
    await miniappLauncher.ensureRunning("com.mentra.store")
    expect(mockRouter.spawnCalls[0].hostTrustedSystem).toBe(false)
  })

  test("coalesces concurrent launches of the same package onto one spawn", async () => {
    // Both apps.ts start() and the WebView mount can call this before the first
    // spawn resolves — they must share one spawn, not race into a double-spawn.
    const [a, b] = await Promise.all([miniappLauncher.ensureRunning("com.x"), miniappLauncher.ensureRunning("com.x")])
    expect(mockRouter.spawnCalls.length).toBe(1)
    expect(a.uiUri).toBe("file:///bundle/ui.html")
    expect(b.uiUri).toBe("file:///bundle/ui.html")
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
