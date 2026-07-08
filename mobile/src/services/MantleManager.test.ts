import {waitFor} from "@testing-library/react-native"

import mantle from "@/services/MantleManager"
import restComms from "@/services/RestComms"
import {useCoreStore} from "@/stores/core"
import {useDisplayStore} from "@/stores/display"
import {isGlassesConnected, useGlassesStore} from "../../modules/island/src/stores/glasses"
import {SETTINGS} from "@mentra/island"
import {useSettingsStore} from "@mentra/island/internal"
import {crustModuleMock, emitCrustEvent, resetCrustModuleMock} from "@/test-utils/mockCrustModule"
import {
  bluetoothSdkMock,
  emitBluetoothSdkEvent,
  getBluetoothSdkListenerCount,
  resetBluetoothSdkMock,
} from "@/test-utils/mockBluetoothSdk"

jest.mock("@mentra/bluetooth-sdk-internal", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
  }
})

jest.mock("@mentra/crust", () => {
  const {crustModuleMock} = require("@/test-utils/mockCrustModule")
  return {
    __esModule: true,
    default: crustModuleMock,
  }
})

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    loadUserSettings: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
      value: {
        contextual_dashboard: true,
        core_token: "server-token",
        auth_email: "from-server@example.com",
      },
    })),
    writeUserSettings: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendPhoneNotification: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendPhoneNotificationDismissed: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendCalendarData: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendLocationData: jest.fn(),
    goodbye: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
  },
}))

jest.mock("@/services/SocketComms", () => ({
  __esModule: true,
  default: {
    connectWebsocket: jest.fn(),
    cleanup: jest.fn(),
  },
}))

// gallerySyncService moved into @mentra/island; the global @mentra/island jest mock
// already supplies it (gallerySyncService.initialize), so no local mock is needed.

jest.mock("@/services/Migrations", () => ({
  migrate: jest.fn(() => Promise.resolve()),
}))

jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {
    LOCATION: "location",
    MICROPHONE: "microphone",
  },
  checkFeaturePermissions: jest.fn(() => Promise.resolve(false)),
}))

jest.mock("@/utils/e2eMetrics", () => ({
  logE2EMetric: jest.fn(),
}))

jest.mock("expo-calendar", () => ({
  getCalendarsAsync: jest.fn(() => Promise.resolve([])),
  getEventsAsync: jest.fn(() => Promise.resolve([])),
  EntityTypes: {EVENT: "event"},
}))

jest.mock("expo-location", () => ({
  LocationAccuracy: {
    BestForNavigation: 1,
    High: 2,
    Balanced: 3,
    Low: 4,
    Lowest: 5,
  },
  stopLocationUpdatesAsync: jest.fn(() => Promise.resolve()),
  startLocationUpdatesAsync: jest.fn(() => Promise.resolve()),
  getCurrentPositionAsync: jest.fn(() =>
    Promise.resolve({
      coords: {latitude: 1, longitude: 2, accuracy: 3},
    }),
  ),
}))

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
}))

function resetMantleTestState() {
  useCoreStore.getState().reset()
  useGlassesStore.getState().reset()
  useSettingsStore.getState().resetAllSettingsLocally()
  useDisplayStore.setState({view: "main"})
}

