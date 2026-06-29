import BluetoothSdk, {ButtonPressEvent, BluetoothStatus, OtaStatus} from "@mentra/bluetooth-sdk-internal"
import CrustModule from "@mentra/crust"
import {Asset} from "expo-asset"
import * as Calendar from "expo-calendar"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import {shallow} from "zustand/shallow"

import audioPlaybackService from "@/services/AudioPlaybackService"
import headingService from "@/services/HeadingService"
import {bootstrapMentraJS} from "@/services/mentraJsBootstrap"
import navigationService from "@/services/NavigationService"
import {phonePhotoCoordinator} from "@/services/photo/PhonePhotoCoordinator"
import {phoneVideoCoordinator} from "@/services/video/PhoneVideoCoordinator"
import {phoneStreamCoordinator} from "@/services/streaming/PhoneStreamCoordinator"
import miniappCatalog from "@/services/miniapps/MiniappCatalog"
import {BUNDLED_MINIAPPS} from "@/generated/bundledMiniapps"
import {CHINA_HIDDEN_APPS, isChinaBuild} from "@/constants/miniapps"
import {migrate} from "@/services/Migrations"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {cloudClient} from "@/services/cloudClient"
import {devServerHost} from "@/utils/cloudClient/devHost"
import {gallerySyncService} from "@/services/asg/gallerySyncService"
import {handleOtaClockSkewFromGlasses} from "@/services/asg/glassesClockSync"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {
  appRegistry,
  configureRuntime,
  getRuntimeHooks,
  displayProcessor,
  localMiniappRuntime,
  localSttFallbackCoordinator,
  micStateCoordinator,
  offlineSpeechModelService,
  DEV_APP_PACKAGE_NAME,
  getDevAppSourcePackage,
  BgTimer,
  useAppStatusStore,
} from "@mentra/island"
import {useDisplayStore} from "@/stores/display"
import {getGlasesInfoPartial, isGlassesConnected, useGlassesStore} from "@/stores/glasses"
import {useSettingsStore, SETTINGS} from "@/stores/settings"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import TranscriptProcessor from "@/utils/TranscriptProcessor"
import {useCoreStore} from "@/stores/core"
import udp from "@/services/UdpManager"
import {
  legacyOtaProgressFromOtaStatusEvent,
  normalizeOtaStatusEvent,
  otaStatusFromNormalized,
} from "@/utils/otaLegacyMapping"
import {useDebugStore} from "@/stores/debug"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {logE2EMetric} from "@/utils/e2eMetrics"
import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {ensureDevModeForUser} from "@/utils/dev/devModeAllowlist"
import mentraAuth from "@/utils/auth/authClient"
import {Buffer} from "@craftzdog/react-native-buffer"

const LOCATION_TASK_NAME = "handleLocationUpdates"

// ===========================================================================
// BGCAP: temporary background-caption telemetry (DIAGNOSTIC — remove with the
// matching block in LocalMiniappRuntime.ts after the "captions fall behind then
// flood in waves" fix lands). Tracks the glasses-mic → cloud AUDIO UPLINK rate.
// The mic_lc3 handler runs on the RN JS thread; if that thread is starved in
// the background, audio stops flowing UP to the cloud and transcripts dry up at
// the source. A drop/gap here means the stall is on the uplink side; steady
// here while captions still fall behind points downstream (render side).
// All lines prefixed "BGCAP:" for grep + easy removal.
// ===========================================================================
const BGCAP_TELEMETRY = true
let bgcapMicFrames = 0
let bgcapMicLastLogAt = 0
let bgcapMicLastVia = ""
function bgcapNoteMicFrame(via: string): void {
  if (!BGCAP_TELEMETRY) return
  bgcapMicFrames++
  bgcapMicLastVia = via
  const now = Date.now()
  if (now - bgcapMicLastLogAt >= 1000) {
    console.log(`BGCAP: mic_lc3 uplink=${bgcapMicFrames} frames in ${now - bgcapMicLastLogAt}ms via=${bgcapMicLastVia}`)
    bgcapMicFrames = 0
    bgcapMicLastLogAt = now
  }
}

/**
 * Miniapp bundles shipped inside the app binary, installed on first launch by
 * MantleManager.installBundledMiniapps(). BUNDLED_MINIAPPS is code-generated
 * from every *.zip in assets/miniapps/ by scripts/generate-bundled-miniapps.mjs
 * (Metro can only bundle assets referenced by a literal string require(), so the
 * list must be static) — to ship an update, just drop a new zip in that
 * directory; the generator runs on `bun start`/prebuild.
 *
 * The filename encodes packageName + version (e.g.
 * `com.mentra.navigation-1.0.2.zip`), so we read those straight off the asset
 * name to decide whether the bundle is already installed and up to date — no
 * need to unzip just to check. See src/generated/bundledMiniapps.ts.
 */

/**
 * Parse `<packageName>-<version>` out of a bundled miniapp asset name like
 * `com.mentra.navigation-1.0.2.zip`. Splits on the last hyphen so dotted
 * package names (which contain no hyphens) stay intact. Returns null if the
 * name doesn't match the expected shape.
 */
function parseBundledMiniappName(name: string): {packageName: string; version: string} | null {
  const base = name.replace(/\.zip$/i, "")
  const lastHyphen = base.lastIndexOf("-")
  if (lastHyphen <= 0 || lastHyphen === base.length - 1) return null
  return {
    packageName: base.slice(0, lastHyphen),
    version: base.slice(lastHyphen + 1),
  }
}

// @ts-ignore
TaskManager.defineTask(LOCATION_TASK_NAME, ({data: {locations}, error}) => {
  if (error) {
    // check `error.message` for more details.
    // console.error("Error handling location updates", error)
    return
  }
  const locs = locations as Location.LocationObject[]
  if (locs.length === 0) {
    console.log("MANTLE: LOCATION: No locations received")
    return
  }

  // console.log("Received new locations", locations)
  const first = locs[0]!
  // socketComms.sendLocationUpdate(first.coords.latitude, first.coords.longitude, first.coords.accuracy ?? undefined)
  restComms.sendLocationData(first)

  // Direct forward to local miniapps. Cloud path (relayMessageToApps) never
  // reaches __phone__, so local miniapps rely on this direct push.
  localMiniappRuntime.forwardEvent("location_update", {
    lat: first.coords.latitude,
    lng: first.coords.longitude,
    accuracy: first.coords.accuracy ?? undefined,
    timestamp: first.timestamp,
  })
})

