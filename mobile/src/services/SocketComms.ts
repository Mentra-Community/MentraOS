import CoreModule from "core"
import {router} from "expo-router"

import {push} from "@/contexts/NavigationRef"
import livekit from "@/services/Livekit"
import mantle from "@/services/MantleManager"
import wsManager from "@/services/WebSocketManager"
import {useAppletStatusStore} from "@/stores/applets"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore} from "@/stores/glasses"
import {useSettingsStore, SETTINGS} from "@/stores/settings"
import {showAlert} from "@/utils/AlertUtils"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

class SocketComms {
  private static instance: SocketComms | null = null
  private ws = wsManager
  private coreToken: string = ""
  public userid: string = ""

  private reconnecting = false
  private reconnectionAttempts = 0

  private constructor() {
    // Subscribe to WebSocket messages
    this.ws.on("message", message => {
      this.handle_message(message)
    })
  }

  public static getInstance(): SocketComms {
    if (!SocketComms.instance) {
      SocketComms.instance = new SocketComms()
    }

    return SocketComms.instance
  }

  public cleanup() {
    // Cleanup WebSocket
    this.ws.cleanup()

    // Reset instance
    SocketComms.instance = null
  }

  // Connection Management

  private async connectWebsocket() {
    console.log("SOCKET: connectWebsocket()")
    const url = useSettingsStore.getState().getWsUrl()
    if (!url) {
      console.error(`SOCKET: Invalid server URL`)
      return
    }
    this.ws.connect(url, this.coreToken)
  }

  public isWebSocketConnected(): boolean {
    return this.ws.isConnected()
  }

  public prestartConnection() {
    console.log(`SOCKET: restartConnection`)
    if (this.ws.isConnected()) {
      this.ws.disconnect()
      this.connectWebsocket()
    }
  }

  public setAuthCreds(coreToken: string, userid: string) {
    console.log(`SOCKET: setAuthCreds(): ${coreToken.substring(0, 10)}..., ${userid}`)
    this.coreToken = coreToken
    this.userid = userid
    useSettingsStore.getState().setSetting(SETTINGS.core_token.key, coreToken)
    this.connectWebsocket()
  }

  public sendAudioPlayResponse(requestId: string, success: boolean, error: string | null, duration: number | null) {
    const msg = {
      type: "audio_play_response",
      requestId: requestId,
      success: success,
      error: error,
      duration: duration,
    }
    this.ws.sendText(JSON.stringify(msg))
  }

  public sendRtmpStreamStatus(statusMessage: any) {
    try {
      // Forward the status message directly since it's already in the correct format
      this.ws.sendText(JSON.stringify(statusMessage))
      console.log("SOCKET: Sent RTMP stream status:", statusMessage)
    } catch (error) {
      console.log(`SOCKET: Failed to send RTMP stream status: ${error}`)
    }
  }

  public sendKeepAliveAck(ackMessage: any) {
    try {
      // Forward the ACK message directly since it's already in the correct format
      this.ws.sendText(JSON.stringify(ackMessage))
      console.log("SOCKET: Sent keep-alive ACK:", ackMessage)
    } catch (error) {
      console.log(`SOCKET: Failed to send keep-alive ACK: ${error}`)
    }
  }

  public sendGlassesConnectionState(): void {
    let modelName = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    const glassesInfo = useGlassesStore.getState()

    // Always include WiFi info - null means "unknown", false means "explicitly disconnected"
    const wifiInfo = {
      connected: glassesInfo.wifiConnected ?? null,
      ssid: glassesInfo.wifiSsid ?? null,
    }

    const connected = glassesInfo.connected

    this.ws.sendText(
      JSON.stringify({
        type: "glasses_connection_state",
        modelName: modelName,
        status: connected ? "CONNECTED" : "DISCONNECTED",
        timestamp: new Date(),
        wifi: wifiInfo,
      }),
    )
  }

  public sendBatteryStatus(): void {
    const batteryLevel = useGlassesStore.getState().batteryLevel
    const charging = useGlassesStore.getState().charging
    const msg = {
      type: "glasses_battery_update",
      level: batteryLevel,
      charging: charging,
      timestamp: Date.now(),
    }
    this.ws.sendText(JSON.stringify(msg))
  }

  public sendText(text: string) {
    try {
      this.ws.sendText(text)
    } catch (error) {
      console.log(`SOCKET: Failed to send text: ${error}`)
    }
  }

  public sendBinary(data: ArrayBuffer | Uint8Array) {
    try {
      this.ws.sendBinary(data)
    } catch (error) {
      console.log(`SOCKET: Failed to send binary: ${error}`)
    }
  }

