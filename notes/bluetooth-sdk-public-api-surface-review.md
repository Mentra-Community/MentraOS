# Bluetooth SDK Public API Surface Review

This review reflects the current Bluetooth SDK public boundary on this branch.
It supersedes the older review created around:

```text
3a512b8357df0e472c6fb5d1352316524e97aee1
Define Bluetooth SDK public API boundary
AuthorDate: 2026-05-15 12:27:57 -0700
```

The goal is feature parity across the three SDK surfaces while preserving each
language's normal shape:

- React Native exposes Promise-based methods and typed event subscriptions.
- Android exposes synchronous facade calls, request data classes where useful,
  listener callbacks, and `AutoCloseable.close()`.
- iOS exposes Swift request structs, delegate callbacks, `async throws` where
  native work can fail asynchronously, and `invalidate()`.

Brightness and auto-brightness setters are intentionally not public in any SDK.
The settings can still exist internally because MentraOS and device-store sync
need to preserve existing behavior, but partners should not call them directly
until the underlying behavior is fixed.

## Source Files Reviewed

- React Native package root: `mobile/modules/bluetooth-sdk/src/index.ts`
- React Native public/internal type boundary:
  `mobile/modules/bluetooth-sdk/src/BluetoothSdk.types.ts`
- React Native raw module facade:
  `mobile/modules/bluetooth-sdk/src/_private/BluetoothSdkModule.ts`
- React Native internal entrypoint:
  `mobile/modules/bluetooth-sdk/src/_internal.ts`
- Android native facade:
  `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/MentraBluetoothSdk.kt`
- Android native models/callbacks:
  `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/{audio,camera,connection,events,internal,requests,status,streaming,types}/`
- iOS native facade:
  `mobile/modules/bluetooth-sdk/ios/Source/MentraBluetoothSDK.swift`
- iOS native models/callbacks:
  `mobile/modules/bluetooth-sdk/ios/Source/{Audio,Camera,Connection,Errors,Events,Internal,Requests,Status,Streaming,Types}/`

## Exposed Feature Set

All three SDKs expose the same customer-facing feature groups:

- Status: typed React hook state, native status snapshots, and default device.
- Discovery and connection: start scan, stop scan, picker-friendly scan helper,
  connect selected device, connect default device, cancel connection attempt,
  disconnect, and forget.
- Display controls: text display, clear display, dashboard display, dashboard
  position, head-up angle, and screen disable.
- Wi-Fi and hotspot: request Wi-Fi scan, send credentials, forget network, and
  toggle hotspot.
- Camera and gallery: gallery mode, button capture settings, camera FOV, photo
  upload request, gallery status query, start video recording, and stop video
  recording.
- Streaming: start stream, keep stream alive, and stop stream.
- Audio: microphone data mode, preferred mic, app-audio playback notification,
  and Mentra Live media volume helpers.
- RGB LED: on/off with constrained color and timing/count arguments.
- Version info: request glasses firmware/version information.

## React Native Public Surface

Import path:

```ts
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {useBluetoothEvent, useBluetoothScan, useMentraBluetooth} from "@mentra/bluetooth-sdk/react"
```

Public value exports:

```ts
DeviceModels
isConnectedGlassesConnectionStatus(status: GlassesConnectionStatus): status is ConnectedGlassesConnectionStatus
isReadyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean
isBusyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean
isConnectedWifiStatus(status: WifiStatus): status is ConnectedWifiStatus
isEnabledHotspotStatus(status: HotspotStatus): status is EnabledHotspotStatus
```

Public module function signatures:

```ts
addListener<EventName extends BluetoothSdkEventName>(
  eventName: EventName,
  listener: BluetoothSdkEventListener<EventName>,
): BluetoothSdkSubscription

getDefaultDevice(): Promise<Device | null>
setDefaultDevice(device: Device | null): Promise<void>
clearDefaultDevice(): Promise<void>

startScan(model: DeviceModel): Promise<void>
stopScan(): Promise<void>
scan(options: ScanOptions): Promise<Device[]>
scan(model: DeviceModel, options?: ScanModelOptions): Promise<Device[]>
connect(device: Device, options?: ConnectOptions): Promise<void>
connectDefault(options?: ConnectOptions): Promise<void>
cancelConnectionAttempt(): Promise<void>
disconnect(): Promise<void>
forget(): Promise<void>

displayText(text: string, x?: number, y?: number, size?: number): Promise<void>
clearDisplay(): Promise<void>
showDashboard(): Promise<void>
setDashboardPosition(height: number, depth: number): Promise<void>
setHeadUpAngle(angleDegrees: number): Promise<void>
setScreenDisabled(disabled: boolean): Promise<void>

requestWifiScan(): Promise<WifiSearchResult[]>
sendWifiCredentials(ssid: string, password: string): Promise<WifiStatusChangeEvent>
forgetWifiNetwork(ssid: string): Promise<WifiStatusChangeEvent>
setHotspotState(enabled: boolean): Promise<HotspotStatusChangeEvent>

setGalleryModeEnabled(enabled: boolean): Promise<SettingsAckEvent>
setPhotoCaptureDefaults(defaults: PhotoCaptureDefaults): Promise<SettingsAckEvent>
setButtonVideoRecordingSettings(width: number, height: number, fps: number): Promise<SettingsAckEvent>
setButtonCameraLed(enabled: boolean): Promise<SettingsAckEvent>
setButtonMaxRecordingTime(minutes: number): Promise<SettingsAckEvent>
setCameraFov(request: CameraFovRequest): Promise<CameraFovResult>
queryGalleryStatus(): Promise<GalleryStatusEvent>
requestPhoto(
  requestId: string,
  appId: string,
  size: PhotoSize,
  webhookUrl: string | null,
  authToken: string | null,
  compress: PhotoCompression,
  sound: boolean,
): Promise<PhotoSuccessResponseEvent>
startVideoRecording(requestId: string, save: boolean, sound: boolean): Promise<VideoRecordingStartedStatusEvent>
stopVideoRecording(requestId: string): Promise<VideoRecordingStoppedStatusEvent>

startStream(params: StreamStartRequest): Promise<void>
stopStream(): Promise<void>

setMicState(
  enabled: boolean,
  useGlassesMic?: boolean,
  bypassVad?: boolean,
  sendTranscript?: boolean,
  sendLc3Data?: boolean,
): Promise<void>
setPreferredMic(preferredMic: MicPreference): Promise<void>
setOwnAppAudioPlaying(playing: boolean): Promise<void>
getGlassesMediaVolume(): Promise<GlassesMediaVolumeGetResult>
setGlassesMediaVolume(level: number): Promise<GlassesMediaVolumeSetResult>

rgbLedControl(
  requestId: string,
  packageName: string | null,
  action: RgbLedAction,
  color: RgbLedColor | null,
  onDurationMs: number,
  offDurationMs: number,
  count: number,
): Promise<RgbLedControlSuccessResponseEvent>

requestVersionInfo(): Promise<VersionInfoResult>
checkForOtaUpdate(): Promise<boolean>
startOtaUpdate(): Promise<OtaStartAckEvent>
```

Photo, video, RGB LED, and settings promises reject when the correlated ASG event reports explicit failure. The raw event listeners still receive the full success/error payloads.

React hook signatures:

```ts
useMentraBluetooth(options?: UseMentraBluetoothOptions): MentraBluetoothSession
useBluetoothScan(options?: UseBluetoothScanOptions): BluetoothScanHookResult
useBluetoothEvent<EventName extends BluetoothSdkEventName>(
  eventName: EventName,
  listener: BluetoothSdkEventListener<EventName>,
  options?: UseBluetoothEventOptions,
): void
```

Important public type constraints:

