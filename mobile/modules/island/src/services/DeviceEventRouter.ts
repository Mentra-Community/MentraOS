/**
 * Device-event router — island-owned. Subscribes to the inbound native BLE/device
 * events and routes them into the island runtime: device stores, the process event
 * bus, the photo/stream coordinators, and local miniapps (via forwardEvent).
 *
 * Why this exists: island owns the stores, coordinators, miniapp runtime, and facades,
 * but it never *subscribed to the device* for most events — the host MantleManager was
 * still the event router the whole runtime secretly depended on. So a bare OEM that
 * imported island + called toolkit.start() got a connected runtime with almost no device
 * data flowing in (no miniapp input, dead gallery sync, starved coordinators). This
 * service moves those inbound bridges into island so ANY host gets them.
 *
 * Scope: only the NON-v1 legs move here. The v1 SocketComms forwards (touch→cloud,
 * battery→cloud, the cloud-SDK stream/photo legs, etc.) stay in MantleManager and die at
 * v1 retirement. For events MantleManager also forwards over v1, it keeps its v1 leg and
 * this router adds the island leg (no double-handling — owned-stream/photo legs are
 * `owns()`-gated; the forwardEvent legs were removed from MantleManager).
 *
 * Started by `toolkit.start()`. Idempotent.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {shallow} from "zustand/shallow"

import restComms from "./RestComms"
import localMiniappRuntime from "./LocalMiniappRuntime"
import localSttFallbackCoordinator from "./LocalSttFallbackCoordinator"
import {phonePhotoCoordinator} from "./PhonePhotoCoordinator"
import {phoneStreamCoordinator} from "./PhoneStreamCoordinator"
import {isGlassesConnected} from "./GlassesReadiness"
import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore} from "../stores/settings"
import {useAppStatusStore} from "../stores/apps"
import GlobalEventEmitter from "../utils/GlobalEventEmitter"
import {asgCameraApi} from "./asg/asgCameraApi"

let subs: Array<{remove: () => void}> = []

export function startDeviceEventRouter(): void {
  if (subs.length) return

  // --- device state → island stores ---

  // Standalone WiFi status → glasses store.
  subs.push(
    BluetoothSdk.addListener("wifi_status_change", (event) => {
      const {type: _type, ...wifi} = event
      useGlassesStore.getState().setGlassesInfo({wifi})
    }),
  )

  // Forward glasses Wi-Fi to miniapps (session.glasses.onWifi) from the STORE — the
  // single source of truth — so every path converges here: wifi_status_change,
  // onGlassesStatus, and BLE disconnect. Effective connectivity requires the glasses
  // to be connected AND on Wi-Fi, so a disconnect correctly flips `connected` false.
  subs.push({
    remove: useGlassesStore.subscribe(
      (s) => {
        const connected = isGlassesConnected(s.connection) && s.wifi.state === "connected"
        return {
          connected,
          ssid: s.wifi.state === "connected" ? s.wifi.ssid : undefined,
          localIp: s.wifi.state === "connected" ? s.wifi.localIp : undefined,
        }
      },
      (wifi) => localMiniappRuntime.forwardEvent("glasses_wifi", wifi),
      {equalityFn: shallow},
    ),
  })

  // Incremental battery status → glasses store + local miniapps. The Cloud V1
  // websocket `glasses_battery_update` mirror used to live in the host; local
  // miniapps still get the stream here without leaking through the host.
  subs.push(
    BluetoothSdk.addListener("battery_status", (event) => {
      const state = useGlassesStore.getState()
      state.setBatteryInfo(event.level, event.charging, state.caseBatteryLevel, state.caseCharging)
      localMiniappRuntime.forwardEvent("glasses_battery_update", {
        type: "glasses_battery_update",
        level: event.level,
        charging: event.charging,
        timestamp: event.timestamp ?? Date.now(),
      })
    }),
  )

  // Hotspot status → glasses store + event bus. island's own gallerySyncService listens
  // on the bus for these, so without this bridge island's gallery sync is dead.
  subs.push(
    BluetoothSdk.addListener("hotspot_status_change", (event) => {
      const enabled = event.state === "enabled"
      const ssid = enabled ? event.ssid : ""
      const password = enabled ? event.password : ""
      const localIp = enabled ? event.localIp : ""
      useGlassesStore.getState().setHotspotInfo(enabled, ssid, password, localIp)
      if (localIp) {
        asgCameraApi.setServer(localIp, 8089)
      }
      GlobalEventEmitter.emit("hotspot_status_change", {enabled, ssid, password, local_ip: localIp})
    }),
  )
  subs.push(
    BluetoothSdk.addListener("hotspot_error", (event) => {
      GlobalEventEmitter.emit("hotspot_error", {error_message: event.errorMessage, timestamp: event.timestamp})
    }),
  )

  // Glasses gallery content counts → event bus (consumed by gallerySyncService).
  subs.push(
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

  // Hardware-originated setting changes (user changes a setting ON the glasses) → store.
  // The inbound complement to GlassesSettingsSync (which only pushes store→device).
  subs.push(
    BluetoothSdk.addListener("save_setting", async (event) => {
      await useSettingsStore.getState().setSetting(event.key, event.value)
    }),
  )

  // --- coordinators (owns()-gated; MantleManager keeps the cloud-SDK v1 legs) ---

  // Phone-owned photo errors settle the in-flight long-poll fast (vs. timeout). Cloud-app
  // photos forward via restComms (island REST). MantleManager no longer handles this.
  subs.push(
    BluetoothSdk.addListener("photo_response", (event) => {
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

  // Phone-owned stream status / keep-alive → the stream coordinator. Non-owned (cloud-SDK)
  // streams stay on MantleManager's v1 SocketComms leg.
  subs.push(
    BluetoothSdk.addListener("stream_status", (event) => {
      if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) {
        phoneStreamCoordinator.handleGlassesStatus(event)
      }
    }),
  )
  subs.push(
    BluetoothSdk.addListener("keep_alive_ack", (event) => {
      if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) {
        phoneStreamCoordinator.handleKeepAliveAck(event)
      }
    }),
  )

  // --- device input → local miniapps (forwardEvent is subscriber-gated; a no-op when
  // no miniapp listens). MantleManager keeps the v1 SocketComms legs for these. ---

  subs.push(
    BluetoothSdk.addListener("button_press", (event) => {
      localMiniappRuntime.forwardEvent("button_press", event)
    }),
  )
  subs.push(
    BluetoothSdk.addListener("touch_event", (event) => {
      localMiniappRuntime.forwardEvent("touch_event", event)
    }),
  )
  // G2 IMU accelerometer — payload already matches the miniapp AccelData shape.
  subs.push(
    BluetoothSdk.addListener("accel_event", (event) => {
      localMiniappRuntime.forwardEvent("accel_event", {
        x: event.x,
        y: event.y,
        z: event.z,
        timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
      })
    }),
  )
  // Head position — translate native {up:boolean} → SDK {position:"up"|"down"}.
  subs.push(
    BluetoothSdk.addListener("head_up", (event) => {
      localMiniappRuntime.forwardEvent("head_up", {position: event.up ? "up" : "down", timestamp: Date.now()})
    }),
  )
  // On-device STT transcripts → local miniapps, but ONLY when local STT fallback is the
  // active engine (cloud STT is down). When the cloud WS is up, cloud transcripts reach
  // miniapps independently via the same forwardEvent, so gating on isActive() avoids
  // double-delivery. forwardEvent is subscriber-gated — a no-op when no miniapp listens.
  // (Was MantleManager.handle_local_transcription; its offline-captions display branch
  // went away with the pseudo captions renderer.)
  subs.push(
    BluetoothSdk.addListener("local_transcription", (event) => {
      if (!localSttFallbackCoordinator.isActive()) return
      const lang = event.transcribeLanguage ?? localSttFallbackCoordinator.getActiveLanguage() ?? "en-US"
      localMiniappRuntime.forwardEvent(`transcription:${lang}`, event)
    }),
  )

  // --- glasses swipe-menu app launcher (G2) ---
  subs.push(
    BluetoothSdk.addListener("miniapp_selected", (event) => {
      const packageName = event.packageName as string
      if (!packageName) return
      const app = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)
      if (!app) return
      // Toggle: stop if running, else start.
      if (app.running) {
        useAppStatusStore.getState().stop(packageName)
      } else {
        useAppStatusStore.getState().start(app, {skipNavigation: true})
      }
    }),
  )
}

export function stopDeviceEventRouter(): void {
  for (const sub of subs) sub.remove()
  subs = []
}
