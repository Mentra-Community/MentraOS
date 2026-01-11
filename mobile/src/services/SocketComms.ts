import CoreModule from "core"

import {push} from "@/contexts/NavigationRef"
import audioPlaybackService from "@/services/AudioPlaybackService"
import mantle from "@/services/MantleManager"
import udp from "@/services/UdpManager"
import ws from "@/services/WebSocketManager"
import {useAppletStatusStore} from "@/stores/applets"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore} from "@/stores/glasses"
import {useSettingsStore, SETTINGS} from "@/stores/settings"
import {showAlert} from "@/utils/AlertUtils"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import restComms from "@/services/RestComms"

class SocketComms {
  private static instance: SocketComms | null = null
  private coreToken: string = ""
  public userid: string = ""
  
  private constructor() {
  }

  private setupListeners() {
    ws.removeAllListeners("message")
    ws.on("message", message => {
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
    console.log("SOCKET: cleanup()")
    udp.stop()
    udp.cleanup()
    ws.cleanup()
  }

  // Connection Management

  private async connectWebsocket() {
    console.log("SOCKET: connectWebsocket()")
    this.setupListeners()
    const url = useSettingsStore.getState().getWsUrl()
    if (!url) {
      console.error(`SOCKET: Invalid server URL`)
      return
    }
    ws.connect(url, this.coreToken)
  }

  public isWebSocketConnected(): boolean {
    return ws.isConnected()
  }

  public restartConnection() {
    console.log(`SOCKET: restartConnection()`)
    if (ws.isConnected()) {
      ws.disconnect()
      this.connectWebsocket()
    } else {
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
    ws.sendText(JSON.stringify(msg))
  }

  public sendRtmpStreamStatus(statusMessage: any) {
    try {
      // Forward the status message directly since it's already in the correct format
      ws.sendText(JSON.stringify(statusMessage))
      console.log("SOCKET: Sent RTMP stream status:", statusMessage)
    } catch (error) {
      console.log(`SOCKET: Failed to send RTMP stream status: ${error}`)
    }
  }

  public sendKeepAliveAck(ackMessage: any) {
    try {
      // Forward the ACK message directly since it's already in the correct format
      ws.sendText(JSON.stringify(ackMessage))
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

    ws.sendText(
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
    ws.sendText(JSON.stringify(msg))
  }

  public sendText(text: string) {
    try {
      ws.sendText(text)
    } catch (error) {
      console.log(`SOCKET: Failed to send text: ${error}`)
    }
  }

  public sendBinary(data: ArrayBuffer | Uint8Array) {
    try {
      ws.sendBinary(data)
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
    ws.sendText(jsonString)
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
      ws.sendText(jsonString)
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
      ws.sendText(jsonString)
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
      ws.sendText(jsonString)
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
      ws.sendText(jsonString)
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
      ws.sendText(JSON.stringify(payload))
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
      ws.sendText(JSON.stringify(payload))
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
      ws.sendText(JSON.stringify(payload))
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
      ws.sendText(JSON.stringify(payload))
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
      ws.sendText(jsonString)
    } catch (error) {
      console.log(`SOCKET: Error sending head position: ${error}`)
    }
  }

  public sendLocalTranscription(transcription: any) {
    if (!ws.isConnected()) {
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
      ws.sendText(jsonString)

      const isFinal = transcription.isFinal || false
      console.log(`SOCKET: Sent ${isFinal ? "final" : "partial"} transcription: '${text}'`)
    } catch (error) {
      console.log(`Error sending transcription result: ${error}`)
    }
  }

  // MARK: - UDP Audio Methods


  /**
   * Check if UDP audio is currently enabled.
   */
  public udpEnabledAndReady(): boolean {
    return udp.enabledAndReady()
  }

  // message handlers, these should only ever be called from handle_message / the server:
  private async handle_connection_ack(msg: any) {
    // LiveKit connection disabled - using WebSocket/UDP audio instead
    // const isChina = await useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)
    // if (!isChina) {
    //   await livekit.connect()
    // }

    // refresh the mini app list:
    restComms.getApplets()

    // Configure audio format (LC3) for bandwidth savings
    // This tells the cloud that we're sending LC3-encoded audio
    this.configureAudioFormat().catch(err => {
      console.log("SOCKET: Audio format configuration failed (cloud will expect PCM):", err)
    })

    // Try to register for UDP audio (non-blocking)
    // UDP endpoint is provided by server in connection_ack message
    const udpHost = msg.udpHost || msg.udp_host
    const udpPort = msg.udpPort || msg.udp_port || 8000

    console.log("SOCKET: connection_ack UDP fields:", {
      udpHost: msg.udpHost,
      udp_host: msg.udp_host,
      udpPort: msg.udpPort,
      udp_port: msg.udp_port,
      resolvedHost: udpHost,
      resolvedPort: udpPort,
      allKeys: Object.keys(msg),
    })

    if (udpHost) {
      console.log(`SOCKET: UDP endpoint found, configuring with ${udpHost}:${udpPort}`)
      udp.configure(udpHost, udpPort, this.userid)
      udp.handleAck()
    } else {
      console.log("SOCKET: No UDP endpoint in connection_ack, skipping UDP audio. Full message:", JSON.stringify(msg, null, 2))
    }

    GlobalEventEmitter.emit("APP_STATE_CHANGE", msg)
  }

  /**
   * Public method to reconfigure audio format.
   * Called when user changes LC3 bitrate setting to apply immediately.
   */
  async reconfigureAudioFormat(): Promise<void> {
    return this.configureAudioFormat()
  }

  /**
   * Configure audio format with the cloud server.
   * Tells the server we're sending LC3-encoded audio.
   * Uses canonical LC3 config: 16kHz, 10ms frame duration.
   * Frame size is configurable: 20 bytes (16kbps), 40 bytes (32kbps), 60 bytes (48kbps).
   */
  private async configureAudioFormat(): Promise<void> {
    const backendUrl = useSettingsStore.getState().getSetting(SETTINGS.backend_url.key)
    const coreToken = useSettingsStore.getState().getSetting(SETTINGS.core_token.key)
    const frameSizeBytes = useSettingsStore.getState().getSetting(SETTINGS.lc3_frame_size.key) || 20

    if (!backendUrl || !coreToken) {
      console.log("SOCKET: Cannot configure audio format - missing backend URL or token")
      return
    }

    // Configure the native encoder frame size first
    try {
      await CoreModule.setLC3FrameSize(frameSizeBytes)
      console.log(`SOCKET: Native LC3 encoder configured to ${frameSizeBytes} bytes/frame`)
    } catch (err) {
      console.error("SOCKET: Failed to configure native LC3 encoder:", err)
      // Continue anyway - cloud config is more important
    }

    try {
      const response = await fetch(`${backendUrl}/api/client/audio/configure`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${coreToken}`,
        },
        body: JSON.stringify({
          format: "lc3",
          lc3Config: {
            sampleRate: 16000,
            frameDurationMs: 10,
            frameSizeBytes: frameSizeBytes,
          },
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        console.error("SOCKET: Failed to configure audio format:", response.status, text)
        return
      }

      const result = await response.json()
      console.log(`SOCKET: Audio format configured successfully: ${result.format}, ${frameSizeBytes} bytes/frame`)
    } catch (error) {
      console.error("SOCKET: Error configuring audio format:", error)
      throw error
    }
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
    // const bypassVad = msg.bypassVad ?? true
    const bypassVad = true
    const requiredDataStrings = msg.requiredData || []
    console.log(`SOCKET: requiredData = ${requiredDataStrings}, bypassVad = ${bypassVad}`)
    let shouldSendPcmData = false
    let shouldSendTranscript = false
    if (requiredDataStrings.includes("pcm")) {
      shouldSendPcmData = true
    }
    if (requiredDataStrings.includes("transcription")) {
      shouldSendTranscript = true
    }
    if (requiredDataStrings.includes("pcm_or_transcription")) {
      shouldSendPcmData = true
      shouldSendTranscript = true
    }
    CoreModule.setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
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
    const silent = msg.silent ?? true
    console.log(
      `Received photo_request, requestId: ${requestId}, appId: ${appId}, webhookUrl: ${webhookUrl}, size: ${size} authToken: ${authToken} compress: ${compress} silent: ${silent}`,
    )
    if (!requestId || !appId) {
      console.log("Invalid photo request: missing requestId or appId")
      return
    }
    // Parameter order: requestId, appId, size, webhookUrl, authToken, compress, silent
    CoreModule.photoRequest(requestId, appId, size, webhookUrl, authToken, compress, silent)
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
    const silent = msg.silent ?? false
    CoreModule.startVideoRecording(videoRequestId, save, silent)
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

    showAlert(
      "WiFi Setup Required",
      reason,
      [
        {text: "Cancel", style: "cancel"},
        {
          text: "Setup WiFi",
          onPress: () => {
            push("/wifi/scan")
          },
        },
      ],
      {
        iconName: "wifi-off",
        iconColor: "#FF9500",
      },
    )
  }

  /**
   * Handle UDP ping acknowledgement from server.
   * This is sent via WebSocket when the Go bridge receives our UDP ping.
   */
  private handle_udp_ping_ack(_msg: any) {
    // console.log("UDP: Received ping ack from server")

    // Notify the React Native UDP service that ping was acknowledged
    udp.onPingAckReceived()
  }

  /**
   * Handle audio play request from cloud.
   * Downloads and plays audio from the provided URL using expo-av.
   */
  private handle_audio_play_request(msg: any) {
    const requestId = msg.requestId
    const audioUrl = msg.audioUrl
    const appId = msg.appId || msg.packageName // Optional - may be undefined
    const volume = msg.volume ?? 1.0
    const stopOtherAudio = msg.stopOtherAudio ?? true

    if (!requestId || !audioUrl) {
      console.log("SOCKET: Invalid audio_play_request - missing requestId or audioUrl")
      if (requestId) {
        this.sendAudioPlayResponse(requestId, false, "Missing audioUrl", null)
      }
      return
    }

    console.log(`SOCKET: Received audio_play_request: ${requestId}${appId ? ` from ${appId}` : ""}, url: ${audioUrl}`)

    // Play audio and send response when complete
    audioPlaybackService.play(
      {requestId, audioUrl, appId, volume, stopOtherAudio},
      (respRequestId, success, error, duration) => {
        this.sendAudioPlayResponse(respRequestId, success, error, duration)
      },
    )
  }

  /**
   * Handle audio stop request from cloud.
   * Stops audio playback for the specified app.
   */
  private handle_audio_stop_request(msg: any) {
    const appId = msg.appId || msg.packageName // Optional - may be undefined
    console.log(`SOCKET: Received audio_stop_request${appId ? ` for app: ${appId}` : ""}`)
    audioPlaybackService.stopForApp(appId)
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

      case "audio_play_request":
        this.handle_audio_play_request(msg)
        break

      case "audio_stop_request":
        this.handle_audio_stop_request(msg)
        break

      case "udp_ping_ack":
        this.handle_udp_ping_ack(msg)
        break

      default:
        console.log(`SOCKET: Unknown message type: ${type} / full: ${JSON.stringify(msg)}`)
    }
  }
}

const socketComms = SocketComms.getInstance()
export default socketComms
