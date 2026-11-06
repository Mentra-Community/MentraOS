/// <reference types="bun-types" />

import {createRequire} from "node:module"

import TestRenderer, {act} from "react-test-renderer"
import {afterEach, beforeEach, describe, expect, jest, mock, test} from "bun:test"

import type {Device} from "@mentra/bluetooth-sdk"

// See useMentraLiveOta.test.tsx: load the hook against the renderer's React.
const rendererRequire = createRequire(require.resolve("react-test-renderer"))
mock.module("react", () => rendererRequire("react"))

const reactActEnvironment = globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let platformOS = "android"
const appStateListeners = new Set<(state: string) => void>()
mock.module("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener)
      return {remove: () => appStateListeners.delete(listener)}
    },
  },
  Linking: {openSettings: mock(() => Promise.resolve())},
  Platform: {
    get OS() {
      return platformOS
    },
  },
}))
mock.module("../../types", () => ({DeviceTypes: {LIVE: "Mentra Live"}}))
mock.module("../../services/GlassesStatusProjection", () => ({startGlassesStatusProjection: () => Promise.resolve()}))
const startPairingProjection = mock(() => {})
mock.module("../../services/PairingProjection", () => ({startPairingProjection}))

type Listener<T> = (value: T) => void
const listeners = {
  found: new Set<Listener<Device[]>>(),
  readiness: new Set<() => void>(),
  target: new Set<Listener<boolean>>(),
  failure: new Set<Listener<{error: string; code?: string}>>(),
  notReady: new Set<() => void>(),
}
const subscribe =
  <T,>(set: Set<T>) =>
  (listener: T) => {
    set.add(listener)
    return () => set.delete(listener)
  }

let results: Device[] = []
let audioSetup: {state: string} = {state: "connected"}
let targetReady = false
let identity: {kind: string; name?: string} = {kind: "none"}
let bonded: Device | null = null

const fakePairing = {
  searchResults: () => results,
  onFound: (listener: () => void) => subscribe(listeners.found)(listener),
  readiness: () => ({audioSetup}),
  onReadiness: (listener: () => void) => subscribe(listeners.readiness)(listener),
  otherBtConnected: () => false,
  onOtherBtConnected: () => () => {},
  targetReady: () => targetReady,
  onTargetReady: (_target: unknown, listener: Listener<boolean>) => subscribe(listeners.target)(listener),
  onPairFailure: (listener: Listener<{error: string; code?: string}>) => subscribe(listeners.failure)(listener),
  onGlassesNotReady: (listener: () => void) => subscribe(listeners.notReady)(listener),
  identity: () => identity,
  markPendingSelection: mock(() => Promise.resolve()),
  bondedGlasses: mock(() => Promise.resolve(bonded)),
  scan: mock(() => Promise.resolve()),
  stopScan: mock(() => Promise.resolve()),
  diagnoseEmptyScan: mock(() => Promise.resolve(null as {code: string} | null)),
  pair: mock(() => Promise.resolve()),
  waitForReady: mock(() => new Promise<boolean>(() => {})),
  setBluetoothClassicTarget: mock(() => Promise.resolve()),
  abandonAttempt: mock(() => Promise.resolve()),
}
const fakeGlasses = {
  connectDefault: mock(() => Promise.resolve()),
  hasDefaultDevice: mock(() => Promise.resolve(true)),
  unpair: mock(() => Promise.resolve()),
}
mock.module("../../facades/pairing", () => ({pairing: fakePairing}))
mock.module("../../facades/glasses", () => ({glasses: fakeGlasses}))

const {useMentraLivePairing} = require("../useMentraLivePairing") as typeof import("../useMentraLivePairing")
type Options = Parameters<typeof useMentraLivePairing>[0]

let controller: ReturnType<typeof useMentraLivePairing>
const onExit = mock((_from: string) => {})
const onFinished = mock(() => {})

function Probe(props: Partial<Options>) {
  controller = useMentraLivePairing({initializeRuntime: false, onExit, onFinished, ...props})
  return null
}

async function renderFlow(props: Partial<Options> = {}) {
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<Probe {...props} />)
  })
  return renderer!
}

const live = (name: string, extra: Partial<Device> = {}): Device =>
  ({id: name, name, model: "Mentra Live", address: name, ...extra}) as Device

async function emitResults(next: Device[]) {
  results = next
  await act(async () => listeners.found.forEach((listener) => listener(next)))
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}

