import {waitFor} from "@testing-library/react-native"
import {router} from "expo-router"

import {initI18n} from "@/i18n"
import mantle from "@/services/MantleManager"
import {
  audioPlaybackService,
  localDisplayManager,
  localMiniappRuntime,
  useAppStatusStore,
  useCoreStore,
  useDisplayStore,
  useSettingsStore,
} from "@mentra/engine-host-internal"
// This test resets the concrete glasses store; the package-level Jest mock does
// not expose it through @mentra/engine.
// eslint-disable-next-line no-restricted-imports
import {isGlassesConnected, useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {engine, SETTINGS} from "@mentra/engine"
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

const mockShowAlert = jest.fn()
jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockShowAlert(...args),
  showAlert: (...args: unknown[]) => mockShowAlert(...args),
}))

// gallerySyncService moved into @mentra/engine; the global @mentra/engine jest mock
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
  useAppStatusStore.setState({apps: []})
  useCoreStore.getState().reset()
  useGlassesStore.getState().reset()
  useSettingsStore.getState().resetAllSettingsLocally()
  useDisplayStore.setState({view: "main"})
}

let requestWifiSetup: (reason?: string, packageName?: string) => Promise<void>
let routerPushSpy: jest.SpiedFunction<typeof router.push>
let syncCoreDisplayOwner: () => void
let syncGlassesPresentationState: (status: {state: string}) => void

