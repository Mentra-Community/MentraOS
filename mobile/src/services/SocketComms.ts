import {type RgbLedControlResponseEvent, type TouchEvent} from "@mentra/bluetooth-sdk"
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {
  displayProcessor,
  localMiniappRuntime,
  localSttFallbackCoordinator,
  micStateCoordinator,
  throttle,
} from "@mentra/island"

import audioPlaybackService from "@/services/AudioPlaybackService"
import mantle from "@/services/MantleManager"
import restComms from "@/services/RestComms"
import {
  normalizePhotoCompression,
  normalizePhotoSize,
  normalizeRgbLedAction,
  normalizeRgbLedColor,
} from "@/services/SocketComms.normalizers"
import udp from "@/services/UdpManager"
import ws from "@/services/WebSocketManager"
import miniappCatalog from "@/services/miniapps/MiniappCatalog"
import {useDisplayStore} from "@/stores/display"
import {isGlassesConnected, useGlassesStore} from "@/stores/glasses"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {showAlert} from "@/utils/AlertUtils"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"

class SocketComms {
  private static instance: SocketComms | null = null
  private coreToken: string = ""
  public userid: string = ""

  private constructor() {}

  private setupListeners() {
    ws.removeAllListeners("message")
    ws.on("message", (message) => {
      this.handle_message(message)
    })
  }

  public static getInstance(): SocketComms {
    if (!SocketComms.instance) {
      SocketComms.instance = new SocketComms()
    }

    return SocketComms.instance
  }

  public async cleanup() {
    console.log("SOCKET: cleanup()")
    udp.cleanup()
    await ws.cleanup()
  }

  // Connection Management

  public async connectWebsocket() {
    console.log("SOCKET: connectWebsocket()")
    this.setupListeners()
    const url = useSettingsStore.getState().getWsUrl()
    if (!url) {
      console.error(`SOCKET: Invalid server URL`)
      return
    }
    await ws.connect(url, this.coreToken)
  }

  public isWebSocketConnected(): boolean {
    return ws.isConnected()
  }

  public async restartConnection() {
    console.log(`SOCKET: restartConnection()`)
    if (ws.isConnected()) {
      await ws.disconnect()
      await this.connectWebsocket()
    } else {
      await this.connectWebsocket()
    }
  }