async function selectAndPair(device = live("MENTRA_LIVE_BLE_E511")) {
  await emitResults([device])
  const listed = controller.state.page === "scan" ? controller.state.glasses[0] : undefined
  await act(async () => controller.select(listed!))
  await advance(2000)
}

describe("useMentraLivePairing", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    platformOS = "android"
    results = []
    audioSetup = {state: "connected"}
    targetReady = false
    identity = {kind: "none"}
    bonded = null
    Object.values(listeners).forEach((set) => set.clear())
    appStateListeners.clear()
    for (const fn of [...Object.values(fakePairing), ...Object.values(fakeGlasses), onExit, onFinished]) {
      if (typeof fn === "function" && "mockClear" in fn) (fn as {mockClear: () => void}).mockClear()
    }
    fakePairing.pair.mockImplementation(() => Promise.resolve())
    fakePairing.diagnoseEmptyScan.mockImplementation(() => Promise.resolve(null))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("a Bluetooth-only host gets the identity and audio relay readiness reads", async () => {
    await renderFlow({initializeRuntime: true})
    expect(startPairingProjection).toHaveBeenCalledTimes(1)
    expect(fakePairing.scan).toHaveBeenCalledWith("Mentra Live")
  })

  test("a host that started the engine starts nothing", async () => {
    startPairingProjection.mockClear()
    await renderFlow()
    expect(startPairingProjection).not.toHaveBeenCalled()
  })

  test("marks Mentra Live pending and scans on entry", async () => {
    await renderFlow()
    expect(fakePairing.markPendingSelection).toHaveBeenCalledWith("Mentra Live")
    expect(fakePairing.scan).toHaveBeenCalledWith("Mentra Live")
    expect(controller.state).toMatchObject({page: "scan", status: "searching", scanning: true})
  })

  test("lists glasses by their code and never auto-connects one", async () => {
    await renderFlow()
    await emitResults([live("MENTRA_LIVE_BLE_E511", {pairingMode: false, securePairingCapable: true})])
    expect(controller.state).toMatchObject({
      page: "scan",
      status: "choosing",
      someNotInPairingMode: true,
      glasses: [{label: "E511", inPairingMode: false}],
    })
    await advance(20_000)
    expect(fakePairing.pair).not.toHaveBeenCalled()
  })

  test("rescans every 45 seconds while glasses are listed", async () => {
    await renderFlow()
    await emitResults([live("MENTRA_LIVE_BLE_E511")])
    fakePairing.scan.mockClear()
    await advance(45_000)
    expect(fakePairing.scan).toHaveBeenCalledTimes(1)
  })

  test("gives up after 15 seconds with nothing found, and says when matching glasses are in use", async () => {
    fakePairing.diagnoseEmptyScan.mockImplementation(() => Promise.resolve({code: "device_connected_on_phone"}))
    await renderFlow()
    await advance(15_000)
    expect(fakePairing.stopScan).toHaveBeenCalled()
    expect(controller.state).toMatchObject({page: "scan", status: "in_use", scanning: false})
  })

  test("Scan Again starts over in place", async () => {
    await renderFlow()
    await advance(15_000)
    expect(controller.state).toMatchObject({status: "not_found"})
    await act(async () => controller.scanAgain())
    expect(controller.state).toMatchObject({page: "scan", status: "searching", scanning: true})
    expect(onExit).not.toHaveBeenCalled()
  })

  test("connects bonded glasses once without a choice", async () => {
    bonded = live("MENTRA_LIVE_BLE_BOND")
    await renderFlow()
    expect(controller.state).toMatchObject({page: "connecting", device: {name: "MENTRA_LIVE_BLE_BOND"}})
    await advance(2000)
    expect(fakePairing.pair).toHaveBeenCalledTimes(1)
  })

  test("back from the scan abandons the attempt and leaves", async () => {
    await renderFlow()
    await act(async () => controller.back())
    await act(async () => controller.back())
    expect(fakePairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith("scan")
  })

  test("pairs after two seconds and shows success once the glasses are ready", async () => {
    await renderFlow()
    await selectAndPair()
    expect(fakePairing.pair).toHaveBeenCalledTimes(1)
    expect(fakePairing.waitForReady).toHaveBeenCalled()
    targetReady = true
    await act(async () => listeners.target.forEach((listener) => listener(true)))
    expect(controller.state.page).toBe("connecting")
    await advance(1000)
    expect(controller.state.page).toBe("success")
    await act(async () => controller.finish())
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  test("opens Pair Audio when audio needs the person, then succeeds once audio connects", async () => {
    audioSetup = {state: "needs_user"}
    await renderFlow()
    await selectAndPair()
    targetReady = true
    await act(async () => listeners.target.forEach((listener) => listener(true)))
    expect(controller.state).toMatchObject({page: "pair_audio", canCancel: true, deviceName: "MENTRA_LIVE_BLE_E511"})
    expect(fakePairing.setBluetoothClassicTarget).toHaveBeenCalled()
    audioSetup = {state: "connected"}
    await act(async () => listeners.readiness.forEach((listener) => listener()))
    await advance(1000)
    expect(controller.state.page).toBe("success")
  })

  test("routes a pair failure to the failure page, and a failure during the success delay wins", async () => {
    await renderFlow()
    await selectAndPair()
    targetReady = true
    await act(async () => listeners.target.forEach((listener) => listener(true)))
    await act(async () => listeners.failure.forEach((listener) => listener({error: "errors:pairingBatteryTooLow"})))
    await advance(1000)
    expect(controller.state).toMatchObject({page: "failure", error: "errors:pairingBatteryTooLow"})
    expect(fakePairing.abandonAttempt).toHaveBeenCalled()
  })

  test("a kickoff rejection shows the could-not-start failure", async () => {
    fakePairing.pair.mockImplementation(() => Promise.reject(new Error("Bluetooth off")))
    await renderFlow()
    await selectAndPair()
    expect(controller.state).toMatchObject({page: "failure", error: "errors:pairingCouldNotStart"})
  })

  test("on iPhone, a stale bond asks the person to forget it, and coming back returns to the list", async () => {
    platformOS = "ios"
    await renderFlow()
    await selectAndPair()
    await act(async () =>
      listeners.failure.forEach((listener) => listener({error: "pairing:failed", code: "ios_forget_pairing"})),
    )
    expect(controller.state).toMatchObject({page: "forget_ios_pairing", deviceName: "MENTRA_LIVE_BLE_E511"})
    await act(async () => appStateListeners.forEach((listener) => listener("background")))
    await act(async () => appStateListeners.forEach((listener) => listener("active")))
    expect(controller.state.page).toBe("scan")
    expect(fakePairing.pair).toHaveBeenCalledTimes(1)
  })

  test("the same code on Android is an ordinary failure", async () => {
    await renderFlow()
    await selectAndPair()
    await act(async () =>
      listeners.failure.forEach((listener) => listener({error: "pairing:failed", code: "ios_forget_pairing"})),
    )
    expect(controller.state).toMatchObject({page: "failure", error: "pairing:failed"})
  })

  test("cancelling while connecting returns to the list and ignores late events", async () => {
    await renderFlow()
    await selectAndPair()
    await act(async () => controller.back())
    expect(controller.state.page).toBe("scan")
    await act(async () => listeners.failure.forEach((listener) => listener({error: "pairing:failed"})))
    expect(controller.state.page).toBe("scan")
  })

  test("cancelling from Pair Audio unpairs glasses this attempt paired, then leaves", async () => {
    audioSetup = {state: "needs_user"}
    await renderFlow()
    await selectAndPair()
    targetReady = true
    await act(async () => listeners.target.forEach((listener) => listener(true)))
    identity = {kind: "paired", name: "MENTRA_LIVE_BLE_E511"}
    await act(async () => {
      await controller.cancelPairing()
    })
    expect(fakeGlasses.unpair).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith("pair_audio")
  })

  test("standalone Pair Audio reconnects the saved glasses once audio is up", async () => {
    await renderFlow({initialPage: "pair_audio", deviceName: "MENTRA_LIVE_BLE_E511"})
    expect(fakeGlasses.connectDefault).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  test("prep waits for the host's permissions before scanning", async () => {
    let allow = false
    await renderFlow({initialPage: "prep", prepareScan: () => Promise.resolve(allow)})
    await act(async () => controller.continueToScan())
    expect(controller.state.page).toBe("prep")
    allow = true
    await act(async () => controller.continueToScan())
    expect(controller.state.page).toBe("scan")
    await act(async () => controller.back())
    expect(controller.state.page).toBe("prep")
    expect(onExit).not.toHaveBeenCalled()
  })
})
