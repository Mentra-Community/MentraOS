import {Platform} from "react-native"
import {Asset} from "expo-asset"
import {result as Res} from "typesafe-ts"
import {BUNDLED_MINIAPPS} from "@/generated/bundledMiniapps"
import {waitFor} from "@testing-library/react-native"
import {router} from "expo-router"

import {initI18n} from "@/i18n"
import mantle from "@/services/MantleManager"
import {storeUpdateScheduler} from "@/services/miniapps/storeUpdateScheduler"
import builtInMiniappCatalog from "@/services/miniapps/BuiltInMiniappCatalog"
import {mentraCallPackageName, notifyPackageName} from "@/constants/miniapps"
import {deploymentStore} from "@/services/deployment/store"
import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import type {WorkspaceDeployment} from "@/services/deployment/types"
import {storage} from "@/utils/storage"
import {shouldHideMiniapp} from "@/services/miniapps/miniappVisibility"
import {deploymentManagedMiniappSync} from "@/services/miniapps/deploymentManagedMiniappSync"
import {
  appRegistry,
  getDevAppRecords,
  audioPlaybackService,
  localDisplayManager,
  localMiniappRuntime,
  miniappLauncher,
  saveLocalAppRunningState,
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

let miniappAvailability: (packageName: string) => boolean
let requestWifiSetup: (reason?: string, packageName?: string) => Promise<void>
let routerPushSpy: jest.SpiedFunction<typeof router.push>
let syncCoreDisplayOwner: () => void
let syncGlassesPresentationState: (status: {state: string}) => void

describe("MantleManager", () => {
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  beforeAll(() => {
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  })
  afterAll(() => {
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })
  const originalPlatform = Platform.OS
  beforeAll(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
  })
  afterAll(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
  })
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
    miniappAvailability = (engine.configure as jest.Mock).mock.calls[0][0].config.isMiniappAvailable
    syncCoreDisplayOwner = (engine.miniapps.onChanged as jest.Mock).mock.calls.at(-1)![0]
    syncGlassesPresentationState = (engine.glasses.onStatus as jest.Mock).mock.calls.at(-1)![0]
  })

  afterEach(() => {
    resetMantleTestState()
    jest.clearAllTimers()
    jest.clearAllMocks()
  })

  afterAll(() => {
    storeUpdateScheduler.stop()
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

  it("uses native presentation without duplicating the Mentra card or miniapp event", async () => {
    useAppStatusStore.setState({
      apps: [{packageName: "cloud.augmentos.notify", type: "background", running: true}] as any,
    })
    syncCoreDisplayOwner()
    expect(engine.phoneNotifications.setPresentationActive).toHaveBeenLastCalledWith(true)
    ;(engine.phoneNotifications.usesNativePresentation as jest.Mock).mockReturnValueOnce(true)
    ;(engine.phoneNotifications.presentNative as jest.Mock).mockResolvedValueOnce(true)
    const forward = jest.spyOn(localMiniappRuntime, "forwardEvent")
    emitCrustEvent("phone_notification", {
      notificationId: "native-1",
      app: "Calendar",
      title: "Meeting",
      content: "Soon",
      packageName: "com.calendar",
    })
    await Promise.resolve()
    expect(engine.phoneNotifications.presentNative).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledWith("phone_notification", expect.objectContaining({notificationId: "native-1"}))
    expect(localDisplayManager.request).not.toHaveBeenCalled()
    expect(audioPlaybackService.play).not.toHaveBeenCalled()
  })

  it("does not fabricate an iOS card from G2's app-only relay", () => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    try {
      useAppStatusStore.setState({
        apps: [{packageName: "cloud.augmentos.notify", type: "background", running: true}] as any,
      })
      emitBluetoothSdkEvent("phone_notification", {
        notificationId: "ancs-metadata",
        app: "Messages",
        title: "",
        content: "",
        packageName: "com.apple.MobileSMS",
      })
      expect(localDisplayManager.request).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    }
  })

  it("preserves full-content iOS notification presentation", () => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    try {
      useAppStatusStore.setState({
        apps: [{packageName: "cloud.augmentos.notify", type: "background", running: true}] as any,
      })
      emitBluetoothSdkEvent("phone_notification", {
        notificationId: "full-ios",
        app: "Messages",
        title: "Alice",
        content: "Hello",
        packageName: "com.apple.MobileSMS",
      })
      expect(localDisplayManager.request).toHaveBeenCalledWith(
        "cloud.augmentos.notify",
        expect.objectContaining({layout: expect.objectContaining({text: "Hello"})}),
      )
    } finally {
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    }
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
    expect(message).toBe(
      "Wi-Fi setup needs your glasses connected over Bluetooth. Turn them on and wait for them to reconnect, then try again.",
    )
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

  it("keeps the bundled Store hidden and unscheduled until Store preview is enabled", async () => {
    expect(SETTINGS.miniapp_store_preview_enabled.defaultValue()).toBe(false)
    const start = jest.spyOn(storeUpdateScheduler, "start").mockResolvedValue()
    const stop = jest.spyOn(storeUpdateScheduler, "stop").mockImplementation(() => {})
    useAppStatusStore.setState({
      apps: [
        {
          packageName: "com.mentra.store",
          local: true,
          running: true,
          foregrounded: true,
        },
      ] as any,
    })
    await engine.settings.set(SETTINGS.menu_apps.key, [
      {name: "Store", packageName: "com.mentra.store", running: true},
      {name: "Notes", packageName: "com.mentra.notes", running: false},
    ])

    await (mantle as any).applyStorePreview(false)
    expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith("com.mentra.store", true)
    expect(stop).toHaveBeenCalled()
    expect(engine.miniapps.clearForeground).toHaveBeenCalled()
    expect(engine.miniapps.stop).toHaveBeenCalledWith("com.mentra.store")
    expect(engine.settings.get(SETTINGS.menu_apps.key)).toEqual([
      {name: "Notes", packageName: "com.mentra.notes", running: false},
    ])
    expect(start).not.toHaveBeenCalled()

    await (mantle as any).applyStorePreview(true)
    expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith("com.mentra.store", false)
    expect(start).toHaveBeenCalledWith(["com.mentra.store"])

    start.mockRestore()
    stop.mockRestore()
  })

  it("wires Store preview as a live availability policy and stops an already-filtered Store", async () => {
    const availability = miniappAvailability
    const get = engine.settings.get as jest.Mock
    const list = engine.miniapps.list as jest.Mock
    const originalGet = get.getMockImplementation()!
    const originalList = list.getMockImplementation()!
    let preview = false
    get.mockImplementation((key) => (key === SETTINGS.miniapp_store_preview_enabled.key ? preview : originalGet(key)))
    list.mockReturnValue([])
    const instance = mantle as unknown as {applyStorePreview: (enabled: boolean) => Promise<void>}
    try {
      expect(availability("com.mentra.store")).toBe(false)
      expect(availability("com.mentra.notes")).toBe(true)
      await instance.applyStorePreview(false)
      expect(miniappLauncher.stop).toHaveBeenCalledWith("com.mentra.store")
      expect(saveLocalAppRunningState).toHaveBeenCalledWith("com.mentra.store", false)
      preview = true
      expect(availability("com.mentra.store")).toBe(true)
    } finally {
      get.mockImplementation(originalGet)
      list.mockImplementation(originalList)
    }
  })

  it("does not reinstall an unsigned bundled version on subsequent startups", async () => {
    const methods = [
      "getInstalledVersions",
      "getActiveVersion",
      "getReleaseIdentity",
      "getPublisherKeyFingerprint",
      "wasUserUninstalled",
      "installFromLocalZip",
    ] as const
    const originals = Object.fromEntries(methods.map((key) => [key, appRegistry[key]]))
    const install = jest.fn()
    Object.assign(appRegistry, {
      getInstalledVersions: () => ["1.0.0"],
      getActiveVersion: async () => "1.0.0",
      getReleaseIdentity: () => ({source: "bundled_asset"}),
      getPublisherKeyFingerprint: () => null,
      wasUserUninstalled: () => false,
      installFromLocalZip: install,
    })
    const asset = {
      name: "com.example.fixture-1.0.0.zip",
      localUri: "file:///fixture.zip",
      downloadAsync: jest.fn(),
    } as unknown as Asset
    const instance = mantle as unknown as {installBundledMiniapp: (asset: Asset) => Promise<void>}
    try {
      await instance.installBundledMiniapp(asset)
      await instance.installBundledMiniapp(asset)
      expect(asset.downloadAsync).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
    } finally {
      Object.assign(appRegistry, originals)
    }
  })

  it.each(["live dev", "same version manual", "newer manual", "newer Store"])(
    "preserves a %s bundled-package override on startup",
    async (kind) => {
      const bootstrap = require("../../modules/engine/src/runtime/bootstrap")
      const previousConfig = bootstrap.getConfigValues()
      bootstrap.configure({
        auth: {},
        config: {
          ...previousConfig,
          bundledSystemMiniappPackages: ["com.mentra.notes", "com.mentra.store"],
          bundledStoreMiniappPackages: ["com.mentra.store"],
          bundledSystemMiniappStoreOwners: {"com.mentra.notes": "com.mentra.store"},
        },
      })
      const methods = [
        "getInstalledVersions",
        "getActiveVersion",
        "getReleaseIdentity",
        "wasUserUninstalled",
        "installFromLocalZip",
      ] as const
      const originals = Object.fromEntries(methods.map((key) => [key, appRegistry[key]]))
      const devRecords = getDevAppRecords as jest.Mock
      const deployment = jest.spyOn(deploymentStore, "getActive").mockReturnValue(createConsumerDeployment())
      const install = jest.fn()
      const active = kind === "same version manual" ? "1.0.0" : "2.0.0"
      Object.assign(appRegistry, {
        getInstalledVersions: () => [active],
        getActiveVersion: async () => active,
        getReleaseIdentity: () =>
          kind === "newer Store"
            ? {source: "system_store", storePackageName: "com.mentra.store"}
            : {source: "direct_download"},
        wasUserUninstalled: () => false,
        installFromLocalZip: install,
      })
      devRecords.mockReturnValue(kind === "live dev" ? [{packageName: "com.mentra.notes"}] : [])
      const asset = {name: "com.mentra.notes-1.0.0.zip", downloadAsync: jest.fn()} as unknown as Asset
      try {
        await (mantle as unknown as {installBundledMiniapp: (asset: Asset) => Promise<void>}).installBundledMiniapp(
          asset,
        )
        expect(asset.downloadAsync).not.toHaveBeenCalled()
        expect(install).not.toHaveBeenCalled()
      } finally {
        Object.assign(appRegistry, originals)
        devRecords.mockReturnValue([])
        bootstrap.configure({auth: {}, config: previousConfig})
        deployment.mockRestore()
      }
    },
  )

  it("continues startup bundle installation after one asset fails", async () => {
    const instance = new (mantle.constructor as new () => {
      installBundledMiniapps: () => Promise<void>
      installBundledMiniapp: (asset: Asset) => Promise<void>
    })()
    const asset = {name: "com.mentra.fixture-1.0.0.zip"} as Asset
    const fromModule = jest.spyOn(Asset, "fromModule").mockReturnValue(asset)
    const install = jest.fn(async () => {}).mockRejectedValueOnce(new Error("Invalid bundle"))
    instance.installBundledMiniapp = install
    const log = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(instance.installBundledMiniapps()).resolves.toBeUndefined()
      expect(install).toHaveBeenCalledTimes(BUNDLED_MINIAPPS.length)
      expect(log).toHaveBeenCalledWith("MANTLE: error installing bundled miniapp:", expect.any(Error))
    } finally {
      fromModule.mockRestore()
      log.mockRestore()
    }
  })

  it("skips excluded bundled miniapps without logging startup errors", async () => {
    const consumer = createConsumerDeployment()
    const workspace: WorkspaceDeployment = {
      kind: "workspace",
      source: "manual",
      activatedAt: "2026-09-22T00:00:00Z",
      workspaceOrigin: "https://enterprise.example",
      manifestUrl: "https://enterprise.example/.well-known/mentra-deployment.json",
      manifest: {
        ...consumer.manifest,
        systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.settings", "com.mentra.feedback"]},
      },
    }
    const active = jest.spyOn(deploymentStore, "getActive").mockReturnValue(workspace)
    const asset = {
      name: "com.mentra.ai-1.0.0.zip",
      downloadAsync: jest.fn(),
    } as unknown as Asset
    const fromModule = jest.spyOn(Asset, "fromModule").mockReturnValue(asset)
    const originalInstall = appRegistry.installFromLocalZip
    const install = jest.fn()
    appRegistry.installFromLocalZip = install
    const log = jest.spyOn(console, "error").mockImplementation(() => {})
    const instance = new (mantle.constructor as new () => {installBundledMiniapps: () => Promise<void>})()
    try {
      await instance.installBundledMiniapps()
      expect(asset.downloadAsync).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } finally {
      active.mockRestore()
      fromModule.mockRestore()
      appRegistry.installFromLocalZip = originalInstall
      log.mockRestore()
    }
  })

  it.each(["ios", "android"])("restores consumer bundles after workspace cleanup on %s", async (platform) => {
    const originalPlatform = Platform.OS
    Object.defineProperty(Platform, "OS", {configurable: true, value: platform})
    const active = jest.spyOn(deploymentStore, "getActive").mockReturnValue(createConsumerDeployment())
    let workspaceCopyPresent = true
    const sync = jest.spyOn(deploymentManagedMiniappSync, "sync").mockImplementation(async () => {
      workspaceCopyPresent = false
    })
    const instance = new (mantle.constructor as new () => {
      initMiniapps: () => Promise<void>
      installBundledMiniapps: () => Promise<void>
    })()
    instance.installBundledMiniapps = jest.fn(async () => {
      expect(workspaceCopyPresent).toBe(false)
    })
    try {
      await instance.initMiniapps()
      expect(instance.installBundledMiniapps).toHaveBeenCalledTimes(1)
    } finally {
      active.mockRestore()
      sync.mockRestore()
      Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
    }
  })

  it("does not resume miniapp startup after cleanup cancels its managed synchronization", async () => {
    const internal = require("@mentra/engine-host-internal") as {
      phoneLocationService?: {stopPhoneLocation: () => void}
    }
    const previousLocationService = internal.phoneLocationService
    internal.phoneLocationService = {stopPhoneLocation: jest.fn()}
    const active = jest.spyOn(deploymentStore, "getActive").mockReturnValue(createConsumerDeployment())
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const sync = jest.spyOn(deploymentManagedMiniappSync, "sync").mockImplementation(() => {
      entered()
      return pending
    })
    const cancel = jest.spyOn(deploymentManagedMiniappSync, "cancel")
    const instance = new (mantle.constructor as new () => {
      initMiniapps: () => Promise<void>
      cleanup: () => Promise<void>
      installBundledMiniapps: () => Promise<void>
    })()
    instance.installBundledMiniapps = jest.fn(async () => {})
    try {
      const initialization = instance.initMiniapps()
      await started
      await instance.cleanup()
      finish()
      await initialization
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(instance.installBundledMiniapps).not.toHaveBeenCalled()
    } finally {
      finish()
      internal.phoneLocationService = previousLocationService
      active.mockRestore()
      sync.mockRestore()
      cancel.mockRestore()
    }
  })

  it.each([true, false])(
    "publishes Enterprise Call after startup recovery (previously enabled=%s)",
    async (previouslyEnabled) => {
      const consumer = createConsumerDeployment()
      const entry = {
        packageName: mentraCallPackageName,
        version: "2.1.29",
        bundleUrl: "https://enterprise.example/miniapps/call.zip",
        sha256: "a".repeat(64),
      }
      const workspace: WorkspaceDeployment = {
        kind: "workspace",
        source: "manual",
        activatedAt: "2026-09-22T00:00:00Z",
        workspaceOrigin: "https://enterprise.example",
        manifestUrl: "https://enterprise.example/.well-known/mentra-deployment.json",
        manifest: {
          ...consumer.manifest,
          deploymentId: "enterprise",
          features: {...consumer.manifest.features, nativeMeetings: true},
          systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.settings"]},
          miniapps: {configuration: {}, managed: [entry]},
        },
      }
      const originalPlatform = Platform.OS
      const originalIdentity = appRegistry.getReleaseIdentity
      const originalVersions = appRegistry.getInstalledVersions
      let verified = false
      const active = jest.spyOn(deploymentStore, "getActive").mockReturnValue(workspace)
      const sync = jest
        .spyOn(deploymentManagedMiniappSync, "sync")
        .mockResolvedValueOnce(undefined)
        .mockImplementation(async () => {
          verified = true
        })
      appRegistry.getInstalledVersions = jest.fn(() => [entry.version])
      appRegistry.getReleaseIdentity = jest.fn(() =>
        verified
          ? {
              source: "deployment_manifest",
              deploymentId: "enterprise",
              deploymentOrigin: workspace.workspaceOrigin,
              bundleSha256: entry.sha256,
            }
          : null,
      )
      const assets = jest.spyOn(Asset, "fromModule")
      Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
      const instance = new (mantle.constructor as new () => {
        setupIosMiniappVisibility: () => void
        initMiniapps: () => Promise<void>
        installBundledMiniapps: () => Promise<void>
        installBundledMiniapp: (asset: Asset) => Promise<void>
        iosMiniappVisibility: Map<string, {reconcile: () => Promise<void>; dispose: () => void}>
      })()
      instance.installBundledMiniapps = jest.fn(async () => {})
      try {
        await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
        storage.save("mentra_call_ios_last_enabled", previouslyEnabled)
        instance.setupIosMiniappVisibility()
        // A stale visible consumer entry is restricted before any async work.
        expect(engine.miniapps.setHiddenStatus).toHaveBeenCalledWith(mentraCallPackageName, true)
        await instance.initMiniapps()
        expect(sync).toHaveBeenCalledTimes(1)
        expect(shouldHideMiniapp(mentraCallPackageName, entry.version)).toBe(true)
        expect(engine.miniapps.setHiddenStatus).not.toHaveBeenCalledWith(mentraCallPackageName, false)
        expect(storage.load("mentra_call_ios_last_enabled")).toMatchObject({value: false})

        // The next startup succeeds: the same lifecycle must clear the forced
        // hidden flag before it finishes, without an independent second sync.
        await instance.initMiniapps()
        expect(sync).toHaveBeenCalledTimes(2)
        expect(sync).toHaveBeenLastCalledWith(workspace)
        expect(shouldHideMiniapp(mentraCallPackageName, entry.version)).toBe(false)
        expect(engine.miniapps.setHiddenStatus).toHaveBeenCalledWith(mentraCallPackageName, false)
        expect(storage.load("mentra_call_ios_last_enabled")).toMatchObject({value: true})
        // Android's general bundle loop must also honor the pin, including a
        // valid workspace with an unrestricted system-miniapp allowlist.
        workspace.manifest.systemMiniapps.approvedPackageNamesOverride = null
        Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
        const newerConsumerBundle = {
          name: "com.mentra.call-2.1.30.zip",
          downloadAsync: jest.fn(async () => {}),
        } as unknown as Asset
        await instance.installBundledMiniapp(newerConsumerBundle)
        expect(newerConsumerBundle.downloadAsync).not.toHaveBeenCalled()
        expect(assets).not.toHaveBeenCalled()
        expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(false)
      } finally {
        for (const visibility of instance.iosMiniappVisibility.values()) visibility.dispose()
        appRegistry.getReleaseIdentity = originalIdentity
        appRegistry.getInstalledVersions = originalVersions
        active.mockRestore()
        sync.mockRestore()
        assets.mockRestore()
        Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
      }
    },
  )

  it("rechecks Call policy after downloading and propagates an install failure", async () => {
    const originalPlatform = Platform.OS
    const originalVersions = appRegistry.getInstalledVersions
    const originalInstall = appRegistry.installFromLocalZip
    const originalUninstalled = appRegistry.wasUserUninstalled
    appRegistry.wasUserUninstalled = jest.fn(() => false)
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    appRegistry.getInstalledVersions = jest.fn(() => [])
    const failure = new Error("Archive installation failed")
    const install = jest.fn(() =>
      Res.try_async(async () => {
        throw failure
      }),
    )
    appRegistry.installFromLocalZip = install as unknown as typeof appRegistry.installFromLocalZip
    const instance = mantle as unknown as {installBundledMiniapp: (asset: Asset) => Promise<void>}
    const asset = {
      name: "com.mentra.call-2.1.18.zip",
      localUri: "file:///fixture/call.zip",
      downloadAsync: async () => {
        await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
      },
    } as unknown as Asset
    try {
      await engine.settings.set(SETTINGS.show_mentra_call_ios.key, true)
      await instance.installBundledMiniapp(asset)
      expect(install).not.toHaveBeenCalled()
      await engine.settings.set(SETTINGS.show_mentra_call_ios.key, true)
      asset.downloadAsync = jest.fn(async () => asset)
      await expect(instance.installBundledMiniapp(asset)).rejects.toThrow(failure)
      expect(install).toHaveBeenCalledWith(asset.localUri)
    } finally {
      appRegistry.getInstalledVersions = originalVersions
      appRegistry.installFromLocalZip = originalInstall
      appRegistry.wasUserUninstalled = originalUninstalled
      Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
    }
  })

  it.each([
    [mentraCallPackageName, SETTINGS.show_mentra_call_ios.key, SETTINGS.show_notify_ios.key],
    [notifyPackageName, SETTINGS.show_notify_ios.key, SETTINGS.show_mentra_call_ios.key],
  ])("reconciles %s independently and replaces its setting listener cleanly", async (packageName, key, otherKey) => {
    const originalPlatform = Platform.OS
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    const instance = new (mantle.constructor as new () => {
      setupIosMiniappVisibility: () => void
      setupSubscriptions: () => Promise<void>
      prepareIosCall: () => Promise<void>
      subs: Array<{remove: () => void}>
      iosMiniappVisibility: Map<string, {dispose: () => void}>
    })()
    const installCall = jest.fn(async () => {})
    instance.prepareIosCall = installCall
    const installNotify = jest.spyOn(builtInMiniappCatalog, "installNotify").mockImplementation(() => {})
    const install = packageName === mentraCallPackageName ? installCall : installNotify
    const otherInstall = packageName === mentraCallPackageName ? installNotify : installCall
    try {
      await engine.settings.set(key, false)
      await engine.settings.set(otherKey, false)
      useAppStatusStore.setState({
        apps: [
          {
            packageName: notifyPackageName,
            name: "Notify",
            type: "background",
            running: true,
            offline: true,
            local: false,
            hidden: false,
            loading: false,
            healthy: true,
            permissions: [],
            hardwareRequirements: [],
            offlineRoute: "/miniapps/settings/notifications",
            webviewUrl: "",
            logoUrl: "",
          },
        ],
      })
      instance.setupIosMiniappVisibility()
      expect(saveLocalAppRunningState).toHaveBeenCalledWith(mentraCallPackageName, false)
      expect(saveLocalAppRunningState).toHaveBeenCalledWith(notifyPackageName, false)
      expect(engine.miniapps.setHiddenStatus).toHaveBeenCalledWith(mentraCallPackageName, true)
      expect(engine.miniapps.setHiddenStatus).toHaveBeenCalledWith(notifyPackageName, true)
      await instance.setupSubscriptions()
      await engine.settings.set(key, true)
      await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith(packageName, false))
      expect(otherInstall).not.toHaveBeenCalled()
      expect(engine.settings.get(otherKey)).toBe(false)
      await instance.setupSubscriptions()
      await engine.settings.set(key, false)
      expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith(packageName, true)
      if (packageName === notifyPackageName) {
        await waitFor(() => expect(engine.phoneNotifications.setPresentationActive).toHaveBeenLastCalledWith(false))
        expect(localDisplayManager.dismiss).toHaveBeenCalledWith(notifyPackageName)
        expect(audioPlaybackService.stopForApp).toHaveBeenCalledWith(notifyPackageName)
        expect(engine.miniapps.stop).toHaveBeenCalledWith(notifyPackageName)
      }
      install.mockClear()
      await engine.settings.set(key, true)
      await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith(packageName, false))
      expect(otherInstall).not.toHaveBeenCalled()
    } finally {
      for (const visibility of instance.iosMiniappVisibility.values()) visibility.dispose()
      instance.subs.forEach((sub) => sub.remove())
      installNotify.mockRestore()
      Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
    }
  })
})