  public setAuthCreds(coreToken: string, userid: string) {
    console.log(`SOCKET: setAuthCreds(): ${coreToken.substring(0, 10)}..., ${userid}`)
    this.coreToken = coreToken
    this.userid = userid
    useSettingsStore.getState().setSetting(SETTINGS.core_token.key, coreToken)
    // this.connectWebsocket()
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

  public sendStreamStatus(statusMessage: any) {
    // Forward the status message directly since it's already in the correct format
    ws.sendText(JSON.stringify(statusMessage))
    console.log("SOCKET: Sent RTMP stream status:", statusMessage)
  }

  public sendKeepAliveAck(ackMessage: any) {
    // Forward the ACK message directly since it's already in the correct format
    ws.sendText(JSON.stringify(ackMessage))
    console.log("SOCKET: Sent keep-alive ACK:", ackMessage)
  }

  public sendGlassesConnectionState(): void {
    let deviceModel = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    const glassesInfo = useGlassesStore.getState()

    // Always include WiFi info - null means "unknown", false means "explicitly disconnected"
    const wifi = glassesInfo.wifi
    const wifiInfo = {
      connected: glassesInfo.wifiStatusKnown ? wifi.state === "connected" : null,
      ssid: wifi.state === "connected" ? wifi.ssid : null,
    }

    const connected = isGlassesConnected(glassesInfo.connection)

    ws.sendText(
      JSON.stringify({
        type: "glasses_connection_state",
        modelName: deviceModel, // TODO: remove this
        deviceModel: deviceModel,
        status: connected ? "CONNECTED" : "DISCONNECTED",
        timestamp: new Date(),
        wifi: wifiInfo,
      }),
    )
  }

  public sendBatteryStatus(level?: number, charging?: boolean, timestamp: number = Date.now()): void {
    const batteryLevel = level ?? useGlassesStore.getState().batteryLevel
    const isCharging = charging ?? useGlassesStore.getState().charging
    const msg = {
      type: "glasses_battery_update",
      level: batteryLevel,
      charging: isCharging,
      timestamp,
    }
    ws.sendText(JSON.stringify(msg))
  }

  public sendText(text: string) {
    ws.sendText(text)
  }

  public sendBinary(data: ArrayBuffer | Uint8Array) {
    ws.sendBinary(data)
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
  }

  // Hardware Events
  public sendButtonPress(buttonId: string, pressType: string) {
    const event = {
      type: "button_press",
      buttonId: buttonId,
      pressType: pressType,
      timestamp: Date.now(),
    }

    const jsonString = JSON.stringify(event)
    ws.sendText(jsonString)
  }

  public sendVideoStreamResponse(appId: string, streamUrl: string) {
    const event = {
      type: "video_stream_response",
      appId: appId,
      streamUrl: streamUrl,
      timestamp: Date.now(),
    }

    const jsonString = JSON.stringify(event)
    ws.sendText(jsonString)
  }

  public sendTouchEvent(event: TouchEvent) {
    const payload = {
      type: "touch_event",
      device_model: event.deviceModel,
      gesture_name: event.gestureName,
      timestamp: event.timestamp,
    }
    ws.sendText(JSON.stringify(payload))
  }

  public sendSwipeVolumeStatus(enabled: boolean, timestamp: number) {
    const payload = {
      type: "swipe_volume_status",
      enabled,
      timestamp,
    }
    ws.sendText(JSON.stringify(payload))
  }

  /** Send an arbitrary message over the phone↔cloud WebSocket. */
  public sendMessage(msg: object) {
    ws.sendText(JSON.stringify(msg))
  }

  public updatePhoneSubscriptions(subscriptions: string[]) {
    const msg = {
      type: "phone_subscription_update",
      subscriptions,
      timestamp: new Date().toISOString(),
    }
    ws.sendText(JSON.stringify(msg))
  }

  public sendSwitchStatus(switchType: number, switchValue: number, timestamp: number) {
    const payload = {
      type: "switch_status",
      switch_type: switchType,
      switch_value: switchValue,
      timestamp,
    }
    ws.sendText(JSON.stringify(payload))
  }

  public sendRgbLedControlResponse(event: RgbLedControlResponseEvent) {
    if (!event.requestId) {
      console.log("SOCKET: Skipping RGB LED control response - missing requestId")
      return
    }
    const payload: {type: string; requestId: string; success: boolean; error?: string} = {
      type: "rgb_led_control_response",
      requestId: event.requestId,
      success: event.state === "success",
    }
    if (event.state === "error") {
      payload.error = event.errorCode
    }
    ws.sendText(JSON.stringify(payload))
  }

  public sendHeadPosition(isUp: boolean) {
    const event = {
      type: "head_position",
      position: isUp ? "up" : "down",
      timestamp: Date.now(),
    }

    const jsonString = JSON.stringify(event)
    ws.sendText(jsonString)
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

    const jsonString = JSON.stringify(transcription)
    ws.sendText(jsonString)

    const isFinal = transcription.isFinal || false
    console.log(`SOCKET: Sent ${isFinal ? "final" : "partial"} transcription: '${text}'`)
  }

  public sendUdpRegister(userIdHash: number) {
    const msg = {
      type: "udp_register",
      userIdHash: userIdHash,
    }
    ws.sendText(JSON.stringify(msg))
  }

  // MARK: - UDP Audio Methods

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
    this.configureAudioFormat().catch((err) => {
      console.log("SOCKET: Audio format configuration failed (cloud will expect PCM):", err)
    })

    // Try to register for UDP audio (non-blocking)
    // UDP endpoint is provided by server in connection_ack message
    const udpHost = msg.udpHost || msg.udp_host
    const udpPort = msg.udpPort || msg.udp_port || 8000

    // console.log("SOCKET: connection_ack UDP fields:", {
    //   udpHost: msg.udpHost,
    //   udp_host: msg.udp_host,
    //   udpPort: msg.udpPort,
    //   udp_port: msg.udp_port,
    //   resolvedHost: udpHost,
    //   resolvedPort: udpPort,
    //   hasEncryption: !!msg.udpEncryption,
    //   allKeys: Object.keys(msg),
    // })

    if (udpHost) {
      // console.log(`SOCKET: UDP endpoint found, configuring with ${udpHost}:${udpPort}`)
      udp.configure(udpHost, udpPort, this.userid)

      // Configure encryption if server provided a key
      if (msg.udpEncryption?.key) {
        const encryptionConfigured = udp.setEncryption(msg.udpEncryption.key)
        console.log(
          `SOCKET: UDP encryption ${encryptionConfigured ? "enabled" : "failed"} (algorithm: ${
            msg.udpEncryption.algorithm
          })`,
        )
      } else {
        udp.clearEncryption()
        console.log("SOCKET: UDP encryption not enabled (no key in connection_ack)")
      }

      udp.handleAck()
    } else {
      console.log(
        "SOCKET: No UDP endpoint in connection_ack, skipping UDP audio. Full message:",
        JSON.stringify(msg, null, 2),
      )
    }
  }

