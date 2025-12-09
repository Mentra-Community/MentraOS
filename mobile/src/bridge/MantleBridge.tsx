import CoreModule from "core"
import Toast from "react-native-toast-message"

import {translate} from "@/i18n"
import livekit from "@/services/Livekit"
import mantle from "@/services/MantleManager"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {INTENSE_LOGGING} from "@/utils/Constants"
import {CoreStatusParser} from "@/utils/CoreStatusParser"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

export class MantleBridge {
  private static instance: MantleBridge | null = null
  private messageEventSubscription: any = null
  private lastMessage: string = ""

  // Private constructor to enforce singleton pattern
  private constructor() {
    // Initialize message event listener
    this.initializeMessageEventListener()
  }

  /**
   * Gets the singleton instance of Bridge
   */
  public static getInstance(): MantleBridge {
    if (!MantleBridge.instance) {
      MantleBridge.instance = new MantleBridge()
    }
    return MantleBridge.instance
  }

  // does nothing but ensures we initialize the class:
  public async dummy() {
    await Promise.resolve()
  }

  /**
   * Initializes the event listener for Core messages
   */
  private initializeMessageEventListener() {
    // Remove any existing subscription to avoid duplicates
    if (this.messageEventSubscription) {
      this.messageEventSubscription.remove()
      this.messageEventSubscription = null
    }

    // Create a fresh subscription
    this.messageEventSubscription = CoreModule.addListener("CoreMessageEvent", (event: any) => {
      // expo adds the body to the event object
      this.handleCoreMessage(event.body)
    })

    console.log("BRIDGE: Core message event listener initialized")
  }

  /**
   * Handles incoming messages from Core
   */
  private handleCoreMessage(jsonString: string) {
    if (INTENSE_LOGGING) {
      console.log("Received message from core:", jsonString)
    }

    if (jsonString.startsWith("CORE:")) {
      console.log("CORE:", jsonString.slice(5))
      return
    }

    try {
      const data = JSON.parse(jsonString)

      // Only check for duplicates on core status messages, not other event types
      if ("core_status" in data) {
        if (this.lastMessage === jsonString) {
          console.log("BRIDGE: DUPLICATE CORE STATUS MESSAGE")
          // return
        }
        this.lastMessage = jsonString
      }

      this.parseDataFromCore(data)
    } catch (e) {
      console.error("BRIDGE: Failed to parse JSON from core message:", e)
      console.log(jsonString)
    }
  }