describe("runtime recovery initialization", () => {
  type Manager = {
    init: typeof mantle.init
    cleanup: typeof mantle.cleanup
    waitForMiniapps: typeof mantle.waitForMiniapps
    initialized: boolean
    initialize(options: {background?: boolean}): Promise<void>
    initServices(): Promise<void>
    installBundledMiniapps(): Promise<void>
    setupPeriodicTasks(): Promise<void>
    setupSubscriptions(): Promise<void>
  }
  const internal = require("@mentra/engine-host-internal") as {
    phoneLocationService?: {stopPhoneLocation(): void}
  }
  const originalLocationService = internal.phoneLocationService
  const originalPlatform = Platform.OS
  let manager: Manager

  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    return {promise, resolve, reject}
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    internal.phoneLocationService = {stopPhoneLocation: jest.fn()}
    jest.spyOn(deploymentStore, "getActive").mockReturnValue(createConsumerDeployment())
    jest.spyOn(deploymentManagedMiniappSync, "sync").mockResolvedValue(undefined)
    manager = new (mantle.constructor as new () => Manager)()
    jest.spyOn(manager, "installBundledMiniapps").mockResolvedValue(undefined)
    jest.spyOn(manager, "initServices").mockResolvedValue(undefined)
    jest.spyOn(manager, "setupPeriodicTasks").mockResolvedValue(undefined)
    jest.spyOn(manager, "setupSubscriptions").mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await manager.cleanup()
    internal.phoneLocationService = originalLocationService
    Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
    jest.restoreAllMocks()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it.each([false, true])(
    "runs deferred foreground synchronization once after recovery (still pending=%s)",
    async (stillPending) => {
      const start = deferred()
      jest.spyOn(engine, "start").mockReturnValueOnce(start.promise)
      const background = manager.init({background: true})
      if (!stillPending) {
        start.resolve()
        await background
        expect(deploymentManagedMiniappSync.sync).not.toHaveBeenCalled()
      }
      const activity = manager.init()
      const secondActivity = manager.init()
      if (stillPending) {
        expect(manager.initServices).not.toHaveBeenCalled()
        start.resolve()
      }
      await Promise.all([background, activity, secondActivity])
      await manager.waitForMiniapps()
      await manager.init()
      expect(engine.start).toHaveBeenCalledTimes(1)
      expect(localMiniappRuntime.initialize).toHaveBeenCalledTimes(1)
      expect(manager.initServices).toHaveBeenCalledTimes(1)
      expect(deploymentManagedMiniappSync.sync).toHaveBeenCalledTimes(1)
      expect(manager.initialized).toBe(true)
    },
  )

  it.each([false, true])("starts a fresh generation after cleanup (old startup rejects=%s)", async (rejectOld) => {
    const start = deferred()
    jest.spyOn(engine, "start").mockReturnValueOnce(start.promise).mockResolvedValue(undefined)
    const background = manager.init({background: true})
    const cancelled = expect(background).rejects.toThrow(rejectOld ? "old startup failed" : "cancelled by cleanup")
    await manager.cleanup()
    const activity = manager.init()
    const secondActivity = manager.init()
    expect(engine.start).toHaveBeenCalledTimes(1)
    if (rejectOld) start.reject(new Error("old startup failed"))
    else start.resolve()
    await Promise.all([cancelled, activity, secondActivity])
    await manager.waitForMiniapps()
    expect(engine.start).toHaveBeenCalledTimes(2)
    expect(manager.initServices).toHaveBeenCalledTimes(1)
    expect(manager.initialized).toBe(true)
  })

  it("waits for teardown before starting the next session", async () => {
    await manager.init({background: true})
    const stopped = deferred()
    jest.spyOn(audioPlaybackService, "stopForApp").mockReturnValueOnce(stopped.promise)
    const cleanup = manager.cleanup()
    const activity = manager.init()
    await Promise.resolve()
    expect(engine.start).toHaveBeenCalledTimes(1)
    stopped.resolve()
    await Promise.all([cleanup, activity])
    await manager.waitForMiniapps()
    expect(engine.start).toHaveBeenCalledTimes(2)
    expect(manager.initialized).toBe(true)
  })

  it("retries failed foreground reconciliation without restarting the runtime", async () => {
    await manager.init({background: true})
    jest.mocked(deploymentManagedMiniappSync.sync).mockRejectedValueOnce(new Error("sync failed"))
    await manager.init()
    await expect(manager.waitForMiniapps()).rejects.toThrow("sync failed")
    await manager.init()
    await manager.waitForMiniapps()
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(localMiniappRuntime.initialize).toHaveBeenCalledTimes(1)
    expect(deploymentManagedMiniappSync.sync).toHaveBeenCalledTimes(2)
  })

  it("does not perform deferred synchronization after cleanup", async () => {
    await manager.init({background: true})
    // Foreground reconciliation waits for local restoration on a microtask;
    // cleanup must invalidate it before it can update the signed-out session.
    const activity = manager.init()
    await manager.cleanup()
    await activity
    await expect(manager.waitForMiniapps()).resolves.toBeUndefined()
    expect(deploymentManagedMiniappSync.sync).not.toHaveBeenCalled()
  })

  it("failed background initialization does not permanently suppress startup", async () => {
    const start = jest
      .spyOn(engine, "start")
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValue(undefined)
    await expect(manager.init({background: true})).rejects.toThrow("startup failed")
    expect(manager.initialized).toBe(false)
    await manager.init()
    await manager.waitForMiniapps()
    expect(start).toHaveBeenCalledTimes(2)
    expect(manager.initialized).toBe(true)
  })
})
