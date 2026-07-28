/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// --- fast timers -------------------------------------------------------------
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (cb: () => void, _ms: number) => setTimeout(cb, 1) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (cb: () => void, _ms: number) => setInterval(cb, 5) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
  },
}))

// --- native surfaces ---------------------------------------------------------
const setHotspotState = mock(async (_enabled: boolean) => undefined)
const startOtaServer = mock(async (manifestJson: string, _artifacts: Record<string, string>, host?: string | null) => ({
  baseUrl: "http://192.168.43.100:8791",
  manifestUrl: "http://192.168.43.100:8791/version.json",
  host: host ?? "192.168.43.100",
  port: 8791,
  manifestJson,
}))
const stopOtaServer = mock(async () => undefined)

// NOTE: bun's mock.module is last-write-wins process-wide (live ESM bindings), so
// engine suites that mock this same specifier interfere with each other in whole-suite
// runs — a pre-existing property of this test tree (e.g. PhoneCameraFovCoordinator and
// AudioCloudUplink already collide on dev). Suites are authoritative per-file.
mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {
    setHotspotState,
    updateGlasses: mock(() => undefined),
  },
  MentraOtaServer: {startOtaServer, stopOtaServer},
}))

mock.module("react-native", () => ({
  Platform: {OS: "android", Version: 33},
}))

mock.module("react-native-wifi-reborn", () => ({
  default: {getCurrentWifiSSID: mock(async () => "AndroidShare_1")},
}))

// --- transport + downloader --------------------------------------------------
let glassesHealthy = true
const connect = mock(async (_ssid: string, _password: string) => undefined)
const disconnect = mock(async () => undefined)
const localFetch = mock(async (_url: string) => {
  if (!glassesHealthy) throw new Error("unreachable")
  return {ok: true} as Response
})

mock.module("../asg/localNetworkTransport", () => ({
  localNetworkTransport: {
    connect,
    disconnect,
    fetch: localFetch,
    supportsScopedConnection: () => true,
    isScopedConnectionActive: () => true,
  },
}))

const prepared = [
  {kind: "apk", url: "https://cdn/apk", expectedSha256: "sha-apk", sizeBytes: 10, sha256: "sha-apk", filePath: "/a"},
]
const planArtifacts = mock(() => [{kind: "apk", url: "https://cdn/apk", expectedSha256: "sha-apk", sizeBytes: 10}])
const prepareArtifacts = mock(async () => prepared)
const rewriteManifestForLocalServer = mock(
  (_body: string, _artifacts: unknown, baseUrl: string) => `rewritten:${baseUrl}`,
)
const cleanupArtifacts = mock(async () => undefined)

mock.module("../OtaArtifactDownloader", () => ({
  planArtifacts,
  prepareArtifacts,
  rewriteManifestForLocalServer,
  cleanupArtifacts,
}))

const {hotspotOtaTransport, HotspotOtaError} = await import("../HotspotOtaTransport")
const {useGlassesStore} = await import("../../stores/glasses")

function setHotspot(enabled: boolean, ssid = "AndroidShare_1", password = "00001111") {
  useGlassesStore.getState().setHotspotInfo(enabled, ssid, password, "192.168.43.1")
}

function checkResult() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {manifestBody: JSON.stringify({apps: {}}), updates: ["apk"], mtkPatch: null} as any
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(async () => {
  if (hotspotOtaTransport.isActive()) {
    await hotspotOtaTransport.endSession({deleteArtifacts: false})
  }
  setHotspot(false)
  glassesHealthy = true
  setHotspotState.mockClear()
  startOtaServer.mockClear()
  stopOtaServer.mockClear()
  connect.mockClear()
  disconnect.mockClear()
  localFetch.mockClear()
  cleanupArtifacts.mockClear()
})

