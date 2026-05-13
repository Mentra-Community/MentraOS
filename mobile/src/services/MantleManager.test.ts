import {waitFor} from "@testing-library/react-native"

import mantle from "@/services/MantleManager"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {useCoreStore} from "@/stores/core"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {crustModuleMock, emitCrustEvent, resetCrustModuleMock} from "@/test-utils/mockCrustModule"
import {coreModuleMock, emitCoreModuleEvent, resetCoreModuleMock} from "@/test-utils/mockCoreModule"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

jest.mock("crust", () => {
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
    updateGlassesState: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendPhotoResponse: jest.fn(async () => ({
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
    getApplets: jest.fn(),
    configureAudioFormat: jest.fn(async () => ({
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
    sendTouchEvent: jest.fn(),
    sendBatteryStatus: jest.fn(),
    sendButtonPress: jest.fn(),
    sendHeadPosition: jest.fn(),
    sendLocalTranscription: jest.fn(),
    sendVadStatus: jest.fn(),
    sendSwipeVolumeStatus: jest.fn(),
    sendSwitchStatus: jest.fn(),
    sendRgbLedControlResponse: jest.fn(),
    sendText: jest.fn(),
    sendBinary: jest.fn(),
    sendStreamStatus: jest.fn(),
    sendKeepAliveAck: jest.fn(),
    handle_display_event: jest.fn(),
    sendLocationUpdate: jest.fn(),
  },
}))

jest.mock("@/services/asg/gallerySyncService", () => ({
  gallerySyncService: {
    initialize: jest.fn(),
  },
}))

jest.mock("@/services/UdpManager", () => ({
  __esModule: true,
  default: {
    enabledAndReady: jest.fn(() => false),
    sendAudio: jest.fn(),
    cleanup: jest.fn(),
  },
}))

jest.mock("@/services/Livekit", () => ({
  __esModule: true,
  default: {
    disconnect: jest.fn(),
  },
}))

jest.mock("@/services/Migrations", () => ({
  migrate: jest.fn(() => Promise.resolve()),
}))

jest.mock("@/services/bugReport/automaticBugReport", () => ({
  submitAutomaticBugIncident: jest.fn(async () => ({status: "filed", incidentId: "incident-1"})),
}))

jest.mock("@/stores/applets", () => ({
  useAppletStatusStore: {
    getState: () => ({
      apps: [],
      refreshApplets: jest.fn(),
      startApplet: jest.fn(),
      stopApplet: jest.fn(),
    }),
    subscribe: jest.fn(() => ({
      remove: jest.fn(),
    })),
  },
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
    resetCoreModuleMock()
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

    expect(coreModuleMock.updateCore).toHaveBeenCalledWith(
      expect.objectContaining({
        contextual_dashboard: true,
        core_token: "server-token",
        auth_email: "from-server@example.com",
        power_saving_mode: false,
      }),
    )
    expect(coreModuleMock.updateCore).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notifications_enabled: expect.anything(),
      }),
    )
    for (const nonSdkKey of ["always_on_status_bar", "metric_system"]) {
      expect(coreModuleMock.updateCore).not.toHaveBeenCalledWith(
        expect.objectContaining({
          [nonSdkKey]: expect.anything(),
        }),
      )
    }
    expect(crustModuleMock.setNotificationConfig).toHaveBeenCalledWith(true, [])

    emitCoreModuleEvent("core_status", {searching: true, otherBtConnected: true})
    emitCoreModuleEvent("glasses_status", {connected: true, deviceModel: "Mentra Live", batteryLevel: 77})

    expect(useCoreStore.getState().searching).toBe(true)
    expect(useCoreStore.getState().otherBtConnected).toBe(true)
    expect(useGlassesStore.getState().connected).toBe(true)
    expect(useGlassesStore.getState().deviceModel).toBe("Mentra Live")
    expect(useGlassesStore.getState().batteryLevel).toBe(77)

    emitCoreModuleEvent("photo_response", {
      type: "photo_response",
      state: "success",
      requestId: "req-1",
      photoUrl: "https://example.com/photo.jpg",
      timestamp: 123,
    })
    expect(restComms.sendPhotoResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        photoUrl: "https://example.com/photo.jpg",
      }),
    )

    emitCoreModuleEvent("touch_event", {
      gesture_name: "tap",
      timestamp: 999,
    })
    expect(socketComms.sendTouchEvent).toHaveBeenCalledWith({
      device_model: "Mentra Live",
      gesture_name: "tap",
      timestamp: 999,
    })

    emitCoreModuleEvent("local_transcription", {
      text: "hello world",
      isFinal: true,
      transcribeLanguage: "en-US",
    })
    await waitFor(() => {
      expect(socketComms.sendLocalTranscription).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "hello world",
          isFinal: true,
        }),
      )
    })

    emitCoreModuleEvent("head_up", {up: true})
    expect(socketComms.sendHeadPosition).toHaveBeenCalledWith(true)
    await waitFor(() => {
      expect(useDisplayStore.getState().view).toBe("dashboard")
    })

    emitCoreModuleEvent("vad_status", {type: "vad_status", status: true})
    expect(socketComms.sendVadStatus).toHaveBeenCalledWith(true)

    emitCoreModuleEvent("battery_status", {
      type: "battery_status",
      level: 88,
      charging: true,
      timestamp: 123456,
    })
    expect(socketComms.sendBatteryStatus).toHaveBeenCalledWith(88, true, 123456)
    ;(coreModuleMock.updateCore as jest.Mock).mockClear()
    await useSettingsStore.getState().setSetting(SETTINGS.core_token.key, "new-token", false)
    expect(coreModuleMock.updateCore).toHaveBeenCalledWith(
      expect.objectContaining({
        core_token: "new-token",
      }),
    )
  })

  it("syncs notification enablement and blocklist settings to Crust only", async () => {
    ;(coreModuleMock.updateCore as jest.Mock).mockClear()
    ;(crustModuleMock.setNotificationConfig as jest.Mock).mockClear()

    await useSettingsStore.getState().setSetting(SETTINGS.notifications_enabled.key, false, false)
    await useSettingsStore.getState().setSetting(SETTINGS.notifications_blocklist.key, ["com.blocked"], false)

    await waitFor(() => {
      expect(crustModuleMock.setNotificationConfig).toHaveBeenLastCalledWith(false, ["com.blocked"])
    })
    expect(coreModuleMock.updateCore).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notifications_enabled: expect.anything(),
      }),
    )
    expect(coreModuleMock.updateCore).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notifications_blocklist: expect.anything(),
      }),
    )
  })

  it("keeps non-SDK settings out of Bluetooth SDK sync", async () => {
    const nonSdkSettings = {
      always_on_status_bar: true,
      bypass_vad_for_debugging: false,
      bypass_audio_encoding_for_debugging: true,
      metric_system: true,
      enforce_local_transcription: true,
      offline_translation_running: true,
      offline_translation_source: "fr",
      offline_translation_target: "de",
    }

    for (const key of Object.keys(nonSdkSettings)) {
      expect(useSettingsStore.getState().getCoreSettings()).not.toHaveProperty(key)
    }
    ;(coreModuleMock.updateCore as jest.Mock).mockClear()
    for (const [key, value] of Object.entries(nonSdkSettings)) {
      await useSettingsStore.getState().setSetting(key, value, false)
    }

    for (const key of Object.keys(nonSdkSettings)) {
      expect(useSettingsStore.getState().getCoreSettings()).not.toHaveProperty(key)
    }
    expect(coreModuleMock.updateCore).not.toHaveBeenCalled()

    expect(useSettingsStore.getState().getCoreSettings()).toHaveProperty("power_saving_mode")
    await useSettingsStore.getState().setSetting(SETTINGS.power_saving_mode.key, true, false)
    expect(coreModuleMock.updateCore).toHaveBeenCalledWith(
      expect.objectContaining({
        power_saving_mode: true,
      }),
    )
  })

  it("renders offline local transcription locally instead of forwarding it to cloud", async () => {
    ;(socketComms.sendLocalTranscription as jest.Mock).mockClear()
    ;(socketComms.handle_display_event as jest.Mock).mockClear()

    await useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, true, false)

    emitCoreModuleEvent("local_transcription", {
      text: "offline words",
      isFinal: true,
      transcribeLanguage: "en-US",
    })

    await waitFor(() => {
      expect(socketComms.handle_display_event).toHaveBeenCalledWith(
        expect.objectContaining({
          view: "main",
          layout: expect.objectContaining({
            layoutType: "text_wall",
            text: expect.stringContaining("offline words"),
          }),
        }),
      )
    })
    expect(socketComms.sendLocalTranscription).not.toHaveBeenCalled()

    await useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, false, false)
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

  it("files captions tester incidents from Crust instead of Bluetooth SDK", async () => {
    ;(submitAutomaticBugIncident as jest.Mock).mockClear()

    emitCoreModuleEvent("captions_tester_incident", {
      failure_code: "stale_transcript",
      failure_message: "Bluetooth SDK should not own this app-level flow",
      test_run_id: "run-from-sdk",
    })

    expect(submitAutomaticBugIncident).not.toHaveBeenCalled()

    emitCrustEvent("captions_tester_incident", {
      failure_code: "stale_transcript",
      failure_message: "Transcript stayed stale",
      test_run_id: "run-1",
      scenario_name: "live_words",
    })

    await waitFor(() => {
      expect(submitAutomaticBugIncident).toHaveBeenCalledWith(
        expect.objectContaining({
          categorization: expect.objectContaining({
            triggerArea: "captions_tester",
            triggerReason: "captions_incident_detected",
          }),
          actualBehavior: expect.stringContaining("Transcript stayed stale"),
          dedupeKey: "captions_tester|stale_transcript|live_words|run-1",
          logTag: "CaptionsTesterBugReport",
        }),
      )
    })
  })

  it("tracks OTA events without accepting disconnected update availability", async () => {
    useGlassesStore.getState().setGlassesInfo({connected: false})
    useGlassesStore.getState().setOtaUpdateAvailable(null)

    emitCoreModuleEvent("ota_update_available", {
      version_code: 101,
      version_name: "1.0.1",
      updates: ["apk"],
      total_size: 2048,
    })
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()

    useGlassesStore.getState().setGlassesInfo({connected: true})
    emitCoreModuleEvent("ota_update_available", {
      version_code: 101,
      version_name: "1.0.1",
      updates: ["apk"],
      total_size: 2048,
    })
    expect(useGlassesStore.getState().otaUpdateAvailable).toEqual({
      available: true,
      versionCode: 101,
      versionName: "1.0.1",
      updates: ["apk"],
      totalSize: 2048,
    })

    emitCoreModuleEvent("ota_progress", {
      stage: "download",
      status: "PROGRESS",
      progress: 80,
      bytes_downloaded: 800,
      total_bytes: 1000,
      current_update: "apk",
    })
    emitCoreModuleEvent("ota_progress", {
      stage: "download",
      status: "PROGRESS",
      progress: 50,
      bytes_downloaded: 500,
      total_bytes: 1000,
      current_update: "apk",
    })
    expect(useGlassesStore.getState().otaProgress?.progress).toBe(80)

    emitCoreModuleEvent("ota_progress", {
      stage: "install",
      status: "FINISHED",
      progress: 100,
      bytes_downloaded: 1000,
      total_bytes: 1000,
      current_update: "apk",
    })
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
    expect(useGlassesStore.getState().otaInProgress).toBe(false)
  })
})