describe("MantleManager", () => {
  beforeAll(async () => {
    // Alerts surface translated copy (e.g. the Wi-Fi-needs-glasses blocker), so
    // initialize i18n before init(); otherwise translate() returns raw keys.
    await initI18n()
    routerPushSpy = jest.spyOn(router, "push").mockImplementation(() => {})
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    resetCrustModuleMock()
    resetMantleTestState()
    // The V1 settings pull is retired; seed what its mock used to return so
    // the glasses-sync assertions still exercise the propagation path.
    useSettingsStore.setState((state) => ({
      settings: {...state.settings, contextual_dashboard: true, auth_email: "from-server@example.com"},
    }))
    await mantle.init()
    requestWifiSetup = (engine.configure as jest.Mock).mock.calls[0][0].ui.requestWifiSetup
    syncCoreDisplayOwner = (useAppStatusStore.subscribe as jest.Mock).mock.calls.at(-1)![0]
    syncGlassesPresentationState = (engine.glasses.onStatus as jest.Mock).mock.calls.at(-1)![0]
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

    // Local transcripts no longer roundtrip through the cloud. With no
    // local-miniapp subscription, the transcript is simply dropped.
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

  it("syncs the notification blocklist to Crust without an extra listener gate", async () => {
    ;(bluetoothSdkMock.updateBluetoothSettings as jest.Mock).mockClear()
    ;(crustModuleMock.setNotificationConfig as jest.Mock).mockClear()

    await useSettingsStore.getState().setSetting(SETTINGS.notifications_blocklist.key, ["com.blocked"], false)

    await waitFor(() => {
      expect(crustModuleMock.setNotificationConfig).toHaveBeenLastCalledWith(true, ["com.blocked"])
    })
    expect(bluetoothSdkMock.updateBluetoothSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notifications_blocklist: expect.anything(),
      }),
    )
  })

  it("keeps the running standard miniapp as display core when Notifications is background", () => {
    useAppStatusStore.setState({
      apps: [
        {packageName: "com.mentra.captions", type: "standard", running: true},
        {packageName: "cloud.augmentos.notify", type: "background", running: true},
      ] as any,
    })

    syncCoreDisplayOwner()

    expect(localDisplayManager.onCoreAppChange).toHaveBeenLastCalledWith("com.mentra.captions")
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

  it("routes notification events without the retired V1 upload", async () => {
    // The Cloud V1 REST upload is gone; the events still flow through the
    // local-miniapp forward path without a server roundtrip.
    useAppStatusStore.setState({
      apps: [{packageName: "cloud.augmentos.notify", type: "background", running: true}] as any,
    })
    const forwardEvent = jest.spyOn(localMiniappRuntime, "forwardEvent")
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
    emitBluetoothSdkEvent("phone_notification", {
      notificationId: "ancs-42",
      app: "com.apple.mobilemail",
      title: "Build complete",
      content: "The iOS relay is working",
      priority: "1",
      timestamp: 12345,
      packageName: "com.apple.mobilemail",
    })
    emitBluetoothSdkEvent("phone_notification_dismissed", {
      notificationId: "ancs-42",
      notificationKey: "ancs-42",
      packageName: "com.apple.mobilemail",
      timestamp: 12346,
    })

    expect(forwardEvent).toHaveBeenCalledWith("phone_notification", {
      notificationId: "ancs-42",
      app: "com.apple.mobilemail",
      title: "Build complete",
      content: "The iOS relay is working",
      priority: "1",
      timestamp: 12345,
      packageName: "com.apple.mobilemail",
    })
    expect(forwardEvent).toHaveBeenCalledWith("phone_notification_dismissed", {
      notificationId: "ancs-42",
      notificationKey: "ancs-42",
      packageName: "com.apple.mobilemail",
      timestamp: 12346,
    })
    expect(localDisplayManager.request).toHaveBeenNthCalledWith(1, "cloud.augmentos.notify", {
      layout: {
        layoutType: "reference_card",
        title: "Calendar: Standup",
        text: "Daily sync",
      },
      durationMs: 5_000,
    })
    expect(localDisplayManager.request).toHaveBeenNthCalledWith(2, "cloud.augmentos.notify", {
      layout: {
        layoutType: "reference_card",
        title: "com.apple.mobilemail: Build complete",
        text: "The iOS relay is working",
      },
      durationMs: 5_000,
    })
    expect(localDisplayManager.dismiss).toHaveBeenCalledTimes(2)
    expect(localDisplayManager.dismiss).toHaveBeenLastCalledWith("cloud.augmentos.notify")
    await Promise.resolve()
  })

  it("forwards notifications without presenting them when Notify is not running", () => {
    const forwardEvent = jest.spyOn(localMiniappRuntime, "forwardEvent")

    emitCrustEvent("phone_notification", {
      notificationId: "n-hidden",
      app: "Calendar",
      title: "Standup",
      content: "Daily sync",
      priority: 0,
      timestamp: "12345",
      packageName: "com.calendar",
    })

    expect(forwardEvent).toHaveBeenCalledWith("phone_notification", {
      notificationId: "n-hidden",
      app: "Calendar",
      title: "Standup",
      content: "Daily sync",
      priority: "0",
      timestamp: 12345,
      packageName: "com.calendar",
    })
    expect(localDisplayManager.request).not.toHaveBeenCalled()
  })

  it("does not speak notifications through the phone after glasses disconnect", () => {
    useAppStatusStore.setState({
      apps: [{packageName: "cloud.augmentos.notify", type: "background", running: true}] as any,
    })
    ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "disconnected"})
    ;(engine.glasses.capabilities as jest.Mock).mockReturnValue({
      hasDisplay: false,
      hasSpeaker: true,
    })

    emitCrustEvent("phone_notification", {
      notificationId: "n-disconnected",
      app: "Messages",
      title: "Private",
      content: "Do not read on phone",
      priority: 0,
      timestamp: "12345",
      packageName: "com.messages",
    })

    expect(audioPlaybackService.play).not.toHaveBeenCalled()
  })

  it("cancels queued and active notification speech when glasses disconnect", () => {
    const manager = mantle as any
    manager.suppressedNotifications = 2
    manager.scheduleSuppressedSummary()
    const generation = manager.speechGeneration

    syncGlassesPresentationState({state: "connected"})
    syncGlassesPresentationState({state: "disconnected"})

    expect(audioPlaybackService.stopForApp).toHaveBeenCalledWith("cloud.augmentos.notify")
    expect(manager.suppressedSummaryTimer).toBeNull()
    expect(manager.suppressedNotifications).toBe(0)
    expect(manager.speechGeneration).toBe(generation + 1)
  })

  it("dismisses presentation and stops queued speech when Notify stops", async () => {
    useAppStatusStore.setState({
      apps: [{packageName: "cloud.augmentos.notify", type: "background", running: true}] as any,
    })
    syncCoreDisplayOwner()
    emitCrustEvent("phone_notification", {
      notificationId: "n-active",
      app: "Calendar",
      title: "Standup",
      content: "Daily sync",
      priority: 0,
      timestamp: "12345",
      packageName: "com.calendar",
    })
    ;(localDisplayManager.dismiss as jest.Mock).mockClear()
    ;(audioPlaybackService.stopForApp as jest.Mock).mockClear()

    useAppStatusStore.setState({
      apps: [{packageName: "cloud.augmentos.notify", type: "background", running: false}] as any,
    })
    syncCoreDisplayOwner()

    expect(localDisplayManager.dismiss).toHaveBeenCalledWith("cloud.augmentos.notify")
    expect(audioPlaybackService.stopForApp).toHaveBeenCalledWith("cloud.augmentos.notify")
    await Promise.resolve()
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

  it("refuses Wi-Fi setup while the glasses are off Bluetooth and says why", async () => {
    ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "disconnected"})

    const request = requestWifiSetup("Streaming needs Wi-Fi", "com.mentra.call")
    const [title, message, buttons] = mockShowAlert.mock.calls.at(-1)!

    expect(title).toBe("Reconnect your glasses")
    expect(message).toMatch(/connected over Bluetooth/)
    expect(buttons).toHaveLength(1)
    expect(buttons[0].text).toBe("OK")
    buttons[0].onPress()
    await request

    // The miniapp stays in the foreground and no Wi-Fi route is pushed.
    expect(engine.miniapps.clearForeground).not.toHaveBeenCalled()
    expect(routerPushSpy).not.toHaveBeenCalled()
  })

  it("prompts before opening Wi-Fi setup and backgrounds the requesting miniapp", async () => {
    ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "connected"})
    const cancelRequest = requestWifiSetup("Streaming needs Wi-Fi")
    const [, message, cancelButtons] = mockShowAlert.mock.calls.at(-1)!

    expect(message).toBe("Streaming needs Wi-Fi")
    expect(engine.miniapps.clearForeground).not.toHaveBeenCalled()
    cancelButtons[0].onPress()
    await cancelRequest
    expect(engine.miniapps.clearForeground).not.toHaveBeenCalled()

    const confirmRequest = requestWifiSetup("Streaming needs Wi-Fi", "com.mentra.livestreamer")
    const confirmButtons = mockShowAlert.mock.calls.at(-1)![2]
    confirmButtons[1].onPress()
    await confirmRequest

    expect(engine.miniapps.clearForeground).toHaveBeenCalledTimes(1)
    expect(routerPushSpy).toHaveBeenLastCalledWith({
      pathname: "/wifi/scan",
      params: {returnToMiniapp: "com.mentra.livestreamer"},
    })
  })
})