```ts
type GlassesConnectionStatus =
  | {state: "disconnected"}
  | {state: "scanning"}
  | {state: "connecting"}
  | {state: "bonding"}
  | {state: "connected"; fullyBooted: boolean}

type WifiStatus =
  | {state: "disconnected"}
  | {state: "connected"; ssid: string; localIp?: string}

type HotspotStatus =
  | {state: "disabled"}
  | {state: "enabled"; ssid: string; password: string; localIp: string}

setGalleryModeEnabled(enabled: boolean)
type PhotoSize = "small" | "medium" | "large" | "full"
type ButtonPhotoSize = "small" | "medium" | "large"
type PhotoCompression = "none" | "medium" | "heavy"
const CAMERA_FOV_MIN = 62
const CAMERA_FOV_MAX = 118
const CAMERA_FOV_DEFAULT = 102
type CameraRoiPosition = "center" | "bottom" | "top"
type CameraFovPreset = "narrow" | "standard" | "wide"
type CameraFovRequest = { fov: number; roiPosition?: CameraRoiPosition } | { preset: CameraFovPreset }
type CameraFovResult = {
  requestId: string
  fov: number
  roiPosition: CameraRoiPosition
  timestamp: number
}
type MicPreference = "auto" | "phone" | "glasses" | "bluetooth"
type RgbLedAction = "on" | "off"
type RgbLedColor = "red" | "green" | "blue" | "orange" | "white"
```

## Android Native Public Surface

Factory signatures:

```kotlin
companion object {
  @JvmStatic
  fun create(context: Context, listener: MentraBluetoothSdkListener): MentraBluetoothSdk

  @JvmStatic
  fun create(
    context: Context,
    config: MentraBluetoothSdkConfig,
    listener: MentraBluetoothSdkListener,
  ): MentraBluetoothSdk
}
```

Public facade function signatures:

```kotlin
fun addListener(listener: MentraBluetoothSdkListener)
fun removeListener(listener: MentraBluetoothSdkListener)

fun getGlassesStatus(): GlassesStatus
fun getBluetoothStatus(): BluetoothStatus
fun getDefaultDevice(): Device?
fun setDefaultDevice(device: Device?)
fun clearDefaultDevice()

fun startScan(model: DeviceModel)
fun stopScan()
fun scan(model: DeviceModel, onResults: (List<Device>) -> Unit): ScanSession
fun scan(model: DeviceModel, timeoutMs: Long, onResults: (List<Device>) -> Unit): ScanSession
@JvmOverloads
fun scan(
  model: DeviceModel,
  callback: ScanCallback,
  timeoutMs: Long = 15_000L,
): ScanSession

@JvmOverloads
fun connect(device: Device, options: ConnectOptions = ConnectOptions())
@JvmOverloads
fun connectDefault(options: ConnectOptions = ConnectOptions())
fun cancelConnectionAttempt()
fun disconnect()
fun forget()

@JvmOverloads
fun displayText(text: String, x: Int = 0, y: Int = 0, size: Int = 24)
fun displayText(request: DisplayTextRequest)
fun clearDisplay()
fun showDashboard()
fun setDashboardPosition(height: Int, depth: Int)
fun setDashboardPosition(request: DashboardPositionRequest)
fun setHeadUpAngle(angleDegrees: Int)
fun setScreenDisabled(disabled: Boolean)

fun setGalleryModeEnabled(enabled: Boolean): SettingsAckEvent
fun setPhotoCaptureDefaults(defaults: PhotoCaptureDefaults): SettingsAckEvent
fun setButtonVideoRecordingSettings(width: Int, height: Int, fps: Int): SettingsAckEvent
fun setButtonCameraLed(enabled: Boolean): SettingsAckEvent
fun setButtonMaxRecordingTime(minutes: Int): SettingsAckEvent
fun setCameraFov(fov: CameraFov): CameraFovResult

fun setMicState(
  enabled: Boolean,
  useGlassesMic: Boolean = true,
  bypassVad: Boolean = false,
  sendTranscript: Boolean = false,
  sendLc3Data: Boolean = false,
)
fun setPreferredMic(preferredMic: MicPreference)
fun setOwnAppAudioPlaying(playing: Boolean)
fun getGlassesMediaVolume(): GlassesMediaVolumeGetResult
fun setGlassesMediaVolume(level: Int): GlassesMediaVolumeSetResult

fun requestWifiScan(): List<WifiScanResult>
fun sendWifiCredentials(ssid: String, password: String): WifiStatusEvent
fun forgetWifiNetwork(ssid: String): WifiStatusEvent
fun setHotspotState(enabled: Boolean): HotspotStatusEvent

fun requestPhoto(request: PhotoRequest): PhotoResponseEvent
fun queryGalleryStatus(): GalleryStatusEvent
fun startStream(request: StreamRequest)
fun rgbLedControl(request: RgbLedRequest): RgbLedControlResponseEvent
fun stopStream()
fun startVideoRecording(request: VideoRecordingRequest): VideoRecordingStatusEvent
fun stopVideoRecording(requestId: String): VideoRecordingStatusEvent
fun requestVersionInfo(): VersionInfoResult
fun checkForOtaUpdate(): Boolean
fun startOtaUpdate(): OtaStartAckEvent

override fun close()
```

