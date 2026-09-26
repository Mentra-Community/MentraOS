import {
  LiveAvailabilityMonitor,
  type LiveAvailabilityPorts,
} from "@/../modules/engine/src/devices/mentra-live/availability"
import type {OtaSnapshot} from "@/../modules/engine/src/facades/ota"
import type {OtaCheckCurrentGlassesResult} from "@/../modules/engine/src/services/OtaUpdateCheckService"

jest.mock("../../modules/engine/src/utils/timers", () => ({
  BgTimer: {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  },
}))

const manifest = {
  versionCode: 42,
  versionName: "42",
  downloadUrl: "https://example.com/a.apk",
  apkSize: 1,
  sha256: "a",
  releaseNotes: "",
}
const result: OtaCheckCurrentGlassesResult = {
  hasCheckCompleted: true,
  updateAvailable: true,
  latestVersionInfo: manifest,
  updates: ["apk"],
  mtkPatch: null,
  besVersion: null,
  isApkDowngrade: false,
  manifestBody: JSON.stringify(manifest),
  manifestUrl: "https://example.com/manifest.json",
  releaseVersion: "3.3.0",
  updateInfo: {available: true, versionCode: 42, versionName: "42", updates: ["apk"], totalSize: 1},
  isRequired: true,
}

describe("Live background availability owner", () => {
  let state: OtaSnapshot
  let ports: LiveAvailabilityPorts
  let monitor: LiveAvailabilityMonitor
  let changed: () => void
  let owned: boolean
  let device: string | null

  beforeEach(() => {
    jest.useFakeTimers()
    owned = false
    device = "live:device-1"
    state = {
      connected: true,
      ready: true,
      buildNumber: "40",
      appVersion: "3.2.0",
      packageName: null,
      mtkFirmwareVersion: "0801",
      besFirmwareVersion: "0808",
      batteryLevel: 80,
      hotspotOtaVersion: 0,
      wifiConnected: true,
      wifiStatusKnown: true,
      manifestUrl: result.manifestUrl!,
      updateAvailable: null,
      status: null,
      legacyProgress: null,
      inProgress: false,
      mtkUpdatedThisSession: false,
    }
    ports = {
      snapshot: () => state,
      subscribe: (fn) => {
        changed = fn
        return () => {}
      },
      check: jest.fn(async () => result),
      fetchManifest: jest.fn(async () => manifest),
      clearMtkSession: jest.fn(),
      target: () => device,
      owned: () => owned,
    }
    monitor = new LiveAvailabilityMonitor(ports)
    monitor.start()
  })
  afterEach(() => {
    monitor.stop()
    jest.useRealTimers()
  })
  const tick = (ms = 500) => jest.advanceTimersByTimeAsync(ms)

  it("checks after the home settle delay and claims a prompt only once across observers", async () => {
    monitor.setHome(true)
    await tick(499)
    expect(ports.check).not.toHaveBeenCalled()
    await tick(1)
    expect(ports.check).toHaveBeenCalledTimes(1)
    const prompt = monitor.snapshot().prompt!
    expect(prompt.action).toBe("install")
    expect(monitor.claimPrompt(prompt.id)).toBe(true)
    const unobserve = monitor.subscribe(() => {})
    unobserve()
    expect(monitor.claimPrompt(prompt.id)).toBe(false)
    monitor.setHome(false)
    monitor.setHome(true)
    await tick()
    expect(ports.check).toHaveBeenCalledTimes(1)
  })

  it("caches a check completed away from home and waits for Wi-Fi inventory", async () => {
    let resolve!: (value: OtaCheckCurrentGlassesResult) => void
    ports.check = jest.fn(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    monitor.setHome(true)
    await tick()
    monitor.setHome(false)
    state = {...state, wifiStatusKnown: false, wifiConnected: false}
    resolve(result)
    await tick(0)
    monitor.setHome(true)
    expect(monitor.snapshot().prompt).toBeNull()
    state = {...state, wifiStatusKnown: true}
    changed()
    expect(monitor.snapshot().prompt?.action).toBe("wifi_setup")
    const id = monitor.snapshot().prompt!.id
    monitor.dismiss(id)
    monitor.setHome(false)
    monitor.setHome(true)
    expect(monitor.snapshot().prompt).toBeNull()
  })

  it("resumes discovery in the mounted home after suspension without replaying an old prompt", async () => {
    monitor.setHome(true)
    await tick()
    const old = monitor.snapshot().prompt!
    expect(monitor.claimPrompt(old.id)).toBe(true)
    monitor.stop()
    await tick(60_000)
    expect(ports.check).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().prompt).toBeNull()
    monitor.start()
    monitor.start()
    await tick()
    expect(ports.check).toHaveBeenCalledTimes(2)
    expect(monitor.snapshot().prompt!.id).toBeGreaterThan(old.id)
    expect(monitor.claimPrompt(old.id)).toBe(false)
    expect(monitor.claimPrompt(monitor.snapshot().prompt!.id)).toBe(true)
  })

  it("resumes only after unsafe recovery releases and discards pre-suspension checks", async () => {
    let resolve!: (value: OtaCheckCurrentGlassesResult) => void
    ports.check = jest.fn(async () => result).mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    monitor.setHome(true)
    await tick()
    monitor.stop()
    owned = true
    monitor.start()
    resolve(result)
    await tick(60_000)
    expect(ports.check).toHaveBeenCalledTimes(1)
    expect(monitor.snapshot().prompt).toBeNull()
    owned = false
    changed()
    await tick()
    expect(ports.check).toHaveBeenCalledTimes(2)
    expect(monitor.snapshot().prompt?.action).toBe("install")
  })

  it("keeps a pending Wi-Fi offer through setup and prompts install on return", async () => {
    state = {...state, wifiConnected: false}
    monitor.setHome(true)
    await tick()
    expect(monitor.snapshot().prompt?.action).toBe("wifi_setup")
    monitor.setHome(false)
    state = {...state, wifiConnected: true}
    changed()
    monitor.setHome(true)
    expect(monitor.snapshot().prompt?.action).toBe("install")
  })

  it("rejects stale publication when a managed update takes ownership during the fetch", async () => {
    let resolve!: (value: OtaCheckCurrentGlassesResult) => void
    let publish!: () => boolean
    ports.check = jest.fn((options) => {
      publish = options.canPublish!
      return new Promise((r) => {
        resolve = r
      })
    })
    monitor.setHome(true)
    await tick()
    owned = true
    expect(publish()).toBe(false)
    changed()
    resolve(result)
    await tick()
    expect(monitor.snapshot().prompt).toBeNull()
  })

  it("invalidates a disconnected or replaced device's offer", async () => {
    monitor.setHome(true)
    await tick()
    state = {...state, connected: false}
    changed()
    expect(monitor.snapshot().prompt).toBeNull()
    device = null
    state = {...state, connected: true}
    changed()
    await tick()
    expect(ports.check).toHaveBeenCalledTimes(1)
  })

  it("rechecks a changed manifest and firmware but never polls while owned", async () => {
    monitor.setHome(true)
    await tick()
    await tick(60_000)
    expect(ports.check).toHaveBeenCalledTimes(1)
    ports.fetchManifest = jest.fn(async () => ({...manifest, versionCode: 43}))
    await tick(60_000)
    expect(ports.check).toHaveBeenCalledTimes(2)
    state = {...state, besFirmwareVersion: "0809"}
    changed()
    await tick()
    expect(ports.check).toHaveBeenCalledTimes(3)
    owned = true
    await tick(60_000)
    expect(ports.fetchManifest).toHaveBeenCalledTimes(1)
  })
})
