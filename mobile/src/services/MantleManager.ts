import CoreModule, {ButtonPressEvent, CoreStatus, GlassesStatus} from "core"
import * as Battery from "expo-battery"
import * as Calendar from "expo-calendar"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import {shallow} from "zustand/shallow"

import livekit from "@/services/Livekit"
import localMiniappRuntime from "@/services/LocalMiniappRuntime"
import localSttFallbackCoordinator from "@/services/LocalSttFallbackCoordinator"
import micStateCoordinator from "@/services/MicStateCoordinator"
import miniSockets from "@/services/MiniSockets"
import composer from "@/services/Composer"
import {migrate} from "@/services/Migrations"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {gallerySyncService} from "@/services/asg/gallerySyncService"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore, getGlasesInfoPartial} from "@/stores/glasses"
import {useSettingsStore, SETTINGS} from "@/stores/settings"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import TranscriptProcessor from "@/utils/TranscriptProcessor"
import {useCoreStore} from "@/stores/core"
import udp from "@/services/UdpManager"
import {BgTimer} from "@/utils/timers"
import {useDebugStore} from "@/stores/debug"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {logE2EMetric} from "@/utils/e2eMetrics"
import {useAppletStatusStore} from "@/stores/applets"
import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"

const LOCATION_TASK_NAME = "handleLocationUpdates"

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

    await migrate() // do any local migrations here
    const res = await restComms.loadUserSettings() // get settings from server
    if (res.is_ok()) {
      let loadedSettings = res.value
      // exclude default_wearable and pending_wearable from the settings when pulling from the server:
      delete loadedSettings["default_wearable"]
      delete loadedSettings["pending_wearable"]
      delete loadedSettings["default_controller"]
      delete loadedSettings["pending_controller"]
      delete loadedSettings["controller_device_name"]
      delete loadedSettings["controller_address"]

      await useSettingsStore.getState().setManyLocally(loadedSettings) // write settings to local storage
    } else {
      console.error("MANTLE: No settings received from server")
    }

    // Send device timezone to cloud (used for calendar/time display)
    this.syncTimezone()

    // give the core some time to boot before sending all the initial settings:
    BgTimer.setTimeout(() => {
      const initialCoreSettings = useSettingsStore.getState().getCoreSettings()
      CoreModule.updateCore(initialCoreSettings) // send settings to core
      console.log("MANTLE: Settings sent to core")
      // settings are now in native; safe to attempt auto-connect
      attemptReconnectToDefaultWearable()
    }, 1000)

    this.initServices()
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
    miniSockets.stop()

    livekit.disconnect()
    await socketComms.cleanup()
    restComms.goodbye()
  }

  private async initServices() {
    socketComms.connectWebsocket()
    gallerySyncService.initialize()

    // Initialize Composer (scans Paths.document/lmas/ and populates appletStatusStore)
    await composer.initialize()

    // Initialize local miniapp runtime
    localMiniappRuntime.initialize()

    // Start MiniSockets conditionally (only if user has local miniapps)
    const localApps = await composer.getLocalApplets()
    if (localApps.length > 0) {
      miniSockets.start()
      miniSockets.onTextMessage((clientId, text) => {
        // For MiniSocket clients, we need to identify the packageName from the CONNECT message.
        // For now, route through LocalMiniappRuntime with a placeholder.
        // The actual packageName binding happens in the CONNECT handler.
        localMiniappRuntime.handleRawMessage(`__minisocket_${clientId}`, text)
      })
    }
  }

  private async setupPeriodicTasks() {
    this.sendCalendarEvents()
    // Calendar sync every hour
    this.calendarSyncTimer = BgTimer.setInterval(() => {
      this.sendCalendarEvents()
    }, 60 * 60 * 1000) // 1 hour

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
    //       await CoreModule.connectDefault()
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
      (state: Partial<GlassesStatus>, previousState: Partial<GlassesStatus>) => {
        const statusObj: Partial<GlassesStatus> = {}

        for (const key in state) {
          const k = key as keyof GlassesStatus
          if (state[k] !== previousState[k]) {
            statusObj[k] = state[k] as any
          }
        }
        restComms.updateGlassesState(statusObj)
      },
      {equalityFn: shallow},
    )

    // subscribe to core settings changes and update the core:
    useSettingsStore.subscribe(
      (state) => state.getCoreSettings(),
      (state: Record<string, any>, previousState: Record<string, any>) => {
        const coreSettingsObj: Record<string, any> = {}

        for (const key in state) {
          const k = key as keyof Record<string, any>
          if (state[k] !== previousState[k]) {
            coreSettingsObj[k] = state[k] as any
          }
        }
        // console.log("MANTLE: core settings changed", coreSettingsObj)
        CoreModule.updateCore(coreSettingsObj)
      },
      {equalityFn: shallow},
    )

    // Remove old event subscriptions
    this.subs.forEach((sub) => sub.remove())
    this.subs = []

    // forward core status changes to the zustand core store:
    this.subs.push(
      CoreModule.addListener("core_status", (changed: Partial<CoreStatus>) => {
        // console.log("MANTLE: Core status changed", changed)
        useCoreStore.getState().setCoreInfo(changed)
      }),
    )
    this.subs.push(
      CoreModule.addListener("glasses_status", (changed) => {
        // console.log("MANTLE: Glasses status changed", changed)
        useGlassesStore.getState().setGlassesInfo(changed)
        localMiniappRuntime.forwardEvent("glasses_connection_state", changed)
      }),
    )

    // Subscribe to individual core events
    {
      this.subs.push(
        CoreModule.addListener("log", (event) => {
          console.log("CORE:", event.message)
        }),
      )

      // TODO: remove since we can sub to the zustand store for wifi info:
      this.subs.push(
        CoreModule.addListener("hotspot_status_change", (event) => {
          useGlassesStore.getState().setHotspotInfo(event.enabled, event.ssid, event.password, event.local_ip)
          GlobalEventEmitter.emit("hotspot_status_change", {
            enabled: event.enabled,
            ssid: event.ssid,
            password: event.password,
            local_ip: event.local_ip,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("hotspot_error", (event) => {
          GlobalEventEmitter.emit("hotspot_error", {
            error_message: event.error_message,
            timestamp: event.timestamp,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("gallery_status", (event) => {
          GlobalEventEmitter.emit("gallery_status", {
            photos: event.photos,
            videos: event.videos,
            total: event.total,
            has_content: event.has_content,
            camera_busy: event.camera_busy,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("photo_response", (event) => {
          restComms.sendPhotoResponse(event)
        }),
      )

      this.subs.push(
        CoreModule.addListener("heartbeat_sent", (event) => {
          console.log("MANTLE: received heartbeat_sent event from Core", event.heartbeat_sent)
          // TODO: remove the global event emitter and sub directly in the component where needed
          GlobalEventEmitter.emit("heartbeat_sent", {
            timestamp: event.heartbeat_sent.timestamp,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("heartbeat_received", (event) => {
          console.log("MANTLE: received heartbeat_received event from Core", event.heartbeat_received)
          // TODO: remove the global event emitter and sub directly in the component where needed
          GlobalEventEmitter.emit("heartbeat_received", {
            timestamp: event.heartbeat_received.timestamp,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("button_press", (event) => {
          console.log("MANTLE: BUTTON_PRESS event received:", event)
          this.handle_button_press(event)
          localMiniappRuntime.forwardEvent("button_press", event)
        }),
      )

      this.subs.push(
        CoreModule.addListener("touch_event", (event) => {
          const deviceModel = event.device_model ?? "Mentra Live"
          const gestureName = event.gesture_name ?? "unknown"
          const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
          socketComms.sendTouchEvent({
            device_model: deviceModel,
            gesture_name: gestureName,
            timestamp,
          })
          localMiniappRuntime.forwardEvent("touch_event", event)
        }),
      )

      this.subs.push(
        CoreModule.addListener("swipe_volume_status", (event) => {
          const enabled = !!event.enabled
          const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
          socketComms.sendSwipeVolumeStatus(enabled, timestamp)
          // TODO: remove
          GlobalEventEmitter.emit("SWIPE_VOLUME_STATUS", {enabled, timestamp})
        }),
      )

      this.subs.push(
        CoreModule.addListener("switch_status", (event) => {
          const switchType = typeof event.switch_type === "number" ? event.switch_type : event.switchType ?? -1
          const switchValue = typeof event.switch_value === "number" ? event.switch_value : event.switchValue ?? -1
          const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
          socketComms.sendSwitchStatus(switchType, switchValue, timestamp)
          // TODO: remove
          GlobalEventEmitter.emit("SWITCH_STATUS", {switchType, switchValue, timestamp})
        }),
      )

      this.subs.push(
        CoreModule.addListener("rgb_led_control_response", (event) => {
          const requestId = event.requestId ?? ""
          const success = !!event.success
          const errorMessage = typeof event.error === "string" ? event.error : null
          socketComms.sendRgbLedControlResponse(requestId, success, errorMessage)
          // TODO: remove
          GlobalEventEmitter.emit("rgb_led_control_response", {requestId, success, error: errorMessage})
        }),
      )

      this.subs.push(
        CoreModule.addListener("pair_failure", (event) => {
          GlobalEventEmitter.emit("pair_failure", event.error)
        }),
      )

      this.subs.push(
        CoreModule.addListener("captions_tester_incident", (event) => {
          const failureCode = typeof event.failure_code === "string" ? event.failure_code : "unknown"
          const failureMessage =
            typeof event.failure_message === "string" ? event.failure_message : "Captions tester incident detected."
          const testRunId = typeof event.test_run_id === "string" ? event.test_run_id : undefined
          const scenarioName = typeof event.scenario_name === "string" ? event.scenario_name : undefined
          const alertId = typeof event.alert_id === "string" ? event.alert_id : testRunId

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
              expectedBehavior: "Captions tester runs should complete without a captions incident.",
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
        CoreModule.addListener("audio_pairing_needed", (event) => {
          GlobalEventEmitter.emit("audio_pairing_needed", {
            deviceName: event.device_name,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("audio_connected", (event) => {
          GlobalEventEmitter.emit("audio_connected", {
            deviceName: event.device_name,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("audio_disconnected", () => {
          GlobalEventEmitter.emit("audio_disconnected", {})
        }),
      )

      // allow the core to change settings so it can persist state:
      this.subs.push(
        CoreModule.addListener("save_setting", async (event) => {
          console.log("MANTLE: Received save_setting event from Core:", event)
          await useSettingsStore.getState().setSetting(event.key, event.value)
        }),
      )

      this.subs.push(
        CoreModule.addListener("head_up", (event) => {
          mantle.handle_head_up(event.up)
          // Translate native {up: boolean} → cloud-SDK shape {position: "up" | "down"}
          localMiniappRuntime.forwardEvent("head_up", {
            position: event.up ? "up" : "down",
            timestamp: Date.now(),
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("glasses_battery_update", (event) => {
          localMiniappRuntime.forwardEvent("glasses_battery_update", event)
        }),
      )

      // Phone battery — emit on level/state change so miniapps can subscribe
      // to phone_battery the same way they subscribe to glasses_battery.
      // Also mirror to glasses_battery when connected to Simulated Glasses
      // (which have no real battery) so dev flows don't see "—".
      const emitPhoneBattery = async () => {
        try {
          const level = await Battery.getBatteryLevelAsync()
          const state = await Battery.getBatteryStateAsync()
          const charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL
          const payload = {
            level: Math.round(level * 100),
            charging,
            timestamp: Date.now(),
          }
          localMiniappRuntime.forwardEvent("phone_battery", payload)

          const deviceModel = useGlassesStore.getState().deviceModel || ""
          if (deviceModel.toLowerCase().includes("simulated")) {
            localMiniappRuntime.forwardEvent("glasses_battery_update", payload)
          }
        } catch (err) {
          console.log("MANTLE: phone battery read failed", err)
        }
      }
      void emitPhoneBattery()
      const batteryLevelSub = Battery.addBatteryLevelListener(emitPhoneBattery)
      const batteryStateSub = Battery.addBatteryStateListener(emitPhoneBattery)
      this.subs.push({remove: () => batteryLevelSub.remove()})
      this.subs.push({remove: () => batteryStateSub.remove()})

      this.subs.push(
        CoreModule.addListener("vad", (event) => {
          localMiniappRuntime.forwardEvent("VAD", event)
          localSttFallbackCoordinator.onVad(!!event?.status)
        }),
      )

      this.subs.push(
        CoreModule.addListener("audio_chunk", (event) => {
          localMiniappRuntime.forwardEvent("audio_chunk", event)
        }),
      )

      // G2 dashboard menu: user selected a miniapp from the glasses swipe menu
      // G2.swift resolves the numeric appId → packageName before sending this event
      this.subs.push(
        CoreModule.addListener("miniapp_selected", (event) => {
          const packageName = event.packageName as string
          if (!packageName) return
          const applet = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)
          if (!applet) return
          // Toggle: if already running, stop it; otherwise start it
          if (applet.running) {
            console.log(`MANTLE: miniapp_selected — stopping ${packageName}`)
            useAppletStatusStore.getState().stopApplet(packageName)
          } else {
            console.log(`MANTLE: miniapp_selected — starting ${packageName}`)
            useAppletStatusStore.getState().startApplet(applet, {skipNavigation: true})
          }
        }),
      )

      // G2 dashboard menu: sync on glasses connect
      this.subs.push(
        useGlassesStore.subscribe(
          (state) => state.fullyBooted,
          async (fullyBooted) => {
            if (!fullyBooted) return
            await syncDashboardMenu()
          },
        ),
      )

      // G2 dashboard menu: re-sync when app list changes (handles app install/uninstall,
      // server refresh after connect, and race where apps weren't loaded on first connect)
      this.subs.push(
        useAppletStatusStore.subscribe(async (state, prevState) => {
          if (state.apps !== prevState.apps && state.apps.length > 0) {
            await syncDashboardMenu()
          }
        }),
      )

      // G2 dashboard menu: user selected a miniapp from the glasses swipe menu
      // G2.swift resolves the numeric appId → packageName before sending this event
      this.subs.push(
        CoreModule.addListener("miniapp_selected", (event) => {
          const packageName = event.packageName as string
          if (!packageName) return
          const applet = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)
          if (!applet) return
          // Toggle: if already running, stop it; otherwise start it
          if (applet.running) {
            console.log(`MANTLE: miniapp_selected — stopping ${packageName}`)
            useAppletStatusStore.getState().stopApplet(packageName)
          } else {
            console.log(`MANTLE: miniapp_selected — starting ${packageName}`)
            useAppletStatusStore.getState().startApplet(applet, {skipNavigation: true})
          }
        }),
      )

      this.subs.push(
        CoreModule.addListener("local_transcription", (event) => {
          mantle.handle_local_transcription(event)
        }),
      )

      this.subs.push(
        CoreModule.addListener("phone_notification", async (event) => {
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
        CoreModule.addListener("phone_notification_dismissed", async (event) => {
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
        CoreModule.addListener("ws_text", (event) => {
          socketComms.sendText(event.text)
        }),
      )

      this.subs.push(
        CoreModule.addListener("ws_bin", (event) => {
          const binaryString = atob(event.base64)
          const bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }
          socketComms.sendBinary(bytes)
        }),
      )

      this.subs.push(
        CoreModule.addListener("mic_lc3", (event) => {
          if (this.micDataTimeout) {
            BgTimer.clearTimeout(this.micDataTimeout)
          }
          this.micDataTimeout = BgTimer.setTimeout(() => {
            useDebugStore.getState().setDebugInfo({micDataRecvd: false})
          }, this.MIC_TIMEOUT_MS)
          useDebugStore.getState().setDebugInfo({micDataRecvd: true})

          // console.log("MANTLE: Received mic_lc3 event from Core", event.lc3.length)

          // Route audio to: UDP (if enabled) -> WebSocket (fallback)
          if (udp.enabledAndReady()) {
            // UDP audio is enabled and ready - send directly via UDP
            udp.sendAudio(event.lc3)
          } else {
            socketComms.sendBinary(event.lc3)
          }
        }),
      )

      this.subs.push(
        CoreModule.addListener("mic_pcm", () => {
          // mic_pcm events are strictly on-device. Local miniapps consume
          // raw PCM via the `audio_chunk` listener; Sherpa-ONNX consumes
          // it via the local-STT path. The cloud only ever receives LC3
          // (mic_lc3 listener above). Never forward PCM bytes upstream —
          // we'd interleave them with LC3 frames on the same binary
          // WebSocket and corrupt the cloud's audio decoder.
          if (this.micDataTimeout) {
            BgTimer.clearTimeout(this.micDataTimeout)
          }
          this.micDataTimeout = BgTimer.setTimeout(() => {
            useDebugStore.getState().setDebugInfo({micDataRecvd: false})
          }, this.MIC_TIMEOUT_MS)
          useDebugStore.getState().setDebugInfo({micDataRecvd: true})
        }),
      )

      this.subs.push(
        CoreModule.addListener("stream_status", (event) => {
          console.log("MANTLE: Forwarding stream status to server:", event)
          socketComms.sendStreamStatus(event)
        }),
      )

      this.subs.push(
        CoreModule.addListener("keep_alive_ack", (event) => {
          console.log("MANTLE: Forwarding keep-alive ACK to server:", event)
          socketComms.sendKeepAliveAck(event)
        }),
      )

      this.subs.push(
        CoreModule.addListener("ota_update_available", (event) => {
          if (!useGlassesStore.getState().connected) {
            console.log("📱 MANTLE: Ignoring ota_update_available - glasses not connected")
            return
          }
          console.log("📱 MANTLE: OTA update available from glasses:", event)
          useGlassesStore.getState().setOtaUpdateAvailable({
            available: true,
            versionCode: event.version_code ?? 0,
            versionName: event.version_name ?? "",
            updates: event.updates ?? [],
            totalSize: event.total_size ?? 0,
          })
          GlobalEventEmitter.emit("ota_update_available", {
            versionCode: event.version_code,
            versionName: event.version_name,
            updates: event.updates,
            totalSize: event.total_size,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("mtk_update_complete", (event) => {
          console.log("MANTLE: MTK firmware update complete:", event.message)
          GlobalEventEmitter.emit("mtk_update_complete", {
            message: event.message,
            timestamp: event.timestamp,
          })
        }),
      )

      this.subs.push(
        CoreModule.addListener("ota_start_ack", (event) => {
          console.log("MANTLE: ota_start_ack received from glasses")
          GlobalEventEmitter.emit("ota_start_ack", {timestamp: event.timestamp})
        }),
      )

      this.subs.push(
        CoreModule.addListener("ota_progress", (event) => {
          console.log("📱 MANTLE: OTA progress:", event.stage, event.status, event.progress + "%")
          useGlassesStore.getState().setOtaProgress({
            stage: event.stage ?? "download",
            status: event.status ?? "PROGRESS",
            progress: event.progress ?? 0,
            bytesDownloaded: event.bytes_downloaded ?? 0,
            totalBytes: event.total_bytes ?? 0,
            currentUpdate: event.current_update ?? "apk",
            errorMessage: event.error_message,
          })
          GlobalEventEmitter.emit("ota_progress", {
            stage: event.stage,
            status: event.status,
            progress: event.progress,
            bytesDownloaded: event.bytes_downloaded,
            totalBytes: event.total_bytes,
            currentUpdate: event.current_update,
            errorMessage: event.error_message,
          })
          // Clear OTA update available when finished or failed
          if (event.status === "FINISHED" || event.status === "FAILED") {
            useGlassesStore.getState().setOtaUpdateAvailable(null)
          }
        }),
      )
    }

    // one time get all:
    const coreStatus = await CoreModule.getCoreStatus()
    // console.log("MANTLE: core status:", coreStatus)
    useCoreStore.getState().setCoreInfo(coreStatus)

    const glassesStatus = await CoreModule.getGlassesStatus()
    // console.log("MANTLE: glasses status:", glassesStatus)
    useGlassesStore.getState().setGlassesInfo(glassesStatus)
  }

  private async sendCalendarEvents() {
    try {
      console.log("MANTLE: sendCalendarEvents()")
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
      const calendarIds = calendars.map((calendar: Calendar.Calendar) => calendar.id)
      // from 2 hours ago to 1 week from now:
      const startDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      const events = await Calendar.getEventsAsync(calendarIds, startDate, endDate)
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
    // restComms.sendLocationData({tier})
    try {
      const accuracy = this.getLocationAccuracy(tier)
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: accuracy,
        pausesUpdatesAutomatically: false,
      })
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
      `MANTLE: handle_local_transcription text="${data?.text}" isFinal=${data?.isFinal} lang=${data?.transcribeLanguage} fallbackActive=${localSttFallbackCoordinator.isActive()}`,
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

    if (localSttFallbackCoordinator.isActive()) {
      const lang = data?.transcribeLanguage ?? localSttFallbackCoordinator.getActiveLanguage() ?? "en-US"
      localMiniappRuntime.forwardEvent(`transcription:${lang}`, data)
      return
    }

    socketComms.sendLocalTranscription(data)
  }

  public async handle_button_press(event: ButtonPressEvent) {
    socketComms.sendButtonPress(event.buttonId, event.pressType)
  }
}

const mantle = MantleManager.getInstance()
export default mantle