Photo, video, RGB LED, and settings commands throw when the correlated ASG event reports explicit failure; the event listener callbacks still receive the raw success/error event payloads.

Public Android callback/listener signatures:

```kotlin
interface ScanCallback {
  fun onResults(devices: List<Device>) {}
  fun onComplete(devices: List<Device>) {}
  fun onError(error: BluetoothError) {}
}

class ScanSession {
  fun stop()
}

interface MentraBluetoothSdkListener {
  fun onGlassesStatusChanged(status: GlassesStatusUpdate) {}
  fun onBluetoothStatusChanged(status: BluetoothStatusUpdate) {}
  fun onDeviceDiscovered(device: Device) {}
  fun onScanStopped(reason: ScanStopReason) {}
  fun onButtonPress(event: ButtonPressEvent) {}
  fun onTouch(event: TouchEvent) {}
  fun onSwipe(event: SwipeEvent) {}
  fun onHeadUpChanged(headUp: Boolean) {}
  fun onBatteryStatus(event: BatteryStatusEvent) {}
  fun onWifiStatusChanged(event: WifiStatusEvent) {}
  fun onHotspotStatusChanged(event: HotspotStatusEvent) {}
  fun onHotspotError(event: HotspotErrorEvent) {}
  fun onGalleryStatus(event: GalleryStatusEvent) {}
  fun onPhotoResponse(event: PhotoResponseEvent) {}
  fun onStreamStatus(event: StreamStatusEvent) {}
  fun onKeepAliveAck(event: KeepAliveAckEvent) {}
  fun onMicPcm(frame: ByteArray) {}
  fun onMicLc3(frame: ByteArray) {}
  fun onLocalTranscription(event: LocalTranscriptionEvent) {}
  fun onDefaultDeviceChanged(device: Device?) {}
  fun onLog(message: String) {}
  fun onError(error: BluetoothError) {}
  fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}
```

## iOS Swift Native Public Surface

Public class/properties:

```swift
@MainActor
public final class MentraBluetoothSDK {
  public weak var delegate: MentraBluetoothSDKDelegate?

  public init(configuration: MentraBluetoothSDKConfiguration = .default)

  public var glassesStatus: GlassesStatus { get }
  public var bluetoothStatus: BluetoothStatus { get }
  public var defaultDevice: Device? { get }
}
```

Public facade function signatures:

```swift
public func getDefaultDevice() -> Device?
public func setDefaultDevice(_ device: Device?)
public func clearDefaultDevice()

public func startScan(model: DeviceModel) throws
public func stopScan()

@discardableResult
public func scan(
  model: DeviceModel,
  timeout: TimeInterval = 15,
  onResults: @escaping ([Device]) -> Void,
  onComplete: @escaping ([Device]) -> Void = { _ in }
) throws -> ScanSession

public func connect(to device: Device, options: ConnectOptions = ConnectOptions()) throws
public func connectDefault(options: ConnectOptions = ConnectOptions()) throws
public func cancelConnectionAttempt()
public func disconnect()
public func forget()

public func displayText(_ text: String, x: Int = 0, y: Int = 0, size: Int = 24) async throws
public func displayText(_ request: DisplayTextRequest) async throws
public func clearDisplay() async throws
public func showDashboard()
public func setDashboardPosition(height: Int, depth: Int) async throws
public func setDashboardPosition(_ request: DashboardPositionRequest) async throws
public func setHeadUpAngle(_ angleDegrees: Int) async throws
public func setScreenDisabled(_ disabled: Bool) async throws

public func setGalleryModeEnabled(_ enabled: Bool) async throws -> SettingsAckEvent
public func setPhotoCaptureDefaults(_ defaults: PhotoCaptureDefaults) async throws -> SettingsAckEvent
public func setButtonVideoRecordingSettings(width: Int, height: Int, fps: Int) async throws -> SettingsAckEvent
public func setButtonVideoRecordingSettings(_ settings: ButtonVideoRecordingSettings) async throws -> SettingsAckEvent
public func setButtonCameraLed(enabled: Bool) async throws -> SettingsAckEvent
public func setButtonMaxRecordingTime(minutes: Int) async throws -> SettingsAckEvent
public func setCameraFov(_ fov: CameraFov) async throws -> CameraFovResult

public func setMicState(
  enabled: Bool,
  useGlassesMic: Bool = true,
  bypassVad: Bool = false,
  sendTranscript: Bool = false,
  sendLc3Data: Bool = false
)
public func setPreferredMic(_ preferredMic: MicPreference)
public func setOwnAppAudioPlaying(_ playing: Bool)
public func getGlassesMediaVolume() async throws -> GlassesMediaVolumeGetResult
public func setGlassesMediaVolume(_ level: Int) async throws -> GlassesMediaVolumeSetResult

public func requestWifiScan() async throws -> [WifiScanResult]
public func sendWifiCredentials(ssid: String, password: String) async throws -> WifiStatusEvent
public func forgetWifiNetwork(ssid: String) async throws -> WifiStatusEvent
public func setHotspotState(enabled: Bool) async throws -> HotspotStatusEvent

public func requestPhoto(_ request: PhotoRequest) async throws -> PhotoResponseEvent
public func queryGalleryStatus() async throws -> GalleryStatusEvent
public func startStream(_ request: StreamRequest)
public func rgbLedControl(_ request: RgbLedRequest) async throws -> RgbLedControlResponseEvent
public func stopStream()
public func startVideoRecording(_ request: VideoRecordingRequest) async throws -> VideoRecordingStatusEvent
public func stopVideoRecording(requestId: String) async throws -> VideoRecordingStatusEvent
public func requestVersionInfo() async throws -> VersionInfoResult
public func checkForOtaUpdate() async throws -> Bool
public func startOtaUpdate() async throws -> OtaStartAckEvent

public func invalidate()
```

Photo, video, RGB LED, and settings commands throw when the correlated ASG event reports explicit failure; delegates still receive the raw success/error event payloads.

Public iOS delegate/callback signatures:

```swift
@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: BluetoothStatusUpdate)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: ScanStopReason)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: BluetoothEvent)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: Device?)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: BluetoothError)
}

public final class ScanSession {
  public func stop()
}
```

## Functionality Made Internal Or Private

### React Native

The public package root is `@mentra/bluetooth-sdk`. MentraOS-only compatibility
code uses the internal import path:

```ts
import BluetoothSdkInternal from "@mentra/bluetooth-sdk-internal"
```

The package root does not expose:

```ts
update(category: ObservableStoreCategory, values: object): Promise<void>
updateGlasses(values: Partial<GlassesStatus>): Promise<void>
updateBluetoothSettings(values: BluetoothSettingsUpdate): Promise<void>

requestStatus(): Promise<void>
displayEvent(params: Record<string, unknown>): Promise<void>

connectDefaultController(): Promise<void>
disconnectController(): Promise<void>
connectSimulated(): Promise<void>
forgetController(): Promise<void>

setDashboardMenu(items: DashboardMenuItem[]): Promise<void>
setBrightness(level: number, autoMode?: boolean | null): Promise<void>
setAutoBrightness(enabled: boolean): Promise<void>

sendIncidentId(incidentId: string, apiBaseUrl?: string | null): Promise<void>
setOtaVersionUrl(otaVersionUrl: string): void
getOtaVersionUrl(): string
startOtaUpdate(otaVersionUrl?: string | null): Promise<OtaStartAckEvent>
sendOtaQueryStatus(): Promise<void>
restartTranscriber(): Promise<void>

setSttModelDetails(path: string, languageCode: string): Promise<void>
getSttModelPath(): Promise<string>
checkSttModelAvailable(): Promise<boolean>
validateSttModel(path: string): Promise<boolean>
extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>

getMemoryMB(): number
```