  /**
   * Configure audio format with the cloud server.
   * Tells the server we're sending LC3-encoded audio.
   * Uses canonical LC3 config: 16kHz, 10ms frame duration.
   * Frame size is configurable: 20 bytes (16kbps), 40 bytes (32kbps), 60 bytes (48kbps).
   */
  public async configureAudioFormat(): Promise<void> {
    const backendUrl = useSettingsStore.getState().getSetting(SETTINGS.backend_url.key)
    const coreToken = useSettingsStore.getState().getSetting(SETTINGS.core_token.key)
    const frameSizeBytes = useSettingsStore.getState().getSetting(SETTINGS.lc3_frame_size.key)
    const bypassEncoding = useSettingsStore.getState().getSetting(SETTINGS.bypass_audio_encoding_for_debugging.key)

    if (!backendUrl || !coreToken) {
      console.log("SOCKET: Cannot configure audio format - missing backend URL or token")
      return
    }

    // Determine format based on bypass setting
    const audioFormat = bypassEncoding ? "pcm" : "lc3"
    console.log(`SOCKET: Configuring audio format: ${audioFormat} (bypass=${bypassEncoding})`)

    let lc3Config: any = null
    if (!bypassEncoding) {
      lc3Config = {
        sampleRate: 16000,
        frameDurationMs: 10,
        frameSizeBytes: frameSizeBytes,
      }
    }

    let res = await restComms.configureAudioFormat(audioFormat, lc3Config)
    if (res.is_error()) {
      console.error("SOCKET: Failed to configure audio format:", res.error)
      return
    }

    // console.log(
    //   `SOCKET: Audio format configured successfully: ${audioFormat}${
    //     bypassEncoding ? " (raw PCM)" : `, ${frameSizeBytes} bytes/frame`
    //   }`,
    // )
  }

  private refreshAppletsThrottled = throttle(() => {
    void miniappCatalog.refresh()
  }, 500)

  private handle_app_state_change(msg: any) {
    console.log("SOCKET: app_state_change", msg)
    // throttle so we don't call more than once in 500ms
    this.refreshAppletsThrottled()
  }

  private handle_connection_error(msg: any) {
    console.error("SOCKET: connection error", msg)
  }

  private handle_auth_error() {
    console.error("SOCKET: auth error")
  }

  private async handle_microphone_state_change(msg: any) {
    const requiredDataStrings = msg.requiredData || []
    const voiceActivityDetectionEnabled = typeof msg.bypassVad === "boolean" ? !msg.bypassVad : undefined
    console.log(
      `SOCKET: mic_state_change: requiredData = [${requiredDataStrings}], voiceActivityDetectionEnabled = ${voiceActivityDetectionEnabled}`,
    )
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

    // check permission if we're turning the mic ON.
    // Turning it off is always allowed and should go through regardless.
    // This prevents setting systemMicUnavailable=true before permissions are granted,
    // which would cause the mic to never start even after permissions are granted.
    if (shouldSendPcmData || shouldSendTranscript) {
      const hasMicPermission = await checkFeaturePermissions(PermissionFeatures.MICROPHONE)
      if (!hasMicPermission) {
        console.log("SOCKET: mic_state_change ignored - microphone permission not granted yet")
        return
      }
    }

    micStateCoordinator.setCloudRequirements({
      pcm: !!shouldSendPcmData,
      lc3: !!shouldSendPcmData, // online apps always want lc3
      transcript: !!shouldSendTranscript,
      ...(voiceActivityDetectionEnabled === undefined ? {} : {voiceActivityDetectionEnabled}),
    })
  }

  public handle_display_event(msg: any) {
    if (!msg.view) {
      console.error("SOCKET: display_event missing view")
      return
    }

    let processedEvent
    try {
      processedEvent = displayProcessor.processDisplayEvent(msg)
    } catch (err) {
      console.error("SOCKET: DisplayProcessor error, using raw event:", err)
      processedEvent = msg
    }

    BluetoothSdk.displayEvent(processedEvent)
    const displayEventStr = JSON.stringify(processedEvent)
    useDisplayStore.getState().setDisplayEvent(displayEventStr)
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
    void miniappCatalog.refresh()
  }
  private handle_app_stopped(msg: any) {
    console.log(`SOCKET: Received app_stopped message for package: ${msg.packageName}`)
    void miniappCatalog.refresh()
  }

