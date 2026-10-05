/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {spawnSync} from "node:child_process"
import vm from "node:vm"

import {MentraJSCrashController} from "../MentraJSCrashController"
import {MentraJSRouter, type MentraJSCrustBinding} from "../MentraJSRouter"
import {MentraUIRouter} from "../MentraUIRouter"
import {buildMentraUiShim} from "../mentraUiShim"
import type localMiniappRuntime from "../LocalMiniappRuntime"

const PKG = "com.mentra.notes"
const runtimeSource = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
// Execute the shipped watchdog method with native timer/transport I/O replaced,
// as in LocalMiniappRuntime.liveness.test.ts. No Expo singleton or device lane.
const start = runtimeSource.indexOf("  public probeForegroundLiveness(")
const rest = runtimeSource.slice(start)
const probe = new Bun.Transpiler({loader: "ts"}).transformSync(
  `class Host {${rest.slice(0, rest.search(/^  }$/m) + 3)}}`,
)

const fixtureSource = `
import {registerMiniapp} from ${JSON.stringify(
  new URL("../../../../miniapp/src/background/register.ts", import.meta.url).pathname,
)};
registerMiniapp((session) => {
  globalThis.session = session;
  session.ui.onOpen(() => session.ui.send('snapshot', {ready: session.ready}));
  session.ui.handle('auth:get', async () => ({token: await session.auth.getToken(), userId: session.auth.mentraUserId}));
  session.ui.handle('save-note', () => { __dispatch('__fixture', 'saved', '[]'); return new Promise(() => {}); });
}, {packageName: '${PKG}'});
`
let backgroundBundle: string
async function bundleFixture() {
  if (backgroundBundle) return backgroundBundle
  const dir = mkdtempSync(join(tmpdir(), "notes-restart-fixture-"))
  const entry = join(dir, "index.ts")
  writeFileSync(entry, fixtureSource)
  const result = spawnSync(
    process.execPath,
    ["build", entry, "--target=browser", "--format=iife", "--outfile", join(dir, "bundle.js")],
    {encoding: "utf8"},
  )
  try {
    if (result.status !== 0) throw new Error(result.stderr)
    backgroundBundle = readFileSync(join(dir, "bundle.js"), "utf8")
  } finally {
    rmSync(dir, {recursive: true})
  }
  return backgroundBundle
}

type Page = {
  mentra: {
    ready(): void
    request(channel: string, payload?: unknown): Promise<unknown>
    on(channel: string, cb: (value: unknown) => void): void
  }
  draft: string
}
type Background = {session: {ui: {isOpen(): boolean}; disconnect(): void}; __mentraDeliverBridgeRaw(raw: string): void}

