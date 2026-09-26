/* eslint-disable no-restricted-imports -- Exercise the real engine report path, not the mocked public facade. */
import {emitBluetoothSdkEvent, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

import {reports} from "../../../modules/engine/src/facades/reports"
import {cloudClientService} from "../../../modules/engine/src/services/CloudClientService"
import {
  startGlassesStatusProjection,
  stopGlassesStatusProjection,
} from "../../../modules/engine/src/services/GlassesStatusProjection"
import {useCoreStore} from "../../../modules/engine/src/stores/core"
import {useSettingsStore} from "../../../modules/engine/src/stores/settings"

// Only external/native boundaries are replaced; the collector, stores, status
// projection and reports facade are the real implementations.
jest.mock("../../../modules/engine/src/services/CloudClientService", () => ({
  cloudClientService: {
    core: {
      reports: {
        submit: jest.fn(),
        addLogs: jest.fn(),
        addScreenshots: jest.fn(),
        complete: jest.fn(),
      },
    },
    hasCore: jest.fn(() => true),
    getCoreUrl: jest.fn(() => "https://core.example"),
    syncCoreTokenToBluetooth: jest.fn(),
  },
}))

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({type: "wifi", isConnected: true, isInternetReachable: true})),
  },
}))

jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(async () => ({status: "denied"})),
  getLastKnownPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(),
}))

jest.mock("../../../modules/engine/src/services/LocalMiniappRuntime", () => ({
  __esModule: true,
  default: {
    forwardEvent: jest.fn(),
    getDiagnosticSnapshot: jest.fn(() => ({connectedApps: []})),
  },
}))

// Synthetic sentinels only. The native status carries a stale account that
// differs from the one currently held in the settings store.
const STALE_NATIVE_EMAIL = "stale-native-sentinel@example.invalid"
const STALE_NATIVE_CORE_TOKEN = "STALE_NATIVE_CORE_TOKEN_SENTINEL"
const STALE_NATIVE_AUTH_TOKEN = "STALE_NATIVE_AUTH_TOKEN_SENTINEL"
const CURRENT_SETTINGS_EMAIL = "current-settings-sentinel@example.invalid"
const CURRENT_SETTINGS_CORE_TOKEN = "CURRENT_SETTINGS_CORE_TOKEN_SENTINEL"
const CURRENT_SETTINGS_AUTH_TOKEN = "CURRENT_SETTINGS_AUTH_TOKEN_SENTINEL"
const SECRET_VALUES = [
  STALE_NATIVE_EMAIL,
  STALE_NATIVE_CORE_TOKEN,
  STALE_NATIVE_AUTH_TOKEN,
  CURRENT_SETTINGS_EMAIL,
  CURRENT_SETTINGS_CORE_TOKEN,
  CURRENT_SETTINGS_AUTH_TOKEN,
]

const ORDINARY_NATIVE_STATUS = {
  searching: true,
  currentMic: "phone",
  otherBtConnected: true,
  lastLog: ["ordinary-core-log-sentinel"],
}

const NATIVE_STATUS_WITH_ACCOUNT = {
  ...ORDINARY_NATIVE_STATUS,
  auth_email: STALE_NATIVE_EMAIL,
  core_token: STALE_NATIVE_CORE_TOKEN,
  auth_token: STALE_NATIVE_AUTH_TOKEN,
}

const SETTINGS_ACCOUNT = {
  auth_email: CURRENT_SETTINGS_EMAIL,
  core_token: CURRENT_SETTINGS_CORE_TOKEN,
  auth_token: CURRENT_SETTINGS_AUTH_TOKEN,
}

const submitMock = cloudClientService.core.reports.submit as jest.Mock
const addLogsMock = cloudClientService.core.reports.addLogs as jest.Mock
const completeMock = cloudClientService.core.reports.complete as jest.Mock

describe("report diagnostic context redaction", () => {
  let originalSettings: Record<string, unknown>

  beforeEach(async () => {
    submitMock.mockReset().mockResolvedValue({reportId: "report-redaction", status: "collecting"})
    addLogsMock.mockReset().mockResolvedValue({stored: 1})
    completeMock.mockReset().mockResolvedValue({status: "ready"})

    originalSettings = useSettingsStore.getState().settings
    useSettingsStore.setState({settings: {...originalSettings, ...SETTINGS_ACCOUNT}})

    // Deliver the account-bearing snapshot through the production native
    // Bluetooth status projection into the core store.
    stopGlassesStatusProjection()
    await startGlassesStatusProjection()
    emitBluetoothSdkEvent("bluetooth_status", NATIVE_STATUS_WITH_ACCOUNT)
  })

  afterEach(() => {
    stopGlassesStatusProjection()
    resetBluetoothSdkMock()
    useCoreStore.getState().reset()
    useSettingsStore.setState({settings: originalSettings})
  })

  it("omits native and settings account credentials from a submitted bug report", async () => {
    expect(useCoreStore.getState()).toMatchObject(NATIVE_STATUS_WITH_ACCOUNT)

    const reporting = {surface: "sentinel_surface", route: "/sentinel/route"}
    await expect(
      reports.submit({
        kind: "bug",
        trigger: {type: "manual", source: "sentinel_source", reason: "manual_bug_report"},
        report: {actualBehavior: "Sentinel report"},
        context: {reporting},
      }),
    ).resolves.toMatchObject({status: "submitted", reportId: "report-redaction"})

    expect(submitMock).toHaveBeenCalledTimes(1)
    const context = submitMock.mock.calls[0][0].context
    const runtime = context.runtime as {core: Record<string, unknown>}

    for (const key of ["auth_email", "core_token", "auth_token"]) {
      expect(runtime.core).not.toHaveProperty(key)
      expect(context.settings).not.toHaveProperty(key)
    }
    const serialized = JSON.stringify(context)
    for (const secret of SECRET_VALUES) {
      expect(serialized).not.toContain(secret)
    }

    // Ordinary Bluetooth runtime status and the caller's overlay survive.
    expect(runtime.core).toMatchObject(ORDINARY_NATIVE_STATUS)
    expect(context.reporting).toEqual(reporting)

    // Redaction is report-only: the source stores keep their values.
    expect(useCoreStore.getState()).toMatchObject(NATIVE_STATUS_WITH_ACCOUNT)
    expect(useSettingsStore.getState().settings).toMatchObject(SETTINGS_ACCOUNT)
  })
})
