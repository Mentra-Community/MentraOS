/// <reference types="bun-types" />

import {expect, test} from "bun:test"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {spawnSync} from "node:child_process"
import vm from "node:vm"

import type localMiniappRuntime from "../LocalMiniappRuntime"
import {BACKGROUND_READY_TIMEOUT_MS, MentraJSRouter, type MentraJSCrustBinding} from "../MentraJSRouter"
import {MentraUIRouter} from "../MentraUIRouter"
import {buildMentraUiShim} from "../mentraUiShim"

const PKG = "com.mentra.ai"

// Mirrors Mentra AI: its UI handlers are registered only after awaits (storage,
// then a network fetch). The page asks for history the moment it mounts.
const fixtureSource = `
import {registerMiniapp} from ${JSON.stringify(
  new URL("../../../../miniapp/src/background/register.ts", import.meta.url).pathname,
)};
registerMiniapp(async (session) => {
  globalThis.session = session;
  await new Promise((resolve) => setTimeout(resolve, 40));
  session.ui.onOpen(() => session.ui.send('history', ['pushed on open']));
  session.ui.handle('history:get', () => ['hello']);
}, {packageName: '${PKG}'});
`

function bundleFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ready-gate-fixture-"))
  const entry = join(dir, "index.ts")
  writeFileSync(entry, fixtureSource)
  const result = spawnSync(
    process.execPath,
    ["build", entry, "--target=browser", "--format=iife", "--outfile", join(dir, "bundle.js")],
    {encoding: "utf8"},
  )
  try {
    if (result.status !== 0) throw new Error(result.stderr)
    return readFileSync(join(dir, "bundle.js"), "utf8")
  } finally {
    rmSync(dir, {recursive: true})
  }
}

type Page = vm.Context & {
  window: unknown
  mentra: {
    ready(): void
    request(channel: string, payload?: unknown): Promise<unknown>
    on(channel: string, cb: (value: unknown) => void): void
  }
}

function makeRouters(hostFeatures: Record<string, boolean>) {
  let listener: ((payload: Record<string, unknown>) => void) | undefined
  let background: vm.Context | undefined
  let send: (raw: string) => void = () => {}
  const fromBackground: string[] = []
  const uiFrames: string[] = []
  const inits: string[] = []
  const host = {
    onLivenessTimeout: null,
    registerApp(_pkg: string, fn: (raw: string) => void) {
      send = fn
    },
    unregisterApp() {},
    resetHandshake() {},
    handleRawMessage(_pkg: string, raw: string) {
      const {payload} = JSON.parse(raw)
      fromBackground.push(payload.type)
      if (payload.type === "miniapp_connect") {
        send(JSON.stringify({payload: {type: "miniapp_connect_ack", packageName: PKG, userId: "", hostFeatures}}))
      }
    },
  }
  const crust: MentraJSCrustBinding = {
    addListener(_event, fn) {
      listener = fn
      return {
        remove() {
          listener = undefined
        },
      }
    },
    mentraJsSetManifest() {},
    mentraJsLoadPolyfillBundle: () => "fixture native bridge",
    mentraJsSpawn(_pkg, _polyfill, miniappJs) {
      background = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        AbortController,
        __dispatch(iface: string, method: string, argsJson: string) {
          listener?.({packageName: PKG, iface, method, argsJson})
          return null
        },
      })
      vm.runInContext(miniappJs, background)
      return true
    },
    mentraJsDispatchToJs(_pkg, envelope) {
      if (envelope.kind === "init") inits.push(envelope.sessionId as string)
      if (envelope.kind === "bridge") {
        const data = JSON.parse(envelope.raw as string).payload?.data
        if (data?.type) uiFrames.push(data.type)
      }
      const target = background
      if (!target) return
      queueMicrotask(() => {
        if (envelope.kind === "init")
          vm.runInContext(`__mentraInitCallback(${JSON.stringify(envelope.sessionId)})`, target)
        else if (envelope.kind === "bridge") target.__mentraDeliverBridgeRaw?.(envelope.raw as string)
      })
    },
  }
  const router = new MentraJSRouter(host as unknown as typeof localMiniappRuntime, crust)
  const ui = new MentraUIRouter(crust)
  router.uiRouter = ui
  router.start()
  return {
    router,
    ui,
    fromBackground,
    uiFrames,
    inits,
    emitBridge(payload: Record<string, unknown>) {
      listener?.({
        packageName: PKG,
        iface: "__bridge",
        method: "send",
        argsJson: JSON.stringify([JSON.stringify({payload})]),
      })
    },
  }
}

function mountPage(ui: MentraUIRouter): Page {
  const page = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    ReactNativeWebView: {
      postMessage(raw: string) {
        ui.routeFromWebView(PKG, raw)
      },
    },
  }) as Page
  page.window = page
  vm.runInContext(buildMentraUiShim({packageName: PKG}), page)
  ui.bindWebView(PKG, (js) => vm.runInContext(js, page))
  return page
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("UI requests sent before the init handler settles are answered, not rejected", async () => {
  const {router, ui, fromBackground} = makeRouters({initReady: true})
  await router.spawnAndRegister(PKG, bundleFixture())
  const page = mountPage(ui)
  const pushed: unknown[] = []
  page.mentra.on("history", (value) => pushed.push(value))
  page.mentra.ready()
  const history = page.mentra.request("history:get")
  expect(ui.isUiHeld(PKG)).toBe(true)

  expect(await history).toEqual(["hello"])
  expect(ui.isUiHeld(PKG)).toBe(false)
  // UI_OPEN is delivered after READY, so the late onOpen handler still runs.
  await settle(10)
  expect(pushed).toEqual([["pushed on open"]])
  expect(fromBackground.indexOf("miniapp_ready")).toBeGreaterThan(fromBackground.indexOf("miniapp_connect"))
  router.stop()
})