describe("beginSession", () => {
  test("downloads, joins the hotspot, and serves the rewritten manifest", async () => {
    const begin = hotspotOtaTransport.beginSession(checkResult())
    // The glasses answer the hotspot request a moment later.
    setTimeout(() => setHotspot(true), 10)
    await begin

    expect(prepareArtifacts).toHaveBeenCalled()
    expect(setHotspotState).toHaveBeenCalledWith(true)
    expect(connect).toHaveBeenCalledWith("AndroidShare_1", "00001111")
    // Two-step server start: probe start, then reconfigure with the rewritten body.
    expect(startOtaServer).toHaveBeenCalledTimes(2)
    expect(startOtaServer.mock.calls[1][0]).toBe("rewritten:http://192.168.43.100:8791")
    expect(hotspotOtaTransport.isActive()).toBe(true)
    expect(hotspotOtaTransport.currentPhase()).toBe("serving")
    await expect(hotspotOtaTransport.ensureSession()).resolves.toBe("http://192.168.43.100:8791/version.json")
  })

  test("keeps downloaded artifacts when the join fails", async () => {
    connect.mockImplementation(async () => {
      throw new Error("no association")
    })
    const begin = hotspotOtaTransport.beginSession(checkResult())
    setTimeout(() => setHotspot(true), 10)
    await expect(begin).rejects.toMatchObject({code: "hotspot_join_failed"})
    connect.mockImplementation(async () => undefined)

    expect(hotspotOtaTransport.isActive()).toBe(false)
    expect(cleanupArtifacts).not.toHaveBeenCalled()
    expect(stopOtaServer).toHaveBeenCalled()
  })

  test("refuses a second concurrent session", async () => {
    const begin = hotspotOtaTransport.beginSession(checkResult())
    setTimeout(() => setHotspot(true), 10)
    await begin
    await expect(hotspotOtaTransport.beginSession(checkResult())).rejects.toBeInstanceOf(HotspotOtaError)
  })
})

describe("ensureSession", () => {
  test("short-circuits while the glasses still answer through the link", async () => {
    const begin = hotspotOtaTransport.beginSession(checkResult())
    setTimeout(() => setHotspot(true), 10)
    await begin
    setHotspotState.mockClear()
    connect.mockClear()

    await expect(hotspotOtaTransport.ensureSession()).resolves.toBe("http://192.168.43.100:8791/version.json")
    expect(setHotspotState).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  test("re-establishes the whole link after the APK restart killed it", async () => {
    const begin = hotspotOtaTransport.beginSession(checkResult())
    setTimeout(() => setHotspot(true), 10)
    await begin
    setHotspotState.mockClear()
    connect.mockClear()
    startOtaServer.mockClear()

    // Hotspot died with the asg process; the glasses answer the new request with
    // rotated credentials once they're back up.
    glassesHealthy = false
    setTimeout(() => {
      glassesHealthy = true
      setHotspot(true, "AndroidShare_2", "22223333")
    }, 20)

    await expect(hotspotOtaTransport.ensureSession()).resolves.toBe("http://192.168.43.100:8791/version.json")
    expect(setHotspotState).toHaveBeenCalledWith(true)
    expect(connect).toHaveBeenCalledWith("AndroidShare_2", "22223333")
    expect(startOtaServer).toHaveBeenCalledTimes(2)
    expect(hotspotOtaTransport.currentPhase()).toBe("serving")
  })
})

describe("endSession", () => {
  test("tears everything down and deletes artifacts when asked", async () => {
    const begin = hotspotOtaTransport.beginSession(checkResult())
    setTimeout(() => setHotspot(true), 10)
    await begin

    await hotspotOtaTransport.endSession({deleteArtifacts: true})
    expect(hotspotOtaTransport.isActive()).toBe(false)
    expect(hotspotOtaTransport.currentPhase()).toBe("idle")
    expect(stopOtaServer).toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
    expect(cleanupArtifacts).toHaveBeenCalled()
    await settle()
  })
})
