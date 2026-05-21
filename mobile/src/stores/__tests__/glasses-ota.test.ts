import {useGlassesStore} from "../glasses"

const mockOtaStatus = {
  sessionId: "test-session-123",
  totalSteps: 3,
  currentStep: 1,
  stepType: "apk" as const,
  phase: "download" as const,
  stepPercent: 50,
  overallPercent: 17,
  status: "in_progress" as const,
  error: undefined,
}

beforeEach(() => {
  useGlassesStore.getState().reset()
})

describe("otaStatus store field", () => {
  it("starts as null", () => {
    expect(useGlassesStore.getState().otaStatus).toBeNull()
  })

  it("setOtaStatus stores the value", () => {
    useGlassesStore.getState().setOtaStatus(mockOtaStatus)
    expect(useGlassesStore.getState().otaStatus).toEqual(mockOtaStatus)
  })

  it("setOtaStatus(null) clears the value", () => {
    useGlassesStore.getState().setOtaStatus(mockOtaStatus)
    useGlassesStore.getState().setOtaStatus(null)
    expect(useGlassesStore.getState().otaStatus).toBeNull()
  })

  it("otaStatus is independent of otaProgress", () => {
    useGlassesStore.getState().setOtaStatus(mockOtaStatus)
    useGlassesStore.getState().setOtaProgress({
      stage: "download",
      status: "PROGRESS",
      progress: 30,
      bytesDownloaded: 1000,
      totalBytes: 5000,
      currentUpdate: "apk",
    })
    expect(useGlassesStore.getState().otaStatus).toEqual(mockOtaStatus)
    expect(useGlassesStore.getState().otaProgress).not.toBeNull()
  })

  it("clearOtaState does NOT clear otaStatus", () => {
    useGlassesStore.getState().setOtaStatus(mockOtaStatus)
    useGlassesStore.getState().clearOtaState()
    expect(useGlassesStore.getState().otaStatus).toEqual(mockOtaStatus)
  })

  it("reset clears otaStatus", () => {
    useGlassesStore.getState().setOtaStatus(mockOtaStatus)
    useGlassesStore.getState().reset()
    expect(useGlassesStore.getState().otaStatus).toBeNull()
  })
})

describe("wifiStatusKnown reset on disconnect", () => {
  it("resets wifiStatusKnown when connected becomes false", () => {
    useGlassesStore.getState().setGlassesInfo({connected: true, wifi: {state: "connected", ssid: "TestNetwork"}})
    expect(useGlassesStore.getState().wifiStatusKnown).toBe(true)

    useGlassesStore.getState().setGlassesInfo({connected: false})
    expect(useGlassesStore.getState().wifiStatusKnown).toBe(false)
  })

  it("sets wifiStatusKnown when wifi info arrives while connected", () => {
    useGlassesStore.getState().setGlassesInfo({connected: true})
    useGlassesStore.getState().setGlassesInfo({wifiConnected: true, wifiSsid: "TestNetwork"})
    expect(useGlassesStore.getState().wifiStatusKnown).toBe(true)
    expect(useGlassesStore.getState().wifi).toEqual({state: "connected", ssid: "TestNetwork"})
  })

  it("does not set wifiStatusKnown for non-wifi updates", () => {
    useGlassesStore.getState().setGlassesInfo({batteryLevel: 80})
    expect(useGlassesStore.getState().wifiStatusKnown).toBe(false)
  })

  it("keeps local IP optional for connected WiFi status", () => {
    useGlassesStore.getState().setGlassesInfo({
      connected: true,
      wifiConnected: true,
      wifiSsid: "Mentra",
    })

    expect(useGlassesStore.getState().wifi).toEqual({state: "connected", ssid: "Mentra"})
  })
})

describe("hotspot status store shape", () => {
  it("maps complete legacy hotspot fields to the typed enabled state", () => {
    useGlassesStore.getState().setGlassesInfo({
      hotspotEnabled: true,
      hotspotSsid: "Mentra Hotspot",
      hotspotPassword: "password",
      hotspotGatewayIp: "192.168.43.1",
    })

    expect(useGlassesStore.getState().hotspot).toEqual({
      state: "enabled",
      ssid: "Mentra Hotspot",
      password: "password",
      localIp: "192.168.43.1",
    })
  })

  it("does not manufacture an unknown hotspot state from incomplete enabled fields", () => {
    useGlassesStore.getState().setGlassesInfo({hotspotEnabled: true})

    expect(useGlassesStore.getState().hotspot).toEqual({state: "disabled"})
  })
})

describe("otaProgress monotonic guard", () => {
  it("prevents progress regression within same stage+update", () => {
    const progress1 = {
      stage: "download" as const,
      status: "PROGRESS" as const,
      progress: 50,
      bytesDownloaded: 2500,
      totalBytes: 5000,
      currentUpdate: "apk",
    }
    useGlassesStore.getState().setOtaProgress(progress1)
    expect(useGlassesStore.getState().otaProgress?.progress).toBe(50)

    const progress2 = {...progress1, progress: 30}
    useGlassesStore.getState().setOtaProgress(progress2)
    expect(useGlassesStore.getState().otaProgress?.progress).toBe(50)
  })

  it("allows progress from different stage", () => {
    useGlassesStore.getState().setOtaProgress({
      stage: "download",
      status: "PROGRESS",
      progress: 80,
      bytesDownloaded: 4000,
      totalBytes: 5000,
      currentUpdate: "apk",
    })

    useGlassesStore.getState().setOtaProgress({
      stage: "install",
      status: "STARTED",
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: 0,
      currentUpdate: "apk",
    })
    expect(useGlassesStore.getState().otaProgress?.progress).toBe(0)
    expect(useGlassesStore.getState().otaProgress?.stage).toBe("install")
  })

  it("allows same-stage progress drop after FINISHED (multi-hop APK re-download)", () => {
    useGlassesStore.getState().setOtaProgress({
      stage: "download",
      status: "FINISHED",
      progress: 100,
      bytesDownloaded: 5000,
      totalBytes: 5000,
      currentUpdate: "apk",
    })
    useGlassesStore.getState().setOtaProgress({
      stage: "download",
      status: "PROGRESS",
      progress: 12,
      bytesDownloaded: 600,
      totalBytes: 5000,
      currentUpdate: "apk",
    })
    expect(useGlassesStore.getState().otaProgress?.progress).toBe(12)
  })

  it("allows same-stage progress drop when new wave is STARTED", () => {
    useGlassesStore.getState().setOtaProgress({
      stage: "download",
      status: "PROGRESS",
      progress: 90,
      bytesDownloaded: 4500,
      totalBytes: 5000,
      currentUpdate: "apk",
    })
    useGlassesStore.getState().setOtaProgress({
      stage: "download",
      status: "STARTED",
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: 0,
      currentUpdate: "apk",
    })
    expect(useGlassesStore.getState().otaProgress?.progress).toBe(0)
  })
})