test("a background that predates READY is opened at CONNECT", async () => {
  const {router, ui, emitBridge} = makeRouters({initReady: true})
  router.registerApp(PKG)
  const opened: string[] = []
  ui.onUiReleased((pkg) => opened.push(pkg))
  expect(ui.isUiHeld(PKG)).toBe(true)
  emitBridge({type: "miniapp_connect", packageName: PKG})
  expect(opened).toEqual([PKG])
  expect(ui.isUiHeld(PKG)).toBe(false)
  router.stop()
})

test("a background that never reports READY is opened after the spawn deadline", () => {
  const {router, ui, emitBridge} = makeRouters({initReady: true})
  const realSetTimeout = globalThis.setTimeout
  const pending: Array<() => void> = []
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    if (ms === BACKGROUND_READY_TIMEOUT_MS) {
      pending.push(cb)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return realSetTimeout(cb, ms)
  }) as typeof setTimeout
  const warn = console.warn
  console.warn = () => {}
  try {
    router.registerApp(PKG)
    emitBridge({type: "miniapp_connect", packageName: PKG, initReady: true})
    expect(ui.isUiHeld(PKG)).toBe(true)
    expect(pending).toHaveLength(1)
    pending[0]!()
    expect(ui.isUiHeld(PKG)).toBe(false)
    // A late READY after the timeout has nothing left to open.
    emitBridge({type: "miniapp_ready"})
    expect(ui.isUiHeld(PKG)).toBe(false)
  } finally {
    globalThis.setTimeout = realSetTimeout
    console.warn = warn
    router.stop()
  }
})

test("the UI-hold deadline runs on the injected timer", () => {
  const {router, ui} = makeRouters({initReady: true})
  const armed: number[] = []
  const fired: Array<() => void> = []
  router.timer = {
    setTimeout(callback, ms) {
      armed.push(ms)
      fired.push(callback)
      return armed.length
    },
    clearTimeout() {},
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    router.registerApp(PKG)
    expect(armed).toEqual([BACKGROUND_READY_TIMEOUT_MS])
    fired[0]!()
    expect(ui.isUiHeld(PKG)).toBe(false)
  } finally {
    console.warn = warn
    router.stop()
  }
})

test("a background that has not connected by the deadline shows its UI but keeps frames for the late session", () => {
  const {router, ui, uiFrames, emitBridge} = makeRouters({initReady: true})
  const fired: Array<() => void> = []
  router.timer = {
    setTimeout(callback) {
      fired.push(callback)
      return fired.length
    },
    clearTimeout() {},
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    const released: string[] = []
    ui.onUiReleased((pkg) => released.push(pkg))
    router.registerApp(PKG)
    ui.bindWebView(PKG, () => {})
    ui.routeFromWebView(PKG, JSON.stringify({type: "ready"}))
    ui.routeFromWebView(PKG, JSON.stringify({type: "msg", channel: "history:get", requestId: "r1"}))
    fired[0]!()
    // The splash lifts, but nothing is sent to a context with no session.
    expect(released).toEqual([PKG])
    expect(ui.isUiHeld(PKG)).toBe(false)
    expect(uiFrames).toEqual([])
    emitBridge({type: "miniapp_connect", packageName: PKG, initReady: true})
    expect(uiFrames).toEqual(["UI_OPEN", "UI_MESSAGE"])
  } finally {
    console.warn = warn
    router.stop()
  }
})

test("a READY that arrives before the current session's CONNECT is ignored", () => {
  const {router, ui, emitBridge} = makeRouters({initReady: true})
  router.timer = {setTimeout: () => 1, clearTimeout() {}}
  router.registerApp(PKG)
  // Queued by the previous, killed context.
  emitBridge({type: "miniapp_ready"})
  expect(ui.isUiHeld(PKG)).toBe(true)
  emitBridge({type: "miniapp_connect", packageName: PKG, initReady: true})
  expect(ui.isUiHeld(PKG)).toBe(true)
  emitBridge({type: "miniapp_ready"})
  expect(ui.isUiHeld(PKG)).toBe(false)
  router.stop()
})

test("handshake frames from a previous context are ignored by session id", async () => {
  const {router, ui, inits, fromBackground, emitBridge} = makeRouters({initReady: true})
  router.timer = {setTimeout: () => 1, clearTimeout() {}}
  const warn = console.warn
  console.warn = () => {}
  try {
    await router.spawnAndRegister(PKG, "globalThis.__mentraInitCallback = function () {}")
    const current = inits[0]!
    emitBridge({type: "miniapp_connect", packageName: PKG, initReady: true, sessionId: "killed-context"})
    emitBridge({type: "miniapp_ready", sessionId: "killed-context"})
    expect(ui.isUiHeld(PKG)).toBe(true)
    // Dropped before the runtime, so no CONNECT_ACK reaches the replacement.
    expect(fromBackground).toEqual([])
    emitBridge({type: "miniapp_connect", packageName: PKG, initReady: true, sessionId: current})
    expect(ui.isUiHeld(PKG)).toBe(true)
    emitBridge({type: "miniapp_ready", sessionId: "killed-context"})
    expect(ui.isUiHeld(PKG)).toBe(true)
    emitBridge({type: "miniapp_ready", sessionId: current})
    expect(ui.isUiHeld(PKG)).toBe(false)
  } finally {
    console.warn = warn
    router.stop()
  }
})