async function fixture() {
  const timers = new Map<number, () => void>()
  let timerSeq = 0
  let listener: ((payload: Record<string, unknown>) => void) | undefined
  let background: vm.Context & Background
  let stalled = false
  let spawns = 0
  let saves = 0
  const events: string[] = []
  const Host = new Function(
    "BgTimer",
    "acsMeetingService",
    "MiniappRequestType",
    "FOREGROUND_LIVENESS_PROBE_TIMEOUT_MS",
    "LOG_TAG",
    `${probe}; return Host`,
  )(
    {
      setTimeout(cb: () => void) {
        const id = ++timerSeq
        timers.set(id, cb)
        return id
      },
      clearTimeout(id: number) {
        timers.delete(id)
      },
    },
    {ownerPackage: () => null},
    {PING: "miniapp_ping"},
    2500,
    "LOCAL_MINIAPP",
  )
  const host = new Host()
  host.connectedApps = new Map()
  host.foregroundProbeTimers = new Map()
  host.clearForegroundProbe = () => {
    timers.clear()
  }
  host.hasLiveSoftapAttempt = () => false
  let send: (raw: string) => void
  let connected = false
  const waiters: Array<() => void> = []
  host.registerApp = (_pkg: string, fn: (raw: string) => void) => {
    send = fn
    connected = false
    host.connectedApps.set(PKG, {lastPongAt: 0})
  }
  host.unregisterApp = () => {
    host.connectedApps.delete(PKG)
    connected = false
  }
  host.resetHandshake = () => {
    connected = false
  }
  host.waitForConnect = () => (connected ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)))
  host.sendToMiniapp = (_pkg: string, payload: unknown) => send(JSON.stringify({payload}))
  host.handleRawMessage = (_pkg: string, raw: string) => {
    const {payload} = JSON.parse(raw)
    if (payload.type === "miniapp_connect") {
      events.push("CONNECT")
      send(JSON.stringify({payload: {type: "miniapp_connect_ack", packageName: PKG, userId: ""}}))
      send(
        JSON.stringify({
          payload: {
            type: "miniapp_auth_update",
            auth: {token: "fixture-token", mentraUserId: "fixture-user", expiresAt: Date.now() + 3600000},
          },
        }),
      )
      connected = true
      waiters.splice(0).forEach((resolve) => resolve())
    }
    if (payload.type === "miniapp_pong") host.clearForegroundProbe()
  }
  const bundle = await bundleFixture()
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
    mentraJsSpawn() {
      spawns++
      stalled = false
      background = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        AbortController,
        __dispatch(iface: string, method: string, argsJson: string) {
          if (iface === "__fixture") {
            saves++
            return null
          }
          listener?.({packageName: PKG, iface, method, argsJson})
          return null
        },
      }) as vm.Context & Background
      vm.runInContext(bundle, background)
      return true
    },
    mentraJsKill() {
      background.session.disconnect()
    },
    mentraJsDispatchToJs(_pkg, envelope) {
      if (stalled) return
      const target = background
      queueMicrotask(() => {
        if (envelope.kind === "init") vm.runInContext('__mentraInitCallback("fixture")', target)
        else if (envelope.kind === "bridge" && target.__mentraDeliverBridgeRaw)
          target.__mentraDeliverBridgeRaw(envelope.raw as string)
      })
    },
  }
  const router = new MentraJSRouter(host as typeof localMiniappRuntime, crust)
  const ui = new MentraUIRouter(crust)
  router.uiRouter = ui
  router.crashController = new MentraJSCrashController({maxRetries: 3, backoffMs: [1]})
  router.start()
  await router.spawnAndRegister(PKG, bundle)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const page = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    draft: "unsaved user input",
    ReactNativeWebView: {
      postMessage(raw: string) {
        ui.routeFromWebView(PKG, raw)
      },
    },
  }) as vm.Context & Page
  page.window = page
  vm.runInContext(buildMentraUiShim({packageName: PKG}), page)
  ui.bindWebView(PKG, (js) => vm.runInContext(js, page))
  const snapshots: unknown[] = []
  page.mentra.on("snapshot", (value) => snapshots.push(value))
  page.mentra.ready()
  await new Promise((resolve) => setTimeout(resolve, 5))
  return {
    router,
    page,
    snapshots,
    events,
    spawns: () => spawns,
    saves: () => saves,
    background: () => background,
    stall() {
      stalled = true
    },
    async restart(trigger: "liveness" | "exception") {
      if (trigger === "exception")
        listener?.({
          packageName: PKG,
          iface: "__error",
          method: "exception",
          argsJson: '{"message":"injected native failure"}',
        })
      else {
        stalled = true
        router.probeForegroundLiveness(PKG)
        for (const cb of [...timers.values()]) cb()
        timers.clear()
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    },
    async close() {
      ui.unbindWebView(PKG)
      await router.unregister(PKG)
      router.stop()
    },
  }
}

for (const trigger of ["liveness", "exception"] as const) {
  test(`${trigger} restart restores mounted UI and fresh auth without foreground resync`, async () => {
    const f = await fixture()
    try {
      expect(await f.page.mentra.request("auth:get")).toEqual({token: "fixture-token", userId: "fixture-user"})
      await f.restart(trigger)
      expect(f.spawns()).toBe(2)
      expect(f.events).toEqual(["CONNECT", "CONNECT"])
      expect(f.background().session.ui.isOpen()).toBe(true)
      expect(f.snapshots).toHaveLength(2)
      expect(await f.page.mentra.request("auth:get")).toEqual({token: "fixture-token", userId: "fixture-user"})
      expect(f.page.draft).toBe("unsaved user input")
    } finally {
      await f.close()
    }
  })
}

test("restart rejects an interrupted mutation without replaying it", async () => {
  const f = await fixture()
  try {
    let outcome: unknown
    const save = f.page.mentra.request("save-note").catch((error) => {
      outcome = error
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await f.restart("liveness")
    expect((outcome as Error & {cause: {code: string}})?.cause?.code).toBe("BACKGROUND_RESTARTED")
    await save
    expect(f.saves()).toBe(1)
    expect(f.page.draft).toBe("unsaved user input")
  } finally {
    await f.close()
  }
})

test("a lost auth reply rejects on restart and a fresh read succeeds", async () => {
  const f = await fixture()
  try {
    f.stall()
    let outcome: unknown
    const auth = f.page.mentra.request("auth:get").catch((error) => {
      outcome = error
    })
    await f.restart("liveness")
    expect((outcome as Error & {cause: {code: string}})?.cause?.code).toBe("BACKGROUND_RESTARTED")
    await auth
    expect(await f.page.mentra.request("auth:get")).toEqual({token: "fixture-token", userId: "fixture-user"})
  } finally {
    await f.close()
  }
})