class MantleManager {
  private static instance: MantleManager | null = null
  private calendarSyncTimer: ReturnType<typeof BgTimer.setInterval> | null = null
  private clearTextTimeout: ReturnType<typeof BgTimer.setTimeout> | null = null
  private micDataTimeout: ReturnType<typeof BgTimer.setTimeout> | null = null
  private MIC_TIMEOUT_MS: number = 1000
  private transcriptProcessor: TranscriptProcessor
  private subs: Array<any> = []
  private initialized: boolean = false

  public static getInstance(): MantleManager {
    if (!MantleManager.instance) {
      MantleManager.instance = new MantleManager()
    }
    return MantleManager.instance
  }

  private constructor() {
    // Pass callback to send pending updates when timer fires
    this.transcriptProcessor = new TranscriptProcessor(() => {
      this.sendPendingTranscript()
    })
  }

  private sendPendingTranscript() {
    const pendingText = this.transcriptProcessor.getPendingUpdate()
    if (pendingText) {
      socketComms.handle_display_event({
        type: "display_event",
        view: "main",
        layout: {
          layoutType: "text_wall",
          text: pendingText,
        },
      })
    }
  }

  // run at app start on the init.tsx screen:
  // should only ever be run once
  // sets up the bridge and initializes app state
  public async init() {
    console.log("MANTLE: init()")

    if (this.initialized) {
      console.log("MANTLE: already initialized")
      return
    }
    this.initialized = true

    // iOS: require a second swipe across the bottom edge to invoke the Home
    // indicator / app switcher, so users don't accidentally background the
    // app mid-glasses-session. No-op on Android.
    // CrustModule.setDeferredSystemGestures(["bottom"]).catch((e) =>
    //   console.warn("MANTLE: setDeferredSystemGestures failed", e),
    // )

    // Wire host-side adapters into the island runtime. Must run before any
    // island service that reads settings / glasses status / sockets / audio
    // (LocalMiniappRuntime, LocalDisplayManager, LocalSttFallbackCoordinator,
    // DisplayProcessor) is touched.
    // Construct + connect the cloud client (best-effort) and wire its runtime
    // adapter. The island/local-miniapp path is powered by this client.
    const cloud = cloudClient.init()

    configureRuntime({
      socketComms: {
        sendMessage: (message) => socketComms.sendMessage(message as Parameters<typeof socketComms.sendMessage>[0]),
        updatePhoneSubscriptions: (subs) => socketComms.updatePhoneSubscriptions(subs),
      },
      cloud,
      miniappAuth: {
        getToken: (packageName, opts) => {
          const authPackageName = packageName === DEV_APP_PACKAGE_NAME ? getDevAppSourcePackage() : packageName
          if (!authPackageName) {
            throw new Error("Dev miniapp auth token unavailable until the dev miniapp manifest is registered")
          }
          return cloudClient.getMiniappAuthToken(authPackageName, opts)
        },
      },
      audioPlayback: {
        play: (request, onComplete) => audioPlaybackService.play(request, onComplete),
        stopForApp: (packageName) => audioPlaybackService.stopForApp(packageName),
      },
      glassesStatus: {
        get: () => {
          const s = useGlassesStore.getState()
          // Spread first, then narrow to the canonical fields the runtime reads
          // — so the canonical names always win over anything in the host store.
          return {
            ...s,
            connected: isGlassesConnected(s.connection),
            deviceModel: s.deviceModel,
            batteryLevel: s.batteryLevel,
            charging: s.charging,
          }
        },
      },
      settings: {
        getSetting: <T = unknown>(key: string): T | undefined =>
          useSettingsStore.getState().getSetting(key) as T | undefined,
        setSetting: (key, value, persistImmediately) =>
          useSettingsStore.getState().setSetting(key, value, persistImmediately),
        subscribeKey: (key, onChange) =>
          useSettingsStore.subscribe(
            (state) => state.getSetting(key),
            (value) => onChange(value as never),
          ),
      },
      // The dev laptop's live address, from Metro. The island runtime uses it
      // to repair persisted dev-miniapp URLs that froze a previous network's
      // IP (the bundle host is, by construction, reachable right now).
      devServerHost: () => devServerHost(),
      setDisplayEvent: (event) => useDisplayStore.getState().setDisplayEvent(event),
      sendDisplayEvent: (event) => BluetoothSdk.displayEvent(event),
      subscribeGlassesStatus: (onChange) => BluetoothSdk.onGlassesStatus(onChange),
      restartTranscriber: () => BluetoothSdk.restartTranscriber(),
      setMicRequirements: (requirements) =>
        BluetoothSdk.updateBluetoothSettings({
          should_send_pcm: requirements.shouldSendPcm,
          should_send_lc3: requirements.shouldSendLc3,
          should_send_transcript: requirements.shouldSendTranscript,
        }),
      photo: {
        takePhoto: (pkg, opts) => phonePhotoCoordinator.takePhoto(pkg, opts),
      },
      videoRecording: {
        startRecording: (pkg, opts) => phoneVideoCoordinator.startRecording(pkg, opts),
        stopRecording: (pkg, recordingId) => phoneVideoCoordinator.stopRecording(pkg, recordingId),
        stopForApp: (pkg) => phoneVideoCoordinator.stopForApp(pkg),
      },
      cameraSettings: {
        setFov: (_pkg, request) => BluetoothSdk.setCameraFov(request),
      },
      // Google Nav SDK adapter — the island runtime fan-outs nav events to
      // miniapps subscribed to navigation_*. Delegates straight to the host's
      // singleton NavigationService.
      navigation: {
        getState: () => navigationService.getState(),
        getSnapshot: () => navigationService.getSnapshot(),
        addListener: (l) => navigationService.addListener(l),
        addLocationListener: (l) => navigationService.addLocationListener(l),
        addRouteListener: (l) => navigationService.addRouteListener(l),
        start: (coords, options) => navigationService.start(coords, options),
        stop: () => navigationService.stop(),
        simulateDeviation: (offsetMeters) => navigationService.simulateDeviation(offsetMeters),
        setWrongSidewalkOffset: (enabled) => navigationService.setWrongSidewalkOffset(enabled),
        setSkipCrossings: (enabled) => navigationService.setSkipCrossings(enabled),
        requestPermission: () => navigationService.requestPermission(),
        // Route compute + reverse geocoding now run in the v2 cloud maps service
        // (cloud.runtime.maps); the device no longer calls Mapbox REST directly.
      },
      heading: {
        addListener: (l) => headingService.addListener(l),
      },
      locationTier: {
        setLocationTier: (rate) => this.setLocationTier(rate),
      },
      streaming: {
        startUnmanaged: (pkg, opts) => phoneStreamCoordinator.startUnmanaged(pkg, opts),
        startManaged: (pkg, opts) => phoneStreamCoordinator.startManaged(pkg, opts),
        stop: (pkg, streamId) => phoneStreamCoordinator.stop(pkg, streamId),
        setStatusSubscriber: (cb) => phoneStreamCoordinator.setStatusSubscriber(cb),
      },
    })
    // Wire the runtime's status fanout now that the streaming hook is in.
    localMiniappRuntime.wireStreamingStatusFanout()

    // DisplayProcessor's singleton was constructed at module load — before runtime
    // hooks existed — so its initial deviceModel read and glasses-status subscription
    // silently no-op'd. Re-attach now that hooks are wired so captions are wrapped with
    // the correct profile (e.g. NEX_PROFILE for Mentra Display) instead of the G1 default.
    displayProcessor.attachToRuntime()

    // Register the offline-app catalog with island's AppRegistry before
    // anything triggers an apps refresh.
    miniappCatalog.init()

    await migrate() // do any local migrations here
    const res = await restComms.loadUserSettings() // get settings from server
    if (res.is_ok()) {
      let loadedSettings = res.value
      // Device/pairing identity is per-phone state and is now saveOnServer: false, so it
      // should never come back from the server. These deletes are a migration guard: users
      // paired before that flag flipped still have stale values persisted server-side, and
      // restoring them would clobber the locally paired device and point reconnect-on-launch
      // at the wrong BLE address.
      delete loadedSettings["default_wearable"]
      delete loadedSettings["pending_wearable"]
      delete loadedSettings["device_name"]
      delete loadedSettings["device_address"]
      delete loadedSettings["default_controller"]
      delete loadedSettings["pending_controller"]
      delete loadedSettings["controller_device_name"]
      delete loadedSettings["controller_address"]

      await useSettingsStore.getState().setManyLocally(loadedSettings) // write settings to local storage
    } else {
      console.error("MANTLE: No settings received from server")
    }

    const userRes = await mentraAuth.getUser()
    if (userRes.is_ok()) {
      await ensureDevModeForUser(userRes.value.email)
    }

    // Send device timezone to cloud (used for calendar/time display)
    this.syncTimezone()

    offlineSpeechModelService.startBackgroundDownloads()

    // Give the native Bluetooth SDK some time to boot before sending initial settings.
    BgTimer.setTimeout(() => {
      BluetoothSdk.updateBluetoothSettings(useSettingsStore.getState().getBluetoothSettings())
      console.log("MANTLE: Bluetooth settings sent to native SDK")
      // settings are now in native; safe to attempt auto-connect
      attemptReconnectToDefaultWearable()
    }, 1000)
    await this.syncNotificationSettingsToCrust()

    this.initServices()
    this.initMiniapps()
    this.setupPeriodicTasks()
    this.setupSubscriptions()
  }

