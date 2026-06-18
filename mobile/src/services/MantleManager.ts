import BluetoothSdk, {ButtonPressEvent} from "@mentra/bluetooth-sdk-internal"
import CrustModule from "@mentra/crust"
import {Asset} from "expo-asset"
import * as Calendar from "expo-calendar"
import * as Location from "expo-location"
import {router} from "expo-router"
import {shallow} from "zustand/shallow"

import {bootstrapMentraJS} from "@/services/mentraJsBootstrap"
import {phonePhotoCoordinator} from "@mentra/island"
import {phoneStreamCoordinator} from "@mentra/island"
import miniappCatalog from "@/services/miniapps/MiniappCatalog"
import {preinstalledMiniappSync} from "@/services/miniapps/preinstalledMiniappSync"
import {BUNDLED_MINIAPPS} from "@/generated/bundledMiniapps"
import {CHINA_HIDDEN_APPS, isChinaBuild} from "@/constants/miniapps"
import {migrate} from "@/services/Migrations"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {cloudClient, cloudConfigValues} from "@/services/cloudClient"
import {devServerHost} from "@/utils/cloudClient/devHost"
import {gallerySyncService} from "@mentra/island"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {
  appRegistry,
  configureRuntime,
  displayProcessor,
  toolkit,
  phoneLocationService,
  localMiniappRuntime,
  localSttFallbackCoordinator,
  micStateCoordinator,
  offlineSpeechModelService,
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
import {useDebugStore} from "@/stores/debug"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {logE2EMetric} from "@/utils/e2eMetrics"
import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {ensureDevModeForUser} from "@/utils/dev/devModeAllowlist"
import mentraAuth from "@/utils/auth/authClient"
import {Buffer} from "@craftzdog/react-native-buffer"

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
const BGCAP_TELEMETRY = false
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

// The background phone-location task + its tier control moved into island
// (PhoneLocationService). MantleManager now drives it through the island service
// (setupSubscriptions / cleanup) instead of defining the task here.

class MantleManager {
  private static instance: MantleManager | null = null
  private calendarSyncTimer: ReturnType<typeof BgTimer.setInterval> | null = null
  private clearTextTimeout: ReturnType<typeof BgTimer.setTimeout> | null = null
  private micDataTimeout: ReturnType<typeof BgTimer.setTimeout> | null = null
  private MIC_TIMEOUT_MS: number = 1000
  private micDataActive: boolean = false
  private lastMicDataAt: number = 0
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

  private noteMicDataReceived() {
    this.lastMicDataAt = Date.now()

    if (!this.micDataActive) {
      this.micDataActive = true
      useDebugStore.getState().setDebugInfo({micDataRecvd: true})
    }

    if (this.micDataTimeout) {
      return
    }

    this.micDataTimeout = BgTimer.setTimeout(() => this.checkMicDataStillActive(), this.MIC_TIMEOUT_MS)
  }

  private checkMicDataStillActive() {
    this.micDataTimeout = null
    const staleForMs = Date.now() - this.lastMicDataAt

    if (staleForMs < this.MIC_TIMEOUT_MS) {
      this.micDataTimeout = BgTimer.setTimeout(() => this.checkMicDataStillActive(), this.MIC_TIMEOUT_MS - staleForMs)
      return
    }

    if (this.micDataActive) {
      this.micDataActive = false
      useDebugStore.getState().setDebugInfo({micDataRecvd: false})
    }
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

    // Island front door: hand island the host's auth provider, then mark it
    // started. Additive — the `configure*` adapter seams below still wire the
    // host services during the migration; consumers move onto this incrementally.
    toolkit.configure({
      auth: {
        getSubjectToken: async () => {
          const res = await mentraAuth.getSession()
          if (res.is_error() || !res.value.token) {
            throw new Error("toolkit.configure: no session token available")
          }
          return {token: res.value.token, type: "supabase"}
        },
        onStateChange: (callback) => mentraAuth.onAuthStateChange((event, session) => callback(event, session)),
      },
      // Resolved cloud endpoints + LC3 frame size. island builds its cloud
      // client from these; the host keeps the dev/settings URL resolution.
      config: cloudConfigValues(),
    })
    void toolkit.start()

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
    // Construct + connect the cloud client (best-effort). It now lives in island
    // (cloudClientService) and self-wires the runtime cloud/cloudConnection
    // hooks from island-owned transports + the auth/config passed above, so the
    // host no longer injects a CloudRuntimeAdapter. The local-miniapp path is
    // powered by this client.
    cloudClient.init()

    configureRuntime({
      socketComms: {
        sendMessage: (message) => socketComms.sendMessage(message as Parameters<typeof socketComms.sendMessage>[0]),
        updatePhoneSubscriptions: (subs) => socketComms.updatePhoneSubscriptions(subs),
      },
      // audioPlayback (miniapp speaker / TTS playback) moved into island
      // (AudioPlaybackService — pure expo-audio + btsdk volume control) — no longer a hook.
      // glassesStatus read/subscribe moved into island (DisplayProcessor /
      // LocalMiniappRuntime read the island glasses store directly) — no longer hooks.
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
      // cloudConnection is self-wired by island's cloudClientService now (it
      // powers the local-miniapp on-device-STT fallback off cloud liveness), so
      // the host no longer injects it.
      // The dev laptop's live address, from Metro. The island runtime uses it
      // to repair persisted dev-miniapp URLs that froze a previous network's
      // IP (the bundle host is, by construction, reachable right now).
      devServerHost: () => devServerHost(),
      setDisplayEvent: (event) => useDisplayStore.getState().setDisplayEvent(event),
      // sendDisplayEvent / restartTranscriber / setMicRequirements moved into island
      // (LocalDisplayManager / LocalSttFallbackCoordinator / MicStateCoordinator call
      // BluetoothSdk directly) — no longer host hooks. glassesStatus read/subscribe also
      // moved into island (the runtime reads the island glasses store directly).
      // photo capture + video recording moved into island (PhonePhotoCoordinator /
      // PhoneVideoCoordinator, called directly by the runtime) — no longer host hooks.
      // (The photo_response error-routing listener below still drives the coordinator.)
      // camera FOV moved into island too (LocalMiniappRuntime calls BluetoothSdk.setCameraFov
      // directly) — no longer a host cameraSettings hook.
      // Navigation (Google Nav SDK) moved into island (NavigationService, called
      // directly by the runtime's NavigationHandlers) — no longer a host hook.
      // heading / compass moved into island (HeadingService, subscribed directly by
      // the runtime) — no longer a host hook.
      // phone GPS / location tier moved into island (PhoneLocationService, driven
      // directly by the runtime's recomputeLocation) — no longer a host locationTier hook.
      wifiSetup: {
        // session.glasses.requestWifiSetup → open the phone's glasses Wi-Fi
        // setup flow (same screen pairing/deeplinks use for "wifi-setup"). The
        // miniapp's `reason` is forwarded as a route param so the screen can show
        // it as the prompt (mirrors the cloud SDK's requestWifiSetup(reason)).
        // `as any` matches the repo idiom for dynamic params under typedRoutes
        // (see stores/navigation.ts).
        requestSetup: (reason?: string) => {
          router.push({pathname: "/wifi/scan" as any, params: (reason ? {reason} : {}) as any})
        },
      },
      // streaming (RTMP/SRT/WHIP) moved into island (PhoneStreamCoordinator, called
      // directly by the runtime) — no longer a host hook. (The stream_status /
      // keep_alive_ack listeners below still route events to the coordinator.)
    })
    // Wire the runtime's status fanout (now subscribes the island coordinator directly).
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

    // Give the native Bluetooth SDK some time to boot before auto-connecting.
    BgTimer.setTimeout(() => {
      // (Device settings are pushed to native by island's GlassesSettingsSync — on
      // every change AND on the connected transition — so there's no boot push here;
      // the auto-reconnect below triggers that on-connect push. Single source of truth.)
      attemptReconnectToDefaultWearable()
    }, 1000)
    // (Initial notification-config push now happens in island's
    // PhoneNotificationsSync, started by toolkit.start().)

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

    phoneLocationService.stopPhoneLocation()
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

    // Then reconcile the admin-managed preinstall registry from Cloud V2. This
    // lets Core move users to newer bundled miniapp releases without shipping a
    // new mobile binary.
    await preinstalledMiniappSync.sync()
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
      // only start location updates if we have the location permission (host UI gate);
      // the island PhoneLocationService owns the background task + accuracy at the saved tier.
      const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
      if (hasLocation) {
        const savedTier = await useSettingsStore.getState().getSetting(SETTINGS.location_tier.key)
        await phoneLocationService.setLocationTier(savedTier)
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

    // (Device-settings -> glasses BLE sync AND phone-notification config -> the
    // native listener now live in island's GlassesSettingsSync / PhoneNotificationsSync,
    // started by toolkit.start(), so toolkit.glasses.settings.set() /
    // toolkit.phoneNotifications.* reach the device for any host. Removed here to
    // avoid a double-sync.)

    // Remove old event subscriptions
    this.subs.forEach((sub) => sub.remove())
    this.subs = []

    // (The device-status projection — onBluetoothStatus -> core store and
    // onGlassesStatus -> glasses store — moved into island's GlassesStatusProjection,
    // started by toolkit.start(), so the device->store feed reaches ANY host. Removed
    // here to avoid a double-projection.)

    // Subscribe to individual Bluetooth SDK events.
    {
      this.subs.push(
        BluetoothSdk.addListener("log", (event) => {
          if (event.message?.startsWith("MAN: displayEvent ")) return
          console.log("CORE:", event.message)
        }),
      )

      // wifi_status_change / glasses_wifi / hotspot_status_change:
      // moved to island DeviceEventRouter (started by toolkit.start())

      // hotspot_error: moved to island DeviceEventRouter (started by toolkit.start())

      // gallery_status: moved to island DeviceEventRouter (started by toolkit.start())

      // photo_response: moved to island DeviceEventRouter (started by toolkit.start())

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
          // forwardEvent("button_press") -> local miniapps moved to island DeviceEventRouter
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("touch_event", (event) => {
          socketComms.sendTouchEvent(event)
          // forwardEvent("touch_event") -> local miniapps moved to island DeviceEventRouter
        }),
      )

      // accel_event: moved to island DeviceEventRouter (started by toolkit.start())

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

      // NOTE: audio_pairing_needed / audio_connected / audio_disconnected / save_setting /
      // head_up were registered a SECOND time below (the duplicate block), so each handler
      // fired twice per event. The duplicates are removed here; the single registrations
      // live further down (head_up there is the superset — it also forwards to miniapps).

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

      // save_setting: moved to island DeviceEventRouter (started by toolkit.start())

      this.subs.push(
        BluetoothSdk.addListener("head_up", (event) => {
          mantle.handle_head_up(event.up)
          // forwardEvent("head_up") -> local miniapps moved to island DeviceEventRouter
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

      // miniapp_selected: moved to island DeviceEventRouter (started by toolkit.start())

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
          this.noteMicDataReceived()

          // console.log("MANTLE: Received mic_lc3 event from Bluetooth SDK", event.lc3.length)

          // Route audio to: UDP (if enabled) -> WebSocket (fallback). This is the
          // v1 plane (Mentra-app only), deleted at v1 retirement. The v2 cloud fork
          // moved into island (AudioCloudUplink, started by toolkit.start()) so a
          // bare OEM gets cloud audio without this host handler.
          if (udp.enabledAndReady()) {
            // UDP audio is enabled and ready - send directly via UDP
            udp.sendAudio(event.lc3)
            bgcapNoteMicFrame("udp") // BGCAP diagnostic
          } else {
            socketComms.sendBinary(event.lc3)
            bgcapNoteMicFrame("ws") // BGCAP diagnostic
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
          this.noteMicDataReceived()

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
          // Phone-owned streams are handled by the island stream coordinator (DeviceEventRouter);
          // cloud-SDK app streams forward to cloud (v1) so its lifecycle state machine sees them.
          if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) return
          console.log("MANTLE: Forwarding stream status to server:", event)
          socketComms.sendStreamStatus(event)
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("keep_alive_ack", (event) => {
          // Phone-owned keep-alives handled by the island stream coordinator (DeviceEventRouter).
          if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) return
          console.log("MANTLE: Forwarding keep-alive ACK to server:", event)
          socketComms.sendKeepAliveAck(event)
        }),
      )

      // (The OTA BLE event handlers — ota_update_available / mtk_update_complete /
      // ota_start_ack / ota_status → island stores + clock-skew auto-fix — moved into
      // island's OtaService, started by toolkit.start(), behind the toolkit.ota read
      // surface. Removed here to avoid double-handling.)
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

  // getLocationAccuracy + setLocationTier (+ the background location task) moved into
  // island (PhoneLocationService). requestSingleLocation stays here for now — it's a
  // one-shot that still forwards over v1 socketComms (deleted at v1 retirement).
  public async requestSingleLocation(accuracy: string, correlationId: string) {
    console.log("MANTLE: requestSingleLocation()")
    // restComms.sendLocationData({tier})
    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: phoneLocationService.getLocationAccuracy(accuracy),
      })
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
