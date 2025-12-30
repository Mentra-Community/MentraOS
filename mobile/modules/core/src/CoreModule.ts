import {NativeModule, requireNativeModule} from "expo"

import {CoreModuleEvents} from "./Core.types"

declare class CoreModule extends NativeModule<CoreModuleEvents> {
  // status:
  isConnected(): Promise<boolean>
  // Display Commands
  displayEvent(params: Record<string, any>): Promise<void>
  displayText(params: Record<string, any>): Promise<void>

  // Connection Commands
  requestStatus(): Promise<void>
  connectDefault(): Promise<void>
  connectByName(deviceName: string): Promise<void>
  connectSimulated(): Promise<void>
  disconnect(): Promise<void>
  forget(): Promise<void>
  findCompatibleDevices(modelName: string): Promise<void>
  showDashboard(): Promise<void>

  // WiFi Commands
  requestWifiScan(): Promise<void>
  sendWifiCredentials(ssid: string, password: string): Promise<void>
  setHotspotState(enabled: boolean): Promise<void>

  // Gallery Commands
  queryGalleryStatus(): Promise<void>
  photoRequest(
    requestId: string,
    appId: string,
    size: string,
    webhookUrl: string | null,
    authToken: string | null,
    compress: string,
  ): Promise<void>

  // Video Recording Commands
  startBufferRecording(): Promise<void>
  stopBufferRecording(): Promise<void>
  saveBufferVideo(requestId: string, durationSeconds: number): Promise<void>
  startVideoRecording(requestId: string, save: boolean): Promise<void>
  stopVideoRecording(requestId: string): Promise<void>

  // RTMP Stream Commands
  startRtmpStream(params: Record<string, any>): Promise<void>
  stopRtmpStream(): Promise<void>
  keepRtmpStreamAlive(params: Record<string, any>): Promise<void>

  // Microphone Commands
  setMicState(sendPcmData: boolean, sendTranscript: boolean, bypassVad: boolean): Promise<void>
  restartTranscriber(): Promise<void>

  // RGB LED Control
  rgbLedControl(
    requestId: string,
    packageName: string | null,
    action: string,
    color: string | null,
    ontime: number,
    offtime: number,
    count: number,
  ): Promise<void>

  // Settings Commands
  updateSettings(params: Record<string, any>): Promise<void>

  // STT Commands
  setSttModelDetails(path: string, languageCode: string): Promise<void>
  getSttModelPath(): Promise<string>
  checkSttModelAvailable(): Promise<boolean>
  validateSttModel(path: string): Promise<boolean>
  extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>

  // Android-specific commands
  getInstalledApps(): Promise<any>
  hasNotificationListenerPermission(): Promise<boolean>

  // Notification management
  getInstalledAppsForNotifications(): Promise<
    Array<{
      packageName: string
      appName: string
      isBlocked: boolean
      icon: string | null
    }>
  >

  // Media Library Commands
  saveToGalleryWithDate(
    filePath: string,
    captureTimeMillis?: number,
  ): Promise<{
    success: boolean
    uri?: string
    identifier?: string
    error?: string
  }>
}

// This call loads the native module object from the JSI.
export default requireNativeModule<CoreModule>("Core")