  private async syncTimezone() {
    const timezone = useSettingsStore.getState().getSetting(SETTINGS.time_zone.key)
    const result = await restComms.writeUserSettings({time_zone: timezone, timezone: timezone})
    if (result.is_error()) {
      console.error("MANTLE: Failed to sync timezone:", result.error)
    } else {
      console.log("MANTLE: Timezone synced:", timezone)
    }
  }

  public async cleanup() {
    // Stop timers
    if (this.calendarSyncTimer) {
      clearInterval(this.calendarSyncTimer)
      this.calendarSyncTimer = null
    }
    // Remove all event subscriptions
    this.subs.forEach((sub) => sub.remove())
    this.subs = []

    Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
    this.transcriptProcessor.clear()

    localMiniappRuntime.cleanup()
    micStateCoordinator.cleanup()

    await socketComms.cleanup()
    restComms.goodbye()
  }

  private async initServices() {
    socketComms.connectWebsocket()
    gallerySyncService.initialize()

    // Bootstrap MentraJS — wires MentraJSRouter + MentraUIRouter +
    // MentraJSCrashController. The /applet/local route binds the UI
    // router to its inline WebView via getMentraJS().uiRouter directly.
    try {
      bootstrapMentraJS()
    } catch (e) {
      console.warn("mentraJsBootstrap failed:", e)
    }
  }

  private async initMiniapps() {
    // Warm the local miniapp registry by reading lmas/ off disk. Cheap call —
    // it populates AppRegistry's cache so the first refreshApplets() doesn't
    // pay the disk-walk cost in the UI thread.
    await appRegistry.getInstalledMiniapps()

    // Initialize local miniapp runtime
    localMiniappRuntime.initialize()

    // Install any bundled miniapps that ship with the app and aren't on disk
    // yet (or are an older version). Runs after the registry is warm so the
    // already-installed check below sees the real on-disk state.
    await this.installBundledMiniapps()
  }

  /**
   * Install the miniapp zips bundled into the app binary under
   * @assets/miniapps. Metro's `require` needs static string literals, so the
   * BUNDLED_MINIAPPS require() list is code-generated from the directory
   * (see src/generated/bundledMiniapps.ts) rather than globbed at runtime.
   *
   * The asset name carries packageName + version, so we read those off the
   * filename and skip the bundle entirely when that exact version is already
   * installed — no unzip needed to check. Otherwise we materialize the asset
   * to disk (expo-asset gives us a file:// URI, but `File.downloadFileAsync`
   * is HTTP-only) and hand the local zip to AppRegistry, which unzips and
   * installs it.
   */
  private async installBundledMiniapps() {
    for (const module of BUNDLED_MINIAPPS) {
      try {
        const asset = Asset.fromModule(module)
        const parsed = parseBundledMiniappName(asset.name)
        if (!parsed) {
          console.warn(`MANTLE: bundled miniapp asset name "${asset.name}" is not <packageName>-<version>`)
          continue
        }
        const {packageName, version} = parsed

        // China build: don't install hidden bundled miniapps (e.g. Mentra Map).
        if (isChinaBuild() && CHINA_HIDDEN_APPS.includes(packageName)) {
          continue
        }

        if (appRegistry.getInstalledVersions(packageName).includes(version)) {
          continue
        }

        let superMode = await useSettingsStore.getState().getSetting(SETTINGS.super_mode.key)
        if (!superMode && packageName === "com.mentra.example") {
          // skip installing the example miniapp if super mode is not enabled
          continue
        }

        await asset.downloadAsync()
        if (!asset.localUri) {
          console.warn(`MANTLE: bundled miniapp ${packageName} has no localUri after download`)
          continue
        }

        const res = await appRegistry.installFromLocalZip(asset.localUri)
        if (res.is_error()) {
          console.error(`MANTLE: failed to install bundled miniapp ${packageName}@${version}:`, res.error)
          continue
        }
        console.log(`MANTLE: installed bundled miniapp ${res.value.packageName}@${res.value.version}`)
      } catch (error) {
        console.error(`MANTLE: error installing bundled miniapp:`, error)
      }
    }
  }

