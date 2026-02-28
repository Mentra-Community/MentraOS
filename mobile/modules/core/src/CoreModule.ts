import {NativeModule, requireNativeModule} from "expo"

import {CoreModuleEvents, GlassesStatus, CoreStatus} from "./Core.types"

type GlassesListener = (changed: Partial<GlassesStatus>) => void
type CoreListener = (changed: Partial<CoreStatus>) => void

declare class CoreModule extends NativeModule<CoreModuleEvents> {
  // Observable Store Functions (native)
  getGlassesStatus(): GlassesStatus
  getCoreStatus(): CoreStatus
  update(category: string, values: Record<string, any>): Promise<void>

  // Display Commands
  displayEvent(params: Record<string, any>): Promise<void>
  displayText(params: Record<string, any>): Promise<void>
  clearDisplay(): Promise<void>

  // Connection Commands
  requestStatus(): Promise<void>
  connectDefault(): Promise<void>
  connectByName(deviceName: string): Promise<void>
  connectSimulated(): Promise<void>
  disconnect(): Promise<void>
  forget(): Promise<void>
  findCompatibleDevices(deviceModel: string): Promise<void>
  showDashboard(): Promise<void>

  // WiFi Commands
  requestWifiScan(): Promise<void>
  sendWifiCredentials(ssid: string, password: string): Promise<void>
  forgetWifiNetwork(ssid: string): Promise<void>
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
    silent: boolean,
  ): Promise<void>

  // OTA Commands
  sendOtaStart(): Promise<void>

  // Version Info Commands
  requestVersionInfo(): Promise<void>

  // Video Recording Commands
  startBufferRecording(): Promise<void>
  stopBufferRecording(): Promise<void>
  saveBufferVideo(requestId: string, durationSeconds: number): Promise<void>
  startVideoRecording(requestId: string, save: boolean, silent: boolean): Promise<void>
  stopVideoRecording(requestId: string): Promise<void>

  // RTMP Stream Commands
  startRtmpStream(params: Record<string, any>): Promise<void>
  stopRtmpStream(): Promise<void>
  keepRtmpStreamAlive(params: Record<string, any>): Promise<void>

  // Microphone Commands
  setMicState(sendPcmData: boolean, sendTranscript: boolean, bypassVad: boolean): Promise<void>
  restartTranscriber(): Promise<void>

  // Audio Playback Monitoring
  // Notify native side when our app starts/stops playing audio
  // Used to suspend LC3 mic during audio playback to avoid MCU overload
  setOwnAppAudioPlaying(playing: boolean): Promise<void>

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

  // Helper methods for type-safe observable store access
  updateGlasses(values: Partial<GlassesStatus>): Promise<void>
  updateCore(values: Partial<CoreStatus>): Promise<void>
  onGlassesStatus(callback: GlassesListener): () => void
  onCoreStatus(callback: CoreListener): () => void
}

// This call loads the native module object from the JSI.
// NativeModule<CoreModuleEvents> already extends EventEmitter<CoreModuleEvents>
const NativeCoreModule = requireNativeModule<CoreModule>("Core")

// Add helper methods to the module
NativeCoreModule.updateGlasses = function (values: Partial<GlassesStatus>) {
  return this.update("glasses", values)
}

NativeCoreModule.updateCore = function (values: Partial<CoreStatus>) {
  return this.update("core", values)
}

export default NativeCoreModule