  // SERVER COMMANDS
  // these are public functions that can be called from anywhere to notify the server of something:
  // should all be prefixed with send

  public sendVadStatus(isSpeaking: boolean) {
    const vadMsg = {
      type: "VAD",
      status: isSpeaking,
    }

    const jsonString = JSON.stringify(vadMsg)
    this.ws.sendText(jsonString)
  }

  public sendLocationUpdate(lat: number, lng: number, accuracy?: number, correlationId?: string) {
    try {
      const event: any = {
        type: "location_update",
        lat: lat,
        lng: lng,
        timestamp: Date.now(),
      }

      if (accuracy !== undefined) {
        event.accuracy = accuracy
      }

      if (correlationId) {
        event.correlationId = correlationId
      }

      const jsonString = JSON.stringify(event)
      this.ws.sendText(jsonString)
    } catch (error) {
      console.log(`SOCKET: Error building location_update JSON: ${error}`)
    }
  }

  // Hardware Events
  public sendButtonPress(buttonId: string, pressType: string) {
    try {
      const event = {
        type: "button_press",
        buttonId: buttonId,
        pressType: pressType,
        timestamp: Date.now(),
      }

      const jsonString = JSON.stringify(event)
      this.ws.sendText(jsonString)
    } catch (error) {
      console.log(`SOCKET: Error building button_press JSON: ${error}`)
    }
  }

  public sendPhotoResponse(requestId: string, photoUrl: string) {
    try {
      const event = {
        type: "photo_response",
        requestId: requestId,
        photoUrl: photoUrl,
        timestamp: Date.now(),
      }

      const jsonString = JSON.stringify(event)
      this.ws.sendText(jsonString)
    } catch (error) {
      console.log(`SOCKET: Error building photo_response JSON: ${error}`)
    }
  }

  public sendVideoStreamResponse(appId: string, streamUrl: string) {
    try {
      const event = {
        type: "video_stream_response",
        appId: appId,
        streamUrl: streamUrl,
        timestamp: Date.now(),
      }

      const jsonString = JSON.stringify(event)
      this.ws.sendText(jsonString)
    } catch (error) {
      console.log(`SOCKET: Error building video_stream_response JSON: ${error}`)
    }
  }

  public sendTouchEvent(event: {device_model: string; gesture_name: string; timestamp: number}) {
    try {
      const payload = {
        type: "touch_event",
        device_model: event.device_model,
        gesture_name: event.gesture_name,
        timestamp: event.timestamp,
      }
      this.ws.sendText(JSON.stringify(payload))
    } catch (error) {
      console.log(`SOCKET: Error sending touch_event: ${error}`)
    }
  }

  public sendSwipeVolumeStatus(enabled: boolean, timestamp: number) {
    try {
      const payload = {
        type: "swipe_volume_status",
        enabled,
        timestamp,
      }
      this.ws.sendText(JSON.stringify(payload))
    } catch (error) {
      console.log(`SOCKET: Error sending swipe_volume_status: ${error}`)
    }
  }

  public sendSwitchStatus(switchType: number, switchValue: number, timestamp: number) {
    try {
      const payload = {
        type: "switch_status",
        switch_type: switchType,
        switch_value: switchValue,
        timestamp,
      }
      this.ws.sendText(JSON.stringify(payload))
    } catch (error) {
      console.log(`SOCKET: Error sending switch_status: ${error}`)
    }
  }

  public sendRgbLedControlResponse(requestId: string, success: boolean, errorMessage?: string | null) {
    if (!requestId) {
      console.log("SOCKET: Skipping RGB LED control response - missing requestId")
      return
    }
    try {
      const payload: any = {
        type: "rgb_led_control_response",
        requestId,
        success,
      }
      if (errorMessage) {
        payload.error = errorMessage
      }
      this.ws.sendText(JSON.stringify(payload))
    } catch (error) {
      console.log(`SOCKET: Error sending rgb_led_control_response: ${error}`)
    }
  }

  public sendHeadPosition(isUp: boolean) {
    try {
      const event = {
        type: "head_position",
        position: isUp ? "up" : "down",
        timestamp: Date.now(),
      }

      const jsonString = JSON.stringify(event)
      this.ws.sendText(jsonString)
    } catch (error) {
      console.log(`SOCKET: Error sending head position: ${error}`)
    }
  }