The root event surface also omits raw/internal event families such as WebSocket
trace events, internal OTA progress events, command-to-BLE traces, and MiniApp
selection events.

The OTA manifest URL getter/setter (`setOtaVersionUrl` / `getOtaVersionUrl`) and
the `startOtaUpdate(otaVersionUrl)` override are intentionally kept off the
public boundary; `setOtaVersionUrl` / `getOtaVersionUrl` are re-exported from the
`@mentra/bluetooth-sdk/debug` subpath for MentraOS/debug recovery only. The
public `startOtaUpdate()` resolves the same manifest URL `checkForOtaUpdate()`
uses (the configured/staging default, or the glasses-advertised/production URL
for pre-wall-clock ASG builds).

### Android Native

These facade methods are internal Android SDK methods:

```kotlin
internal fun connectSimulated()
internal fun displayEvent(request: DisplayEventRequest)
internal fun setDashboardMenu(items: List<DashboardMenuItem>)
internal fun setBrightness(level: Int, autoMode: Boolean? = null)
internal fun setAutoBrightness(enabled: Boolean)
internal fun setOtaVersionUrl(otaVersionUrl: String)
internal fun getOtaVersionUrl(): String
internal fun startOtaUpdate(otaVersionUrl: String): OtaStartAckEvent
internal fun sendOtaQueryStatus()
internal fun sendShutdown()
internal fun sendReboot()
internal fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null)
```

`DisplayEventRequest` and `DashboardMenuItem` are internal model types because
their only facade methods are internal. The deprecated `MicConfig` overload was
removed before public release; the public microphone API is the scalar
`setMicState(...)` signature.

### iOS Native

These facade methods are internal Swift SDK methods:

```swift
func connectSimulated()
func displayEvent(_ request: DisplayEventRequest) async throws
func setDashboardMenu(_ items: [DashboardMenuItem]) async throws
func setBrightness(_ level: Int, autoMode: Bool? = nil) async throws
func setAutoBrightness(enabled: Bool) async throws
func setOtaVersionUrl(_ otaVersionUrl: String) throws
func getOtaVersionUrl() -> String
func startOtaUpdate(otaVersionUrl: String) async throws -> OtaStartAckEvent
func sendOtaQueryStatus()
func sendShutdown()
func sendReboot()
func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil)
```

`DisplayEventRequest` and `DashboardMenuItem` are internal model types because
their only facade methods are internal. The deprecated `MicConfiguration`
overload was removed before public release; the public microphone API is the
scalar `setMicState(...)` signature.

## Intentional Cross-Language Shape Differences

- React Native scan returns a `Promise<Device[]>` and can report progressive
  results through `onResults`. Android and iOS return a `ScanSession`
  immediately and report progressive/final results through callbacks.
- React Native uses scalar method arguments for many operations. Android and iOS
  also expose request objects for operations where that reads better natively,
  such as photo, stream, RGB LED, and video recording.
- React Native uses typed event names through `addListener(...)`. Android uses
  `MentraBluetoothSdkListener`; iOS uses `MentraBluetoothSDKDelegate`.
- Android exposes `close()` because the facade implements `AutoCloseable`. iOS
  exposes `invalidate()`. React Native does not expose a module-wide teardown.
- Android and iOS public status snapshots currently expose a fuller native view
  of the local store than the React Native package root. That is not a feature
  gap, but it is a candidate for a future pass if we want status models to be as
  tightly constrained as the operation methods.

## Current Review Conclusion

After this pass, there are no known missing public operation functions between
React Native, Android, and iOS for the intended partner feature set. The one
previous functional gap, Swift media volume, is now covered by:

```swift
public func getGlassesMediaVolume() async throws -> GlassesMediaVolumeGetResult
public func setGlassesMediaVolume(_ level: Int) async throws -> GlassesMediaVolumeSetResult
```

The public/private split is also cleaner:

- Broken brightness setters are internal only across all three SDKs.
- Internal dashboard/display-event model types are no longer exposed by native
  SDKs.
- Deprecated pre-release native microphone config overloads are removed.