  private handle_photo_request(msg: any) {
    const requestId = msg.requestId ?? ""
    const appId = msg.appId ?? ""
    const webhookUrl = msg.webhookUrl ?? ""
    const size = normalizePhotoSize(msg.size)
    const authToken = typeof msg.authToken === "string" && msg.authToken.length > 0 ? msg.authToken : null
    const compress = normalizePhotoCompression(msg.compress)
    const sound = msg.sound ?? true
    const rawExp = msg.exposureTimeNs
    const exposureTimeNs = typeof rawExp === "number" && Number.isFinite(rawExp) && rawExp > 0 ? rawExp : null
    console.log(
      `SOCKET: PHOTO PIPELINE [1/6] Received photo_request requestId=${requestId} appId=${appId} webhookUrl=${webhookUrl} size=${size} compress=${compress} sound=${sound} exposureTimeNs=${exposureTimeNs ?? "none"} authToken=${authToken ? "set" : "none"}`,
    )
    if (!requestId || !appId) {
      console.log(
        `SOCKET: PHOTO PIPELINE — invalid photo_request (missing requestId=${requestId || "empty"} or appId=${appId || "empty"})`,
      )
      return
    }
    console.log(`SOCKET: PHOTO PIPELINE [2/6] Forwarding to BluetoothSdk.requestPhoto requestId=${requestId}`)
    void BluetoothSdk.requestPhoto({
      requestId,
      appId,
      size,
      webhookUrl,
      authToken,
      compress,
      sound,
      exposureTimeNs,
    })
      .then(() => {
        console.log(`SOCKET: PHOTO PIPELINE [3/6] BluetoothSdk.requestPhoto resolved requestId=${requestId}`)
      })
      .catch((err: unknown) => {
        console.log(
          `SOCKET: PHOTO PIPELINE — BluetoothSdk.requestPhoto failed requestId=${requestId}:`,
          err instanceof Error ? err.message : err,
        )
      })
  }

  private handle_start_stream(msg: any) {
    const streamUrl = msg.streamUrl
    if (streamUrl) {
      BluetoothSdk.startStream(msg)
    } else {
      console.log("Invalid stream request: missing stream URL")
    }
  }

  private handle_stop_stream() {
    BluetoothSdk.stopStream()
  }

  private handle_keep_stream_alive(msg: any) {
    console.log(`SOCKET: Received KEEP_STREAM_ALIVE: ${JSON.stringify(msg)}`)
    BluetoothSdk.keepStreamAlive(msg)
  }

  private handle_start_video_recording(msg: any) {
    console.log(`SOCKET: Received START_VIDEO_RECORDING: ${JSON.stringify(msg)}`)
    const videoRequestId = msg.requestId || `video_${Date.now()}`
    const save = msg.save !== false
    const sound = msg.sound ?? true
    BluetoothSdk.startVideoRecording(videoRequestId, save, sound)
  }

  private handle_stop_video_recording(msg: any) {
    console.log(`SOCKET: Received STOP_VIDEO_RECORDING: ${JSON.stringify(msg)}`)
    const stopRequestId = msg.requestId || ""
    BluetoothSdk.stopVideoRecording(stopRequestId)
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

    BluetoothSdk.rgbLedControl(
      msg.requestId,
      msg.packageName ?? null,
      normalizeRgbLedAction(msg.action),
      normalizeRgbLedColor(msg.color),
      coerceNumber(msg.ontime, 1000),
      coerceNumber(msg.offtime, 0),
      coerceNumber(msg.count, 1),
    )
  }

  private handle_camera_fov_set(msg: any) {
    const ROI_MAP: Record<string, number> = {center: 0, bottom: 1, top: 2}
    const fov = typeof msg.fov === "number" ? Math.min(118, Math.max(82, msg.fov)) : 118
    const roiStr: string = msg.roiPosition ?? "center"
    const numericRoi = ROI_MAP[roiStr] ?? 0
    console.log(`SOCKET: camera_fov_set fov=${fov} roi=${roiStr} (${numericRoi})`)
    useSettingsStore.getState().setSetting(SETTINGS.camera_fov.key, {fov, roi_position: numericRoi}, false)
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
            const nav = useNavigationStore.getState()
            nav.push("/wifi/scan")
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

    // console.log(`SOCKET: msg: ${type}`)

    switch (type) {
      case "ping":
        // do nothing
        break

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

      case "start_stream":
        this.handle_start_stream(msg)
        break

      case "stop_stream":
        this.handle_stop_stream()
        break

      case "keep_stream_alive":
        this.handle_keep_stream_alive(msg)
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

      case "camera_fov_set":
        this.handle_camera_fov_set(msg)
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

      case "data_stream": {
        const streamType = msg.streamType
        if (typeof streamType === "string" && streamType.startsWith("transcription:")) {
          localSttFallbackCoordinator.onCloudTranscript()
        }
        localMiniappRuntime.forwardEvent(streamType, msg.data)
        break
      }

      case "phone_photo_ready":
      case "phone_stream_status":
      case "phone_managed_stream_status":
        // Forward Phase 5 messages to LocalMiniappRuntime
        localMiniappRuntime.handleCloudMessage(msg)
        break

      default:
        console.log(`SOCKET: Unknown message type: ${type} / full: ${JSON.stringify(msg)}`)
    }
  }
}

const socketComms = SocketComms.getInstance()
export default socketComms