  public sendLocalTranscription(transcription: any) {
    if (!this.ws.isConnected()) {
      console.log("Cannot send local transcription: WebSocket not connected")
      return
    }

    const text = transcription.text
    if (!text || text === "") {
      console.log("Skipping empty transcription result")
      return
    }

    try {
      const jsonString = JSON.stringify(transcription)
      this.ws.sendText(jsonString)

      const isFinal = transcription.isFinal || false
      console.log(`SOCKET: Sent ${isFinal ? "final" : "partial"} transcription: '${text}'`)
    } catch (error) {
      console.log(`Error sending transcription result: ${error}`)
    }
  }

  // message handlers, these should only ever be called from handle_message / the server:
  private async handle_connection_ack(msg: any) {
    console.log("SOCKET: connection ack, connecting to livekit")
    const isChina = await useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)
    if (!isChina) {
      await livekit.connect()
    }
    GlobalEventEmitter.emit("APP_STATE_CHANGE", msg)
  }

  private handle_app_state_change(msg: any) {
    // console.log("SOCKET: app state change", msg)
    // this.parse_app_list(msg)
    GlobalEventEmitter.emit("APP_STATE_CHANGE", msg)
  }

  private handle_connection_error(msg: any) {
    console.error("SOCKET: connection error", msg)
  }

  private handle_auth_error() {
    console.error("SOCKET: auth error")
  }

  private handle_microphone_state_change(msg: any) {
    const bypassVad = msg.bypassVad || false
    const requiredDataStrings = msg.requiredData || []
    // console.log(`SOCKET: requiredData = ${requiredDataStrings}, bypassVad = ${bypassVad}`)
    CoreModule.microphoneStateChange(requiredDataStrings, bypassVad)
  }

  public handle_display_event(msg: any) {
    if (!msg.view) {
      console.error("SOCKET: display_event missing view")
      return
    }
    CoreModule.displayEvent(msg)
    // Update the Zustand store with the display content
    const displayEvent = JSON.stringify(msg)
    useDisplayStore.getState().setDisplayEvent(displayEvent)
  }

  private handle_set_location_tier(msg: any) {
    const tier = msg.tier
    if (!tier) {
      console.log("SOCKET: No tier provided")
      return
    }
    console.log("SOCKET: set_location_tier()", tier)
    mantle.setLocationTier(tier)
  }

  private handle_request_single_location(msg: any) {
    console.log("SOCKET: request_single_location()")
    const accuracy = msg.accuracy
    const correlationId = msg.correlationId
    if (!accuracy || !correlationId) {
      console.log("SOCKET: No accuracy or correlationId provided")
      return
    }
    console.log("SOCKET: request_single_location()", accuracy, correlationId)
    mantle.requestSingleLocation(accuracy, correlationId)
  }

  private handle_app_started(msg: any) {
    const packageName = msg.packageName
    if (!packageName) {
      console.log("SOCKET: No package name provided")
      return
    }
    console.log(`SOCKET: Received app_started message for package: ${msg.packageName}`)
    useAppletStatusStore.getState().refreshApplets()
  }
  private handle_app_stopped(msg: any) {
    console.log(`SOCKET: Received app_stopped message for package: ${msg.packageName}`)
    useAppletStatusStore.getState().refreshApplets()
  }

  private handle_photo_request(msg: any) {
    const requestId = msg.requestId ?? ""
    const appId = msg.appId ?? ""
    const webhookUrl = msg.webhookUrl ?? ""
    const size = msg.size ?? "medium"
    const authToken = msg.authToken ?? ""
    const compress = msg.compress ?? "none"
    console.log(
      `Received photo_request, requestId: ${requestId}, appId: ${appId}, webhookUrl: ${webhookUrl}, size: ${size} authToken: ${authToken} compress: ${compress}`,
    )
    if (!requestId || !appId) {
      console.log("Invalid photo request: missing requestId or appId")
      return
    }
    // Parameter order: requestId, appId, size, webhookUrl, authToken, compress
    CoreModule.photoRequest(requestId, appId, size, webhookUrl, authToken, compress)
  }

  private handle_start_rtmp_stream(msg: any) {
    const rtmpUrl = msg.rtmpUrl || ""
    if (rtmpUrl) {
      CoreModule.startRtmpStream(msg)
    } else {
      console.log("Invalid RTMP stream request: missing rtmpUrl")
    }
  }

  private handle_stop_rtmp_stream() {
    CoreModule.stopRtmpStream()
  }

  private handle_keep_rtmp_stream_alive(msg: any) {
    console.log(`SOCKET: Received KEEP_RTMP_STREAM_ALIVE: ${JSON.stringify(msg)}`)
    CoreModule.keepRtmpStreamAlive(msg)
  }

  private handle_save_buffer_video(msg: any) {
    console.log(`SOCKET: Received SAVE_BUFFER_VIDEO: ${JSON.stringify(msg)}`)
    const bufferRequestId = msg.requestId || `buffer_${Date.now()}`
    const durationSeconds = msg.durationSeconds || 30
    CoreModule.saveBufferVideo(bufferRequestId, durationSeconds)
  }

  private handle_start_buffer_recording() {
    console.log("SOCKET: Received START_BUFFER_RECORDING")
    CoreModule.startBufferRecording()
  }

  private handle_stop_buffer_recording() {
    console.log("SOCKET: Received STOP_BUFFER_RECORDING")
    CoreModule.stopBufferRecording()
  }

  private handle_start_video_recording(msg: any) {
    console.log(`SOCKET: Received START_VIDEO_RECORDING: ${JSON.stringify(msg)}`)
    const videoRequestId = msg.requestId || `video_${Date.now()}`
    const save = msg.save !== false
    CoreModule.startVideoRecording(videoRequestId, save)
  }

  private handle_stop_video_recording(msg: any) {
    console.log(`SOCKET: Received STOP_VIDEO_RECORDING: ${JSON.stringify(msg)}`)
    const stopRequestId = msg.requestId || ""
    CoreModule.stopVideoRecording(stopRequestId)
  }

  private handle_rgb_led_control(msg: any) {
    if (!msg || !msg.requestId) {
      console.log("SOCKET: rgb_led_control missing requestId, ignoring")
      return
    }

    const coerceNumber = (value: any, fallback: number) => {
      const coerced = Number(value)
      return Number.isFinite(coerced) ? coerced : fallback
    }

    CoreModule.rgbLedControl(
      msg.requestId,
      msg.packageName ?? null,
      msg.action ?? "off",
      msg.color ?? null,
      coerceNumber(msg.ontime, 1000),
      coerceNumber(msg.offtime, 0),
      coerceNumber(msg.count, 1),
    )
  }

  private handle_show_wifi_setup(msg: any) {
    const reason = msg.reason || "This operation requires your glasses to be connected to WiFi."
    const currentRoute = router.pathname || "/"

    showAlert(
      "WiFi Setup Required",
      reason,
      [
        {text: "Cancel", style: "cancel"},
        {
          text: "Setup WiFi",
          onPress: () => {
            const returnTo = encodeURIComponent(currentRoute)
            push(`/pairing/glasseswifisetup?returnTo=${returnTo}`)
          },
        },
      ],
      {
        iconName: "wifi-off",
        iconColor: "#FF9500",
      },
    )
  }

  // Message Handling
  private handle_message(msg: any) {
    const type = msg.type

    console.log(`SOCKET: msg: ${type}`)

    switch (type) {
      case "connection_ack":
        this.handle_connection_ack(msg)
        break

      case "app_state_change":
        this.handle_app_state_change(msg)
        break

      case "connection_error":
        this.handle_connection_error(msg)
        break

      case "auth_error":
        this.handle_auth_error()
        break

      case "microphone_state_change":
        this.handle_microphone_state_change(msg)
        break

      case "display_event":
        this.handle_display_event(msg)
        break

      case "set_location_tier":
        this.handle_set_location_tier(msg)
        break

      case "request_single_location":
        this.handle_request_single_location(msg)
        break

      case "app_started":
        this.handle_app_started(msg)
        break

      case "app_stopped":
        this.handle_app_stopped(msg)
        break

      case "photo_request":
        this.handle_photo_request(msg)
        break

      case "start_rtmp_stream":
        this.handle_start_rtmp_stream(msg)
        break

      case "stop_rtmp_stream":
        this.handle_stop_rtmp_stream()
        break

      case "keep_rtmp_stream_alive":
        this.handle_keep_rtmp_stream_alive(msg)
        break

      case "start_buffer_recording":
        this.handle_start_buffer_recording()
        break

      case "stop_buffer_recording":
        this.handle_stop_buffer_recording()
        break

      case "save_buffer_video":
        this.handle_save_buffer_video(msg)
        break

      case "start_video_recording":
        this.handle_start_video_recording(msg)
        break

      case "stop_video_recording":
        this.handle_stop_video_recording(msg)
        break

      case "rgb_led_control":
        this.handle_rgb_led_control(msg)
        break

      case "show_wifi_setup":
        this.handle_show_wifi_setup(msg)
        break

      default:
        console.log(`SOCKET: Unknown message type: ${type} / full: ${JSON.stringify(msg)}`)
    }
  }
}

const socketComms = SocketComms.getInstance()
export default socketComms