  private async syncNotificationSettingsToCrust() {
    const settings = useSettingsStore.getState()
    const notificationsEnabled = Boolean(settings.getSetting(SETTINGS.notifications_enabled.key))
    const notificationsBlocklist = settings.getSetting(SETTINGS.notifications_blocklist.key)
    await CrustModule.setNotificationConfig(
      notificationsEnabled,
      Array.isArray(notificationsBlocklist) ? notificationsBlocklist : [],
    )
  }

  private async setupPeriodicTasks() {
    this.sendCalendarEvents()
    // Calendar sync every hour
    this.calendarSyncTimer = BgTimer.setInterval(
      () => {
        this.sendCalendarEvents()
      },
      60 * 60 * 1000,
    ) // 1 hour

    try {
      // only start location updates if we have the location permission:
      const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
      if (hasLocation) {
        let locationAccuracy = await useSettingsStore.getState().getSetting(SETTINGS.location_tier.key)
        let properAccuracy = this.getLocationAccuracy(locationAccuracy)
        Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: properAccuracy,
        })
      }
    } catch (error) {
      console.error("MANTLE: Error starting location updates", error)
    }

    // check for requirements immediately, but only if we've passed through onboarding:
    // const onboardingCompleted = await useSettingsStore.getState().getSetting(SETTINGS.onboarding_completed.key)
    // if (onboardingCompleted) {
    //   try {
    //     const requirementsCheck = await checkConnectivityRequirementsUI()
    //     if (!requirementsCheck) {
    //       return
    //     }
    //     // give some time for the glasses to be fully ready:
    //     BgTimer.setTimeout(async () => {
    //       await BluetoothSdk.connectDefault()
    //     }, 3000)
    //   } catch (error) {
    //     console.error("connect to glasses error:", error)
    //     showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    //   }
    // }
  }

  private async setupSubscriptions() {
    useGlassesStore.subscribe(
      getGlasesInfoPartial,
      (state: Record<string, any>, previousState: Record<string, any>) => {
        const statusObj: Record<string, any> = {}

        for (const key in state) {
          const k = key as keyof typeof state
          if (state[k] !== previousState[k]) {
            statusObj[k] = state[k]
          }
        }
        restComms.updateGlassesState(statusObj)
      },
      {equalityFn: shallow},
    )

    // Subscribe to settings forwarded to the Bluetooth SDK.
    useSettingsStore.subscribe(
      (state) => state.getBluetoothSettings(),
      (state: Record<string, any>, previousState: Record<string, any>) => {
        const bluetoothSettingsObj: Record<string, any> = {}

        for (const key in state) {
          const k = key as keyof Record<string, any>
          if (state[k] !== previousState[k]) {
            bluetoothSettingsObj[k] = state[k] as any
          }
        }
        // console.log("MANTLE: Bluetooth settings changed", bluetoothSettingsObj)
        BluetoothSdk.updateBluetoothSettings(bluetoothSettingsObj)
      },
      {equalityFn: shallow},
    )

    useSettingsStore.subscribe(
      (state) => ({
        notificationsEnabled: state.getSetting(SETTINGS.notifications_enabled.key),
        notificationsBlocklist: state.getSetting(SETTINGS.notifications_blocklist.key),
      }),
      async () => {
        await this.syncNotificationSettingsToCrust()
      },
      {equalityFn: shallow},
    )

    // Remove old event subscriptions
    this.subs.forEach((sub) => sub.remove())
    this.subs = []

    // Forward Bluetooth SDK status changes to the zustand core store.
    this.subs.push(
      BluetoothSdk.onBluetoothStatus((changed: Partial<BluetoothStatus>) => {
        // console.log("MANTLE: Bluetooth status changed", changed)
        useCoreStore.getState().setCoreInfo(changed)
      }),
    )
    this.subs.push(
      BluetoothSdk.onGlassesStatus((changed) => {
        // console.log("MANTLE: Glasses status changed", changed)
        useGlassesStore.getState().setGlassesInfo(changed)
        localMiniappRuntime.forwardEvent("glasses_connection_state", changed)
        // TODO: this should be moved to the bluetooth sdk:
        if (changed.connection?.state === "disconnected") {
          useGlassesStore.getState().setOtaUpdateAvailable(null)
        }
      }),
    )

    // Subscribe to individual Bluetooth SDK events.
    {
      this.subs.push(
        BluetoothSdk.addListener("log", (event) => {
          console.log("CORE:", event.message)
        }),
      )

      // Keep the store in sync for standalone WiFi status events.
      this.subs.push(
        BluetoothSdk.addListener("wifi_status_change", (event) => {
          const {type: _type, ...wifi} = event
          useGlassesStore.getState().setGlassesInfo({wifi})
        }),
      )

      // TODO: remove since we can sub to the zustand store for hotspot info:
      this.subs.push(
        BluetoothSdk.addListener("hotspot_status_change", (event) => {
          const enabled = event.state === "enabled"
          const ssid = enabled ? event.ssid : ""
          const password = enabled ? event.password : ""
          const localIp = enabled ? event.localIp : ""
          useGlassesStore.getState().setHotspotInfo(enabled, ssid, password, localIp)
          GlobalEventEmitter.emit("hotspot_status_change", {
            enabled,
            ssid,
            password,
            local_ip: localIp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("hotspot_error", (event) => {
          GlobalEventEmitter.emit("hotspot_error", {
            error_message: event.errorMessage,
            timestamp: event.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("gallery_status", (event) => {
          GlobalEventEmitter.emit("gallery_status", {
            photos: event.photos,
            videos: event.videos,
            total: event.total,
            has_content: event.hasContent,
            camera_busy: event.cameraBusy,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("photo_response", (event) => {
          // Local miniapps' photos are tracked by phonePhotoCoordinator. If
          // glasses report an error (BATTERY_LOW, CAMERA_BUSY, ...) for a
          // phone-owned requestId, short-circuit the in-flight long-poll with
          // the typed error. Terminal success is ignored here because the
          // coordinator resolves from the phone/cloud upload result. Cloud-app
          // photos (third-party SDK) still forward to cloud's PhotoManager.
          //
          // Error responses are the only photo_response events that settle
          // the coordinator directly.
          if (event.requestId && phonePhotoCoordinator.owns(event.requestId)) {
            if (event.state === "error") {
              phonePhotoCoordinator.handlePhotoError(
                event.requestId,
                event.errorCode ?? "GLASSES_ERROR",
                event.errorMessage ?? "Glasses reported an error",
              )
            }
            return
          }
          restComms.sendPhotoResponse(event)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("heartbeat_sent", (event) => {
          console.log("MANTLE: received heartbeat_sent event from Bluetooth SDK", event.heartbeat_sent)
          // TODO: remove the global event emitter and sub directly in the component where needed
          GlobalEventEmitter.emit("heartbeat_sent", {
            timestamp: event.heartbeat_sent.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("heartbeat_received", (event) => {
          console.log("MANTLE: received heartbeat_received event from Bluetooth SDK", event.heartbeat_received)
          // TODO: remove the global event emitter and sub directly in the component where needed
          GlobalEventEmitter.emit("heartbeat_received", {
            timestamp: event.heartbeat_received.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("send_command_to_ble", (event) => {
          GlobalEventEmitter.emit("send_command_to_ble", {
            command: event.command,
            commandText: event.commandText,
            timestamp: event.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("receive_command_from_ble", (event) => {
          GlobalEventEmitter.emit("receive_command_from_ble", {
            command: event.command,
            commandText: event.commandText,
            timestamp: event.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("button_press", (event) => {
          console.log("MANTLE: BUTTON_PRESS event received:", event)
          this.handle_button_press(event)
          localMiniappRuntime.forwardEvent("button_press", event)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("touch_event", (event) => {
          socketComms.sendTouchEvent(event)
          localMiniappRuntime.forwardEvent("touch_event", event)
        }),
      )

      // Raw accelerometer readings from the glasses IMU (G2). The native
      // payload {x, y, z, timestamp} already matches the miniapp AccelData
      // shape, so forward it as-is (runtime maps accel_event → accel_data).
      this.subs.push(
        BluetoothSdk.addListener("accel_event", (event) => {
          localMiniappRuntime.forwardEvent("accel_event", {
            x: event.x,
            y: event.y,
            z: event.z,
            timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("swipe_volume_status", (event) => {
          const enabled = !!event.enabled
          const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
          socketComms.sendSwipeVolumeStatus(enabled, timestamp)
          // TODO: remove
          GlobalEventEmitter.emit("SWIPE_VOLUME_STATUS", {enabled, timestamp})
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("switch_status", (event) => {
          const switchType = event.switchType ?? -1
          const switchValue = event.switchValue ?? -1
          const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
          socketComms.sendSwitchStatus(switchType, switchValue, timestamp)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("rgb_led_control_response", (event) => {
          socketComms.sendRgbLedControlResponse(event)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("pair_failure", (event) => {
          GlobalEventEmitter.emit("pair_failure", event.error)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_pairing_needed", (event) => {
          GlobalEventEmitter.emit("audio_pairing_needed", {
            deviceName: event.deviceName,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_connected", (event) => {
          GlobalEventEmitter.emit("audio_connected", {
            deviceName: event.deviceName,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_disconnected", () => {
          GlobalEventEmitter.emit("audio_disconnected", {})
        }),
      )

      // Allow native hardware-originated setting changes to persist.
      this.subs.push(
        BluetoothSdk.addListener("save_setting", async (event) => {
          console.log("MANTLE: Received save_setting event from Bluetooth SDK:", event)
          await useSettingsStore.getState().setSetting(event.key, event.value)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("head_up", (event) => {
          mantle.handle_head_up(event.up)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("speaking_status", (event) => {
          socketComms.sendVadStatus(event.speaking)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("battery_status", (event) => {
          socketComms.sendBatteryStatus(event.level, event.charging, event.timestamp)
        }),
      )

      this.subs.push(
        (CrustModule.addListener as any)("phone_notification", async (event: any) => {
          // Direct forward to local miniapps subscribed to phone_notification.
          // Gated by READ_NOTIFICATIONS in miniapp.json at subscribe time.
          localMiniappRuntime.forwardEvent("phone_notification", {
            notificationId: event.notificationId,
            app: event.app,
            title: event.title,
            content: event.content,
            priority: event.priority?.toString?.() ?? String(event.priority ?? ""),
            timestamp: parseInt(event.timestamp?.toString?.() ?? "0"),
            packageName: event.packageName,
          })
          const res = await restComms.sendPhoneNotification({
            notificationId: event.notificationId,
            app: event.app,
            title: event.title,
            content: event.content,
            priority: event.priority.toString(),
            timestamp: parseInt(event.timestamp.toString()),
            packageName: event.packageName,
          })
          if (res.is_error()) {
            console.error("Failed to send phone notification:", res.error)
          }
        }),
      )

      this.subs.push(
        (CrustModule.addListener as any)("phone_notification_dismissed", async (event: any) => {
          // Direct forward to local miniapps subscribed to
          // phone_notification_dismissed (Android only — iOS never emits this).
          // Gated by READ_NOTIFICATIONS at subscribe time.
          localMiniappRuntime.forwardEvent("phone_notification_dismissed", {
            notificationId: event.notificationId,
            notificationKey: event.notificationKey,
            packageName: event.packageName,
            timestamp: Date.now(),
          })
          const res = await restComms.sendPhoneNotificationDismissed({
            notificationKey: event.notificationKey,
            packageName: event.packageName,
            notificationId: event.notificationId,
          })
          if (res.is_error()) {
            console.error("Failed to send phone notification dismissal:", res.error)
          }
        }),
      )

      this.subs.push(
        (CrustModule.addListener as any)("captions_tester_incident", (event: any) => {
          const failureCode = typeof event.failure_code === "string" ? event.failure_code : "unknown"
          const failureMessage =
            typeof event.failure_message === "string" ? event.failure_message : "Captions tester incident detected."
          const testRunId = typeof event.test_run_id === "string" ? event.test_run_id : undefined
          const scenarioName = typeof event.scenario_name === "string" ? event.scenario_name : undefined
          const alertId = typeof event.alert_id === "string" ? event.alert_id : testRunId
          const dashboardUrl = typeof event.dashboard_url === "string" ? event.dashboard_url : undefined
          const expectedBehavior = dashboardUrl
            ? `Captions tester runs should complete without a captions incident. Check live dashboard: ${dashboardUrl}.`
            : "Captions tester runs should complete without a captions incident."

          const actualBehavior = JSON.stringify(
            {
              failureCode,
              failureMessage,
              testRunId,
              scenarioName,
              event,
            },
            null,
            2,
          )

          const dedupeKey = ["captions_tester", failureCode, scenarioName || "unknown", testRunId || "unknown"].join(
            "|",
          )

          void (async () => {
            const result = await submitAutomaticBugIncident({
              categorization: {
                submissionMode: "AUTOMATIC",
                triggerArea: "captions_tester",
                triggerReason: "captions_incident_detected",
              },
              expectedBehavior,
              actualBehavior,
              severityRating: 4,
              dedupeKey,
              logTag: "CaptionsTesterBugReport",
            })

            console.log(
              `CAPTIONS_TESTER_INCIDENT_RESULT ${JSON.stringify({
                alert_id: alertId,
                test_run_id: testRunId,
                failure_code: failureCode,
                scenario_name: scenarioName,
                status: result.status,
                incident_id: result.status === "filed" ? result.incidentId : undefined,
                reason: result.status === "skipped" ? result.reason : undefined,
                error: result.status === "failed" ? result.error : undefined,
              })}`,
            )
          })()
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_pairing_needed", (event) => {
          GlobalEventEmitter.emit("audio_pairing_needed", {
            deviceName: event.deviceName,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_connected", (event) => {
          GlobalEventEmitter.emit("audio_connected", {
            deviceName: event.deviceName,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_disconnected", () => {
          GlobalEventEmitter.emit("audio_disconnected", {})
        }),
      )

      // Allow native hardware-originated setting changes to persist.
      this.subs.push(
        BluetoothSdk.addListener("save_setting", async (event) => {
          console.log("MANTLE: Received save_setting event from Bluetooth SDK:", event)
          await useSettingsStore.getState().setSetting(event.key, event.value)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("head_up", (event) => {
          mantle.handle_head_up(event.up)
          // Translate native {up: boolean} → cloud-SDK shape {position: "up" | "down"}
          localMiniappRuntime.forwardEvent("head_up", {
            position: event.up ? "up" : "down",
            timestamp: Date.now(),
          })
        }),
      )

      // Phone battery — emit on level/state change so miniapps can subscribe
      // to phone_battery the same way they subscribe to glasses_battery.
      // Also mirror to glasses_battery when connected to Simulated Glasses
      // (which have no real battery) so dev flows don't see "—".
      // const emitPhoneBattery = async () => {
      //   try {
      //     const level = await Battery.getBatteryLevelAsync()
      //     const state = await Battery.getBatteryStateAsync()
      //     const charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL
      //     const payload = {
      //       level: Math.round(level * 100),
      //       charging,
      //       timestamp: Date.now(),
      //     }
      //     localMiniappRuntime.forwardEvent("phone_battery", payload)

      //     const deviceModel = useGlassesStore.getState().deviceModel || ""
      //     if (deviceModel.toLowerCase().includes("simulated")) {
      //       localMiniappRuntime.forwardEvent("glasses_battery_update", payload)
      //     }
      //   } catch (err) {
      //     console.log("MANTLE: phone battery read failed", err)
      //   }
      // }
      // emitPhoneBattery()
      // const batteryLevelSub = Battery.addBatteryLevelListener(emitPhoneBattery)
      // const batteryStateSub = Battery.addBatteryStateListener(emitPhoneBattery)
      // this.subs.push({remove: () => batteryLevelSub.remove()})
      // this.subs.push({remove: () => batteryStateSub.remove()})

      // this.subs.push(
      //   BluetoothSdk.addListener("vad", (event) => {
      //     localMiniappRuntime.forwardEvent("VAD", event)
      //     localSttFallbackCoordinator.onVad(!!event?.status)
      //   }),
      // )

      // G2 dashboard menu: user selected a miniapp from the glasses swipe menu
      // G2.swift resolves the numeric appId → packageName before sending this event
      this.subs.push(
        BluetoothSdk.addListener("miniapp_selected", (event) => {
          const packageName = event.packageName as string
          if (!packageName) return
          const app = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)
          if (!app) return
          // Toggle: if already running, stop it; otherwise start it
          if (app.running) {
            console.log(`MANTLE: stopping ${packageName}`)
            useAppStatusStore.getState().stop(packageName)
          } else {
            console.log(`MANTLE: starting ${packageName}`)
            useAppStatusStore.getState().start(app, {skipNavigation: true})
          }
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("local_transcription", (event) => {
          mantle.handle_local_transcription(event)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("ws_text", (event) => {
          socketComms.sendText(event.text)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("ws_bin", (event) => {
          const binaryString = atob(event.base64)
          const bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }
          socketComms.sendBinary(bytes)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("mic_lc3", (event) => {
          if (this.micDataTimeout) {
            BgTimer.clearTimeout(this.micDataTimeout)
          }
          this.micDataTimeout = BgTimer.setTimeout(() => {
            useDebugStore.getState().setDebugInfo({micDataRecvd: false})
          }, this.MIC_TIMEOUT_MS)
          useDebugStore.getState().setDebugInfo({micDataRecvd: true})

          // console.log("MANTLE: Received mic_lc3 event from Bluetooth SDK", event.lc3.length)

          // Route audio to: UDP (if enabled) -> WebSocket (fallback)
          if (udp.enabledAndReady()) {
            // UDP audio is enabled and ready - send directly via UDP
            udp.sendAudio(event.lc3)
            bgcapNoteMicFrame("udp") // BGCAP diagnostic
          } else {
            socketComms.sendBinary(event.lc3)
            bgcapNoteMicFrame("ws") // BGCAP diagnostic
          }

          // Cloud-v2 fork: forward the same LC3 frame to the v2 cloud, gated so
          // we don't waste UDP bandwidth when nothing is subscribed on v2. The
          // v1 sends above are unchanged.
          const cloud = getRuntimeHooks().cloud
          if (cloud?.isConnected() && cloud.hasAudioSubscriptions()) {
            cloud.sendAudioFrame(new Uint8Array(event.lc3))
          }
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("mic_pcm", (event) => {
          // mic_pcm events are strictly on-device. The cloud only ever
          // receives LC3 (mic_lc3 listener above) — never forward PCM
          // bytes upstream, or we'd interleave them with LC3 frames on
          // the same binary WebSocket and corrupt the cloud's decoder.
          // Sherpa-ONNX is fed PCM natively inside the BT SDK, not here.
          if (this.micDataTimeout) {
            BgTimer.clearTimeout(this.micDataTimeout)
          }
          this.micDataTimeout = BgTimer.setTimeout(() => {
            useDebugStore.getState().setDebugInfo({micDataRecvd: false})
          }, this.MIC_TIMEOUT_MS)
          useDebugStore.getState().setDebugInfo({micDataRecvd: true})

          // Fan raw PCM to local miniapps that subscribed to `audio_chunk`
          // (session.mic.onAudioChunk). forwardEvent is subscriber-gated —
          // a no-op when no miniapp is listening — and should_send_pcm is
          // only flipped on by the runtime when a subscription exists.
          // ArrayBuffer can't survive the JSON bridge, so base64-encode.
          // PERF: ~100 events/sec/subscriber, unbatched; revisit with
          // frame batching if a real always-on audio miniapp ships.
          localMiniappRuntime.forwardEvent("audio_chunk", {
            data: Buffer.from(event.pcm).toString("base64"),
            sampleRate: event.sampleRate,
            format: event.encoding,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("stream_status", (event) => {
          // Phone-owned streams stay on-device; cloud-SDK app streams
          // forward so cloud's lifecycle state machine sees them.
          if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) {
            phoneStreamCoordinator.handleGlassesStatus(event)
            return
          }
          console.log("MANTLE: Forwarding stream status to server:", event)
          socketComms.sendStreamStatus(event)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("keep_alive_ack", (event) => {
          if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) {
            phoneStreamCoordinator.handleKeepAliveAck(event)
            return
          }
          console.log("MANTLE: Forwarding keep-alive ACK to server:", event)
          socketComms.sendKeepAliveAck(event)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("mtk_update_complete", (event) => {
          console.log("MANTLE: MTK firmware update complete:", event.message)
          GlobalEventEmitter.emit("mtk_update_complete", {
            message: event.message,
            timestamp: event.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("ota_start_ack", (event) => {
          console.log("MANTLE: ota_start_ack received from glasses")
          GlobalEventEmitter.emit("ota_start_ack", {timestamp: event.timestamp})
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("ota_status", (event) => {
          const normalized = normalizeOtaStatusEvent(event as Record<string, unknown>)
          const status: OtaStatus = otaStatusFromNormalized(normalized)
          useGlassesStore.getState().setOtaStatus(status)
          // Emit before legacy progress: setOtaProgress can throw (e.g. JSON.stringify in store);
          // native logs would still show while RN UI would stay on "Starting update…".
          GlobalEventEmitter.emit("ota_status", status)
          try {
            useGlassesStore.getState().setOtaProgress(legacyOtaProgressFromOtaStatusEvent(normalized))
          } catch (err) {
            console.warn("MANTLE: ota_status legacy otaProgress mapping failed", err)
          }

          if (status.status === "failed") {
            const raw = event as Record<string, unknown>
            const glassesTimeMs = Number(raw.glasses_time_ms ?? raw.glassesTimeMs ?? 0) || undefined
            const errorCode = normalized.error_message
            if (
              errorCode === "clock_skew" ||
              (errorCode === "ssl_error" && typeof glassesTimeMs === "number" && Number.isFinite(glassesTimeMs))
            ) {
              handleOtaClockSkewFromGlasses(errorCode, glassesTimeMs).catch((err) => {
                console.warn("MANTLE: OTA clock skew auto-fix failed", err)
              })
            }
          }

          if (status.status === "complete" || status.status === "failed") {
            useGlassesStore.getState().setOtaUpdateAvailable(null)
          }
        }),
      )
    }

    // one time get all:
    const bluetoothStatus = await BluetoothSdk.getBluetoothStatus()
    // console.log("MANTLE: Bluetooth status:", bluetoothStatus)
    useCoreStore.getState().setCoreInfo(bluetoothStatus)

    const glassesStatus = await BluetoothSdk.getGlassesStatus()
    // console.log("MANTLE: glasses status:", glassesStatus)
    useGlassesStore.getState().setGlassesInfo(glassesStatus)
  }

  private async sendCalendarEvents() {
    try {
      console.log("MANTLE: sendCalendarEvents()")
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
      const calendarIds = calendars.map((calendar: Calendar.Calendar) => calendar.id)
      // from 2 hours ago to 3 days from now:
      const startDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const endDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      let events = await Calendar.getEventsAsync(calendarIds, startDate, endDate)

      // sort by start date (soonest first)
      events.sort((a: Calendar.Event, b: Calendar.Event) => {
        return new Date(a.startDate as string | Date).getTime() - new Date(b.startDate as string | Date).getTime()
      })

      // limit to first 3 events:
      events = events.slice(0, 3)

      // Shape into the {title, location?, time, endDate} contract the SDK expects.
      // time is a pre-formatted display label; endDate is unix seconds.
      const shapedEvents = events.map((ev: Calendar.Event) => {
        const start = new Date(ev.startDate as string | Date)
        const end = new Date(ev.endDate as string | Date)
        let time: string

        if (ev.allDay) {
          time = "All day"
        } else {
          time = start.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
        }
        // add the duration of the event, i.e. "10:00AM - 11:00AM"
        const duration = end.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
        if (!ev.allDay) {
          time += ` - ${duration}`
        }
        return {
          title: ev.title ?? "",
          ...(ev.location ? {location: ev.location} : {}),
          time,
          endDate: Math.floor(end.getTime() / 1000),
        }
      })
      void BluetoothSdk.setCalendarEvents(shapedEvents).catch((error) => {
        console.warn("MANTLE: Failed to sync calendar events to glasses", error)
      })
      restComms.sendCalendarData({events, calendars})

      // Direct forward to local miniapps. Emit one event per calendar entry
      // so miniapps can treat them as a stream rather than a digest.
      // Gated by CALENDAR in miniapp.json at subscribe time.
      for (const ev of events) {
        localMiniappRuntime.forwardEvent("calendar_event", {
          eventId: ev.id,
          title: ev.title,
          dtStart: ev.startDate,
          dtEnd: ev.endDate,
          timezone: ev.timeZone ?? "",
          allDay: !!ev.allDay,
          location: ev.location ?? "",
          notes: ev.notes ?? "",
          calendarId: ev.calendarId,
        })
      }
    } catch (error) {
      // it's fine if this fails
      console.log("MANTLE: Error sending calendar events", error)
    }
  }

  private async sendLocationUpdates() {
    console.log("MANTLE: sendLocationUpdates()")
    // const location = await Location.getCurrentPositionAsync()
    // socketComms.sendLocationUpdate(location)
  }

  public getLocationAccuracy(accuracy: string) {
    switch (accuracy) {
      case "realtime":
        return Location.LocationAccuracy.BestForNavigation
      case "tenMeters":
        return Location.LocationAccuracy.High
      case "hundredMeters":
        return Location.LocationAccuracy.Balanced
      case "kilometer":
        return Location.LocationAccuracy.Low
      case "threeKilometers":
        return Location.LocationAccuracy.Lowest
      case "reduced":
        return Location.LocationAccuracy.Lowest
      default:
        // console.error("MANTLE: unknown accuracy: " + accuracy)
        return Location.LocationAccuracy.Lowest
    }
  }

  public async setLocationTier(tier: string) {
    console.log("MANTLE: setLocationTier()", tier)
    try {
      const isRegistered = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false)
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
      }
      // "off" means no app is asking for location — leave the task
      // stopped so the OS can power GPS down. Anything else: restart
      // the task at the matching accuracy.
      if (tier === "off") {
        console.log("MANTLE: setLocationTier() stopped — no active subscribers")
        return
      }
      const accuracy = this.getLocationAccuracy(tier)
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy,
        pausesUpdatesAutomatically: false,
      })
      console.log("MANTLE: setLocationTier() success —", tier)
    } catch (error) {
      console.log("MANTLE: Error setting location tier", error)
    }
  }

  public async requestSingleLocation(accuracy: string, correlationId: string) {
    console.log("MANTLE: requestSingleLocation()")
    // restComms.sendLocationData({tier})
    try {
      const location = await Location.getCurrentPositionAsync({accuracy: this.getLocationAccuracy(accuracy)})
      socketComms.sendLocationUpdate(
        location.coords.latitude,
        location.coords.longitude,
        location.coords.accuracy ?? undefined,
        correlationId,
      )
      // Direct forward to local miniapps subscribed to location_update.
      localMiniappRuntime.forwardEvent("location_update", {
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        accuracy: location.coords.accuracy ?? undefined,
        timestamp: location.timestamp,
        correlationId,
      })
    } catch (error) {
      console.log("MANTLE: Error requesting single location", error)
    }
  }

  // mostly for debugging / local stt:
  public async displayTextMain(text: string) {
    logE2EMetric("display_text_main", {
      text,
      line_count: text.split("\n").length,
    })
    this.resetDisplayTimeout()
    socketComms.handle_display_event({
      type: "display_event",
      view: "main",
      layout: {
        layoutType: "text_wall",
        text: text,
      },
    })
  }

  public async handle_head_up(isUp: boolean) {
    socketComms.sendHeadPosition(isUp)

    // Only switch to dashboard view if contextual dashboard is enabled
    // Otherwise, always show main view regardless of head position
    const contextualDashboardEnabled = await useSettingsStore.getState().getSetting(SETTINGS.contextual_dashboard.key)

    if (isUp && contextualDashboardEnabled) {
      useDisplayStore.getState().setView("dashboard")
    } else {
      useDisplayStore.getState().setView("main")
    }
  }

  public async resetDisplayTimeout() {
    if (this.clearTextTimeout) {
      // console.log("MANTLE: canceling pending timeout")
      BgTimer.clearTimeout(this.clearTextTimeout)
    }
    this.clearTextTimeout = BgTimer.setTimeout(() => {
      console.log("MANTLE: clearing text from wall")
    }, 10000) // 10 seconds
  }

  public async handle_local_transcription(data: any) {
    console.log(
      `MANTLE: handle_local_transcription text="${data?.text}" isFinal=${data?.isFinal} lang=${
        data?.transcribeLanguage
      } fallbackActive=${localSttFallbackCoordinator.isActive()}`,
    )
    logE2EMetric("local_transcription_received", {
      text: data?.text ?? "",
      is_final: data?.isFinal ?? false,
      language: data?.transcribeLanguage ?? "",
    })

    // TODO: performance!
    const offlineStt = await useSettingsStore.getState().getSetting(SETTINGS.offline_captions_running.key)
    if (offlineStt) {
      this.transcriptProcessor.changeLanguage(data.transcribeLanguage)
      const processedText = this.transcriptProcessor.processString(data.text, data.isFinal ?? false)

      logE2EMetric("local_transcription_processed", {
        text: data?.text ?? "",
        processed_text: processedText ?? "",
        is_final: data?.isFinal ?? false,
      })

      // Scheduling timeout to clear text from wall. In case of online STT online dashboard manager will handle it.
      // if (data.isFinal) {
      //   this.resetDisplayTimeout()
      // }

      if (processedText) {
        this.displayTextMain(processedText)
      }

      return
    }

    // Local transcripts only ever flow to local miniapps. The cloud-side
    // pipeline (cloud miniapps, cloud-relayed transcripts) is unaffected
    // by this branch — when the cloud WS is up, cloud transcripts arrive
    // independently via SocketComms and reach miniapps via the same
    // forwardEvent. Coordinator's `isActive()` already covers
    // "subscription present AND cloud is dead", so if we got here without
    // it being active there's no consumer and we drop the transcript.
    if (localSttFallbackCoordinator.isActive()) {
      const lang = data?.transcribeLanguage ?? localSttFallbackCoordinator.getActiveLanguage() ?? "en-US"
      localMiniappRuntime.forwardEvent(`transcription:${lang}`, data)
    }
  }

  public async handle_button_press(event: ButtonPressEvent) {
    socketComms.sendButtonPress(event.buttonId, event.pressType)
  }
}

const mantle = MantleManager.getInstance()
export default mantle
