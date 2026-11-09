import {act, render} from "@testing-library/react-native"
import {Alert} from "react-native"

import {OtaUpdateChecker} from "@/effects/OtaUpdateChecker"
import showAlert from "@/utils/AlertUtils"
import {hasAlertHost} from "@/contexts/ModalContext"

type CheckResult = {
  updateAvailable: boolean
  latestVersionInfo: unknown
  updates: string[]
  isApkDowngrade: boolean
  skippedReason?: string
  manifestUrl?: string
  manifestBody?: string
}

const mockSnapshot = {
  connected: true,
  buildNumber: "304000237",
  wifiConnected: false,
  wifiStatusKnown: true,
  hotspotOtaVersion: 1,
  mtkFirmwareVersion: "MentraLive_20260923.0",
  besFirmwareVersion: "26.11.7.48",
  inProgress: false,
  manifestUrl: "https://example.test/manifest.json",
  mtkUpdatedThisSession: false,
}
const mockPendingChecks: Array<(result: CheckResult) => void> = []
const mockTimers: Array<() => void> = []

jest.mock("@mentra/engine", () => ({
  SETTINGS: {default_wearable: {key: "default_wearable"}, super_mode: {key: "super_mode"}},
  useSetting: (key: string) => [key === "default_wearable" ? "Mentra Live" : false],
  getModelCapabilities: () => ({hasOta: true}),
  BgTimer: {
    setTimeout: (callback: () => void) => mockTimers.push(callback),
    clearTimeout: jest.fn(),
    setInterval: jest.fn(() => 1),
    clearInterval: jest.fn(),
  },
  engine: {
    ota: {
      snapshot: () => mockSnapshot,
      onSnapshot: () => () => {},
      markMtkUpdatedThisSession: jest.fn(),
      checkForUpdates: () => new Promise<CheckResult>((resolve) => mockPendingChecks.push(resolve)),
    },
  },
}))
jest.mock("@/hooks/useEngineSnapshot", () => ({useEngineSnapshot: (getSnapshot: () => unknown) => getSnapshot()}))
jest.mock("expo-router", () => ({usePathname: () => "/home"}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: jest.fn()}))
jest.mock("@/contexts/ModalContext", () => ({hasAlertHost: jest.fn(() => true)}))
jest.mock("@/i18n/translate", () => ({translate: (key: string) => key}))

const besUpdate: CheckResult = {
  updateAvailable: true,
  latestVersionInfo: {},
  updates: ["bes"],
  isApkDowngrade: false,
}

/** Runs the 500 ms delayed checks that are due, and lets their results settle. */
async function runDueChecks() {
  await act(async () => {
    mockTimers.splice(0).forEach((run) => run())
  })
}

async function resolveCheck(index: number, result: CheckResult) {
  await act(async () => {
    mockPendingChecks[index]!(result)
  })
}

describe("OtaUpdateChecker on reconnect", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPendingChecks.length = 0
    mockTimers.length = 0
    jest.mocked(hasAlertHost).mockReturnValue(true)
  })

  it("offers the update once when the app remounts while a check is in flight", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    // The glasses reconnect and the first checker starts its check...
    const first = render(<OtaUpdateChecker />)
    await runDueChecks()
    expect(mockPendingChecks).toHaveLength(1)

    // ...then Android recreates the activity: the root remounts on the live JS runtime.
    first.unmount()
    render(<OtaUpdateChecker />)
    await runDueChecks()
    expect(mockPendingChecks).toHaveLength(2)

    // The first checker's check finishes after it unmounted: nothing is shown for it.
    await resolveCheck(0, besUpdate)
    expect(showAlert).not.toHaveBeenCalled()

    // The live checker offers the update, once, on the sheet.
    await resolveCheck(1, besUpdate)
    expect(showAlert).toHaveBeenCalledTimes(1)
    expect(jest.mocked(showAlert).mock.calls[0]![0]).toBe("ota:updateAvailable")
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it("never falls back to a system alert when the sheet isn't mounted", async () => {
    jest.mocked(hasAlertHost).mockReturnValue(false)
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {})

    render(<OtaUpdateChecker />)
    await runDueChecks()
    await resolveCheck(0, besUpdate)

    expect(showAlert).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})