describe("MantleManager", () => {
  beforeAll(async () => {
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    resetCrustModuleMock()
    resetMantleTestState()
    await mantle.init()
  })

  afterEach(() => {
    resetMantleTestState()
    jest.clearAllTimers()
    jest.clearAllMocks()
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("syncs native status, routes events, and forwards Bluetooth SDK setting changes", async () => {
    jest.advanceTimersByTime(1000)

    // island's GlassesSettingsSync pushes the FULL device-settings set on the glasses
    // connect transition (previously a MantleManager boot push). Simulate the connect.
    emitBluetoothSdkEvent("glasses_status", {connection: {state: "connected", fullyBooted: true}})

    expect(bluetoothSdkMock.updateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        contextual_dashboard: true,
        auth_email: "from-server@example.com",
        power_saving_mode: false,
        voice_activity_detection_enabled: true,
      }),
    )
    expect(bluetoothSdkMock.updateBluetoothSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        core_token: "",
      }),
    )
    expect(bluetoothSdkMock.updateBluetoothSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notifications_enabled: expect.anything(),
      }),
    )
    for (const nonSdkKey of ["always_on_status_bar"]) {
      expect(bluetoothSdkMock.updateBluetoothSettings).not.toHaveBeenCalledWith(
        expect.objectContaining({
          [nonSdkKey]: expect.anything(),
        }),
      )
    }
    expect(bluetoothSdkMock.updateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        metric_system: false,
        twelve_hour_time: true,
      }),
    )
    expect(crustModuleMock.setNotificationConfig).toHaveBeenCalledWith(true, [])
    expect(getBluetoothSdkListenerCount("local_transcription")).toBe(1)

    emitBluetoothSdkEvent("bluetooth_status", {searching: true, otherBtConnected: true})
    emitBluetoothSdkEvent("glasses_status", {
      connection: {state: "connected", fullyBooted: true},
      deviceModel: "Mentra Live",
      batteryLevel: 77,
    })

    expect(useCoreStore.getState().searching).toBe(true)
    expect(useCoreStore.getState().otherBtConnected).toBe(true)
    expect(isGlassesConnected(useGlassesStore.getState().connection)).toBe(true)
    expect(useGlassesStore.getState().deviceModel).toBe("Mentra Live")
    expect(useGlassesStore.getState().batteryLevel).toBe(77)

    // photo_response / touch_event routing moved into island's DeviceEventRouter
    // (covered by deviceEventRouter.test.ts); MantleManager no longer handles them.

    // Local transcripts no longer roundtrip through the cloud (SocketComms has
    // no transcription send anymore). With no local-miniapp subscription,
    // the transcript is simply dropped.
    emitBluetoothSdkEvent("local_transcription", {
      text: "hello world",
      isFinal: true,
      transcribeLanguage: "en-US",
    })
    emitBluetoothSdkEvent("head_up", {up: true})
    await waitFor(() => {
      expect(useDisplayStore.getState().view).toBe("dashboard")
    })
    // getBluetoothSettings is device-model-filtered now, and vad is not in the
    // Mentra Live key set — switch to a display model for the sync asserts.
    useGlassesStore.getState().setGlassesInfo({deviceModel: "Even Realities G1"})
    ;(bluetoothSdkMock.updateBluetoothSettings as jest.Mock).mockClear()
    await useSettingsStore.getState().setSetting(SETTINGS.core_token.key, "new-token", false)
    await useSettingsStore.getState().setSetting(SETTINGS.voice_activity_detection_enabled.key, false, false)
    // Setting pushes are debounced (300ms) and merged into one native write.
    jest.runOnlyPendingTimers()
    expect(bluetoothSdkMock.updateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        core_token: "new-token",
        voice_activity_detection_enabled: false,
      }),
    )
  })

  it("syncs notification enablement and blocklist settings to Crust only", async () => {
    ;(bluetoothSdkMock.updateBluetoothSettings as jest.Mock).mockClear()
    ;(crustModuleMock.setNotificationConfig as jest.Mock).mockClear()

    await useSettingsStore.getState().setSetting(SETTINGS.notifications_enabled.key, false, false)
    await useSettingsStore.getState().setSetting(SETTINGS.notifications_blocklist.key, ["com.blocked"], false)

    await waitFor(() => {
      expect(crustModuleMock.setNotificationConfig).toHaveBeenLastCalledWith(false, ["com.blocked"])
    })
    expect(bluetoothSdkMock.updateBluetoothSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notifications_enabled: expect.anything(),
      }),
    )
    expect(bluetoothSdkMock.updateBluetoothSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notifications_blocklist: expect.anything(),
      }),
    )
  })

  it("keeps non-SDK settings out of Bluetooth SDK sync", async () => {
    useGlassesStore.getState().setGlassesInfo({deviceModel: "Even Realities G1"})
    jest.advanceTimersByTime(300)
    ;(bluetoothSdkMock.updateBluetoothSettings as jest.Mock).mockClear()
    const nonSdkSettings = {
      always_on_status_bar: true,
      bypass_audio_encoding_for_debugging: true,
      enforce_local_transcription: true,
      offline_translation_running: true,
      offline_translation_source: "fr",
      offline_translation_target: "de",
    }

    for (const key of Object.keys(nonSdkSettings)) {
      expect(useSettingsStore.getState().getBluetoothSettings()).not.toHaveProperty(key)
    }
    ;(bluetoothSdkMock.updateBluetoothSettings as jest.Mock).mockClear()
    for (const [key, value] of Object.entries(nonSdkSettings)) {
      await useSettingsStore.getState().setSetting(key, value, false)
    }

    jest.advanceTimersByTime(300)
    for (const key of Object.keys(nonSdkSettings)) {
      expect(useSettingsStore.getState().getBluetoothSettings()).not.toHaveProperty(key)
    }
    expect(bluetoothSdkMock.updateBluetoothSettings).not.toHaveBeenCalled()

    expect(useSettingsStore.getState().getBluetoothSettings()).toHaveProperty("power_saving_mode")
    expect(useSettingsStore.getState().getBluetoothSettings()).toHaveProperty("voice_activity_detection_enabled", true)
    expect(useSettingsStore.getState().getBluetoothSettings()).toHaveProperty("metric_system")
    expect(useSettingsStore.getState().getBluetoothSettings()).toHaveProperty("twelve_hour_time")
    ;(bluetoothSdkMock.updateBluetoothSettings as jest.Mock).mockClear()
    await useSettingsStore.getState().setSetting(SETTINGS.sensing_enabled.key, false, false)
    jest.runOnlyPendingTimers()
    ;(bluetoothSdkMock.updateBluetoothSettings as jest.Mock).mockClear()
    await useSettingsStore.getState().setSetting(SETTINGS.sensing_enabled.key, true, false)
    jest.runOnlyPendingTimers()
    expect(bluetoothSdkMock.updateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        sensing_enabled: true,
      }),
    )
  })

  it("syncs standalone WiFi status events into the glasses store", () => {
    emitBluetoothSdkEvent("wifi_status_change", {
      type: "wifi_status_change",
      state: "connected",
      ssid: "Mentra",
    })

    expect(useGlassesStore.getState().wifi).toEqual({state: "connected", ssid: "Mentra"})

    emitBluetoothSdkEvent("wifi_status_change", {
      type: "wifi_status_change",
      state: "disconnected",
    })

    expect(useGlassesStore.getState().wifi).toEqual({state: "disconnected"})
  })

  it("maps notification events to REST payloads", async () => {
    ;(restComms.sendPhoneNotification as jest.Mock).mockClear()
    ;(restComms.sendPhoneNotificationDismissed as jest.Mock).mockClear()

    emitCrustEvent("phone_notification", {
      notificationId: "n-1",
      app: "Calendar",
      title: "Standup",
      content: "Daily sync",
      priority: 4,
      timestamp: "12345",
      packageName: "com.calendar",
    })
    emitCrustEvent("phone_notification_dismissed", {
      notificationId: "n-1",
      notificationKey: "key-1",
      packageName: "com.calendar",
    })

    await waitFor(() => {
      expect(restComms.sendPhoneNotification).toHaveBeenCalledWith({
        notificationId: "n-1",
        app: "Calendar",
        title: "Standup",
        content: "Daily sync",
        priority: "4",
        timestamp: 12345,
        packageName: "com.calendar",
      })
      expect(restComms.sendPhoneNotificationDismissed).toHaveBeenCalledWith({
        notificationId: "n-1",
        notificationKey: "key-1",
        packageName: "com.calendar",
      })
    })
  })

  it("tracks OTA status without allowing backward progress or stale terminal update hints", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 101,
      versionName: "1.0.1",
      updates: ["apk"],
      totalSize: 2048,
    })

    emitBluetoothSdkEvent("ota_status", {
      session_id: "session-1",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "download",
      step_percent: 80,
      overall_percent: 80,
      status: "in_progress",
    })
    emitBluetoothSdkEvent("ota_status", {
      session_id: "session-1",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "download",
      step_percent: 50,
      overall_percent: 50,
      status: "in_progress",
    })
    expect(useGlassesStore.getState().otaProgress?.progress).toBe(80)

    emitBluetoothSdkEvent("ota_status", {
      session_id: "session-1",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "install",
      step_percent: 100,
      overall_percent: 100,
      status: "complete",
    })
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
    expect(useGlassesStore.getState().otaInProgress).toBe(false)
  })
})