  /**
   * Parses various types of data received from Core
   */
  private async parseDataFromCore(data: any) {
    if (!data) return

    try {
      if (!("type" in data)) {
        return
      }

      let binaryString
      let bytes
      let res

      switch (data.type) {
        case "core_status_update":
          useGlassesStore.getState().setGlassesInfo(data.core_status.glasses_info)
          GlobalEventEmitter.emit("CORE_STATUS_UPDATE", data)
          return
        case "wifi_status_change":
          useGlassesStore.getState().setWifiInfo(data.connected, data.ssid)
          break
        case "hotspot_status_change":
          useGlassesStore.getState().setHotspotInfo(data.enabled, data.ssid, data.password, data.local_ip)
          GlobalEventEmitter.emit("HOTSPOT_STATUS_CHANGE", {
            enabled: data.enabled,
            ssid: data.ssid,
            password: data.password,
            local_ip: data.local_ip,
          })
          break
        case "hotspot_error":
          GlobalEventEmitter.emit("HOTSPOT_ERROR", {
            error_message: data.error_message,
            timestamp: data.timestamp,
          })
          break
        case "gallery_status":
          GlobalEventEmitter.emit("GALLERY_STATUS", {
            photos: data.photos,
            videos: data.videos,
            total: data.total,
            has_content: data.has_content,
            camera_busy: data.camera_busy, // Add camera busy state
          })
          break
        case "compatible_glasses_search_result":
          console.log("Received compatible_glasses_search_result event from Core", data)
          GlobalEventEmitter.emit("COMPATIBLE_GLASSES_SEARCH_RESULT", {
            modelName: data.model_name,
            deviceName: data.device_name,
            deviceAddress: data.device_address,
          })
          break
        case "compatible_glasses_search_stop":
          GlobalEventEmitter.emit("COMPATIBLE_GLASSES_SEARCH_STOP", {
            model_name: data.model_name,
          })
          break
        case "heartbeat_sent":
          console.log("💓 Received heartbeat_sent event from Core", data.heartbeat_sent)
          GlobalEventEmitter.emit("heartbeat_sent", {
            timestamp: data.heartbeat_sent.timestamp,
          })
          break
        case "heartbeat_received":
          console.log("💓 Received heartbeat_received event from Core", data.heartbeat_received)
          GlobalEventEmitter.emit("heartbeat_received", {
            timestamp: data.heartbeat_received.timestamp,
          })
          break
        case "notify_manager":
        case "show_banner":
          Toast.show({
            type: data.notify_manager.type,
            text1: translate(data.notify_manager.message),
          })
          break
        case "button_press":
          console.log("🔘 BUTTON_PRESS event received:", data)
          mantle.handle_button_press(data.buttonId, data.pressType, data.timestamp)
          break
        case "touch_event": {
          const deviceModel = data.device_model ?? "Mentra Live"
          const gestureName = data.gesture_name ?? "unknown"
          const timestamp = typeof data.timestamp === "number" ? data.timestamp : Date.now()
          GlobalEventEmitter.emit("TOUCH_EVENT", {
            deviceModel,
            gestureName,
            timestamp,
          })
          socketComms.sendTouchEvent({
            device_model: deviceModel,
            gesture_name: gestureName,
            timestamp,
          })
          break
        }
        case "swipe_volume_status": {
          const enabled = !!data.enabled
          const timestamp = typeof data.timestamp === "number" ? data.timestamp : Date.now()
          socketComms.sendSwipeVolumeStatus(enabled, timestamp)
          GlobalEventEmitter.emit("SWIPE_VOLUME_STATUS", {enabled, timestamp})
          break
        }
        case "switch_status": {
          const switchType = typeof data.switch_type === "number" ? data.switch_type : (data.switchType ?? -1)
          const switchValue = typeof data.switch_value === "number" ? data.switch_value : (data.switchValue ?? -1)
          const timestamp = typeof data.timestamp === "number" ? data.timestamp : Date.now()
          socketComms.sendSwitchStatus(switchType, switchValue, timestamp)
          GlobalEventEmitter.emit("SWITCH_STATUS", {switchType, switchValue, timestamp})
          break
        }
        case "rgb_led_control_response": {
          const requestId = data.requestId ?? ""
          const success = !!data.success
          const errorMessage = typeof data.error === "string" ? data.error : null
          socketComms.sendRgbLedControlResponse(requestId, success, errorMessage)
          GlobalEventEmitter.emit("RGB_LED_CONTROL_RESPONSE", {requestId, success, error: errorMessage})
          break
        }
        case "wifi_scan_results":
          GlobalEventEmitter.emit("WIFI_SCAN_RESULTS", {
            networks: data.networks,
          })
          break
        case "pair_failure":
          GlobalEventEmitter.emit("PAIR_FAILURE", data.error)
          break
        case "audio_pairing_needed":
          GlobalEventEmitter.emit("AUDIO_PAIRING_NEEDED", {
            deviceName: data.device_name,
          })
          break
        case "audio_connected":
          GlobalEventEmitter.emit("AUDIO_CONNECTED", {
            deviceName: data.device_name,
          })
          break
        case "audio_disconnected":
          GlobalEventEmitter.emit("AUDIO_DISCONNECTED", {})
          break
        case "save_setting":
          await useSettingsStore.getState().setSetting(data.key, data.value)
          break
        case "head_up":
          mantle.handle_head_up(data.up)
          break
        case "local_transcription":
          mantle.handle_local_transcription(data)
          break
        case "phone_notification":
          // Send phone notification via REST instead of WebSocket
          res = await restComms.sendPhoneNotification({
            notificationId: data.notificationId,
            app: data.app,
            title: data.title,
            content: data.content,
            priority: data.priority,
            timestamp: data.timestamp,
            packageName: data.packageName,
          })
          if (res.is_error()) {
            console.error("Failed to send phone notification:", res.error)
          }
          break
        case "phone_notification_dismissed":
          // Send phone notification dismissal via REST
          res = await restComms.sendPhoneNotificationDismissed({
            notificationKey: data.notificationKey,
            packageName: data.packageName,
            notificationId: data.notificationId,
          })
          if (res.is_error()) {
            console.error("Failed to send phone notification dismissal:", res.error)
          }
          break
        // TODO: this is a bit of a hack, we should have dedicated functions for ws endpoints in the core:
        case "ws_text":
          socketComms.sendText(data.text)
          break
        case "ws_bin":
          binaryString = atob(data.base64)
          bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }
          socketComms.sendBinary(bytes)
          break
        case "mic_data":
          binaryString = atob(data.base64)
          bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }
          const isChinaDeployment = await useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)
          if (!isChinaDeployment && livekit.isRoomConnected()) {
            livekit.addPcm(bytes)
          } else {
            socketComms.sendBinary(bytes)
          }
          break
        case "rtmp_stream_status":
          console.log("MantleBridge: Forwarding RTMP stream status to server:", data)
          socketComms.sendRtmpStreamStatus(data)
          break
        case "keep_alive_ack":
          console.log("MantleBridge: Forwarding keep-alive ACK to server:", data)
          socketComms.sendKeepAliveAck(data)
          break
        case "mtk_update_complete":
          console.log("MantleBridge: MTK firmware update complete:", data.message)
          GlobalEventEmitter.emit("MTK_UPDATE_COMPLETE", {
            message: data.message,
            timestamp: data.timestamp,
          })
          break
        case "version_info":
          console.log("MantleBridge: Received version_info:", data)
          useGlassesStore.getState().setGlassesInfo({
            appVersion: data.app_version,
            buildNumber: data.build_number,
            modelName: data.device_model,
            androidVersion: data.android_version,
            otaVersionUrl: data.ota_version_url,
          })
          break
        default:
          console.log("Unknown event type:", data.type)
          break
      }
    } catch (e) {
      console.error("Error parsing data from Core:", e)
      GlobalEventEmitter.emit("CORE_STATUS_UPDATE", CoreStatusParser.defaultStatus)
    }
  }

  /**
   * Cleans up resources and resets the state
   */
  public cleanup() {
    // Remove message event listener
    if (this.messageEventSubscription) {
      this.messageEventSubscription.remove()
      this.messageEventSubscription = null
    }

    // Reset the singleton instance
    MantleBridge.instance = null

    console.log("Bridge cleaned up")
  }

  /* Command methods to interact with Core */

  async updateButtonPhotoSize(size: string) {
    return await CoreModule.updateSettings({
      button_photo_size: size,
    })
  }

  async updateButtonVideoSettings(width: number, height: number, fps: number) {
    console.log("updateButtonVideoSettings", width, height, fps)
    return await CoreModule.updateSettings({
      button_video_width: width,
      button_video_height: height,
      button_video_fps: fps,
    })
  }

  async setGlassesWifiCredentials(ssid: string, _password: string) {
    // TODO: Add setGlassesWifiCredentials to CoreModule
    console.warn("setGlassesWifiCredentials not yet implemented in new CoreModule API")
    console.log("Would set credentials:", ssid)
  }

  async disconnectFromWifi() {
    console.log("Sending WiFi disconnect command to Core")
    // TODO: Add disconnectWifi to CoreModule
    console.warn("disconnectFromWifi not yet implemented in new CoreModule API")
  }

  async setLc3AudioEnabled(enabled: boolean) {
    console.log("setLc3AudioEnabled", enabled)
    // TODO: Add setLc3AudioEnabled to CoreModule
    console.warn("setLc3AudioEnabled not yet implemented in new CoreModule API")
  }
}

// Create and export the singleton instance
const bridge = MantleBridge.getInstance()
export default bridge
