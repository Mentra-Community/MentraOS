// import Foundation

// public struct BluetoothSDKConfiguration {
//     public static let `default` = BluetoothSDKConfiguration()

//     public init() {}
// }

// public enum DeviceModel: String {
//     case g1
//     case g2
//     case Live
//     case Nex
//     case mach1
//     case z100
//     case frame
//     case simulated
//     case r1

//     var deviceType: String {
//         switch self {
//         case .g1:
//             DeviceTypes.G1
//         case .g2:
//             DeviceTypes.G2
//         case .Live:
//             DeviceTypes.LIVE
//         case .Nex:
//             DeviceTypes.NEX
//         case .mach1:
//             DeviceTypes.MACH1
//         case .z100:
//             DeviceTypes.Z100
//         case .frame:
//             DeviceTypes.FRAME
//         case .simulated:
//             DeviceTypes.SIMULATED
//         case .r1:
//             ControllerTypes.R1
//         }
//     }

//     static func fromDeviceType(_ deviceType: String?) -> DeviceModel {
//         switch deviceType {
//         case DeviceTypes.G1:
//             .g1
//         case DeviceTypes.G2:
//             .g2
//         case DeviceTypes.LIVE:
//             .Live
//         case DeviceTypes.NEX:
//             .Nex
//         case DeviceTypes.MACH1:
//             .mach1
//         case DeviceTypes.Z100:
//             .z100
//         case DeviceTypes.FRAME:
//             .frame
//         case DeviceTypes.SIMULATED:
//             .simulated
//         case ControllerTypes.R1:
//             .r1
//         default:
//             .Live
//         }
//     }
// }

// public struct DiscoveredDevice: CustomStringConvertible {
//     public let model: DeviceModel
//     public let name: String
//     public let identifier: String?
//     public let rssi: Int?

//     public init(
//         model: DeviceModel,
//         name: String,
//         identifier: String? = nil,
//         rssi: Int? = nil
//     ) {
//         self.model = model
//         self.name = name
//         self.identifier = identifier
//         self.rssi = rssi
//     }

//     public var description: String {
//         "DiscoveredDevice(model: \(model), name: \(name))"
//     }
// }

// public struct PairedDevice: CustomStringConvertible {
//     public let model: DeviceModel
//     public let name: String
//     public let identifier: String?

//     public init(model: DeviceModel, name: String, identifier: String? = nil) {
//         self.model = model
//         self.name = name
//         self.identifier = identifier
//     }

//     public var description: String {
//         "PairedDevice(model: \(model), name: \(name))"
//     }
// }

// public struct GlassesStatus: CustomStringConvertible {
//     public let values: [String: Any]

//     public init(values: [String: Any]) {
//         self.values = values
//     }

//     public var description: String {
//         values.description
//     }
// }

// public struct BluetoothStatus: CustomStringConvertible {
//     public let values: [String: Any]

//     public init(values: [String: Any]) {
//         self.values = values
//     }

//     public var description: String {
//         values.description
//     }
// }

// public struct GlassesStatusUpdate: CustomStringConvertible {
//     public let values: [String: Any]

//     public init(values: [String: Any]) {
//         self.values = values
//     }

//     public var description: String {
//         values.description
//     }
// }

// public struct BluetoothStatusUpdate: CustomStringConvertible {
//     public let values: [String: Any]

//     public init(values: [String: Any]) {
//         self.values = values
//     }

//     public var description: String {
//         values.description
//     }
// }

// public struct DisplayTextRequest {
//     public let text: String
//     public let x: Int
//     public let y: Int
//     public let size: Int

//     public init(text: String, x: Int = 0, y: Int = 0, size: Int = 24) {
//         self.text = text
//         self.x = x
//         self.y = y
//         self.size = size
//     }

//     var dictionary: [String: Any] {
//         [
//             "text": text,
//             "x": x,
//             "y": y,
//             "size": size,
//         ]
//     }
// }

// public struct DisplayEventRequest {
//     public let values: [String: Any]

//     public init(values: [String: Any]) {
//         self.values = values
//     }
// }

// public struct DashboardPositionRequest {
//     public let height: Int
//     public let depth: Int

//     public init(height: Int, depth: Int) {
//         self.height = height
//         self.depth = depth
//     }
// }

// public struct DashboardMenuItem {
//     public let title: String
//     public let packageName: String
//     public let values: [String: Any]

//     public init(title: String, packageName: String, values: [String: Any] = [:]) {
//         self.title = title
//         self.packageName = packageName
//         self.values = values
//     }

//     var dictionary: [String: Any] {
//         values.merging(["title": title, "packageName": packageName]) { _, new in new }
//     }
// }

// public enum GalleryMode {
//     case auto
//     case manual
// }

// public enum ButtonMode: String {
//     case photo
//     case video
//     case none
// }

// public enum PhotoSize: String {
//     case small
//     case medium
//     case large
// }

// public struct ButtonPhotoSettings {
//     public let size: PhotoSize

//     public init(size: PhotoSize) {
//         self.size = size
//     }
// }

// public struct ButtonVideoRecordingSettings {
//     public let width: Int
//     public let height: Int
//     public let fps: Int

//     public init(width: Int, height: Int, fps: Int) {
//         self.width = width
//         self.height = height
//         self.fps = fps
//     }
// }

// public enum CameraFov {
//     case standard
//     case wide

//     var value: [String: Int] {
//         switch self {
//         case .standard:
//             ["fov": 118, "roi_position": 0]
//         case .wide:
//             ["fov": 118, "roi_position": 0]
//         }
//     }
// }

// public struct MicConfiguration {
//     public let sendPcmData: Bool
//     public let sendTranscript: Bool
//     public let bypassVad: Bool
//     public let sendLc3Data: Bool

//     public init(
//         sendPcmData: Bool,
//         sendTranscript: Bool,
//         bypassVad: Bool,
//         sendLc3Data: Bool = false
//     ) {
//         self.sendPcmData = sendPcmData
//         self.sendTranscript = sendTranscript
//         self.bypassVad = bypassVad
//         self.sendLc3Data = sendLc3Data
//     }
// }

// public enum MicPreference: String {
//     case auto
//     case phone
//     case glasses
//     case bluetooth
// }

// public struct PhotoRequest {
//     public let requestId: String
//     public let appId: String
//     public let size: String
//     public let webhookUrl: String?
//     public let authToken: String?
//     public let compress: String?
//     public let flash: Bool
//     public let sound: Bool

//     public init(
//         requestId: String,
//         appId: String,
//         size: String,
//         webhookUrl: String? = nil,
//         authToken: String? = nil,
//         compress: String? = nil,
//         flash: Bool,
//         sound: Bool
//     ) {
//         self.requestId = requestId
//         self.appId = appId
//         self.size = size
//         self.webhookUrl = webhookUrl
//         self.authToken = authToken
//         self.compress = compress
//         self.flash = flash
//         self.sound = sound
//     }
// }

// public struct StreamRequest {
//     public let values: [String: Any]

//     public init(values: [String: Any]) {
//         self.values = values
//     }
// }

// public struct StreamKeepAliveRequest {
//     public let values: [String: Any]

//     public init(values: [String: Any]) {
//         self.values = values
//     }
// }

// public struct VideoRecordingRequest {
//     public let requestId: String
//     public let save: Bool
//     public let flash: Bool
//     public let sound: Bool

//     public init(requestId: String, save: Bool, flash: Bool, sound: Bool) {
//         self.requestId = requestId
//         self.save = save
//         self.flash = flash
//         self.sound = sound
//     }
// }

// public struct ButtonPressEvent: CustomStringConvertible {
//     public let buttonId: String
//     public let pressType: String
//     public let timestamp: Int?

//     public init(buttonId: String, pressType: String, timestamp: Int? = nil) {
//         self.buttonId = buttonId
//         self.pressType = pressType
//         self.timestamp = timestamp
//     }

//     public var description: String {
//         "ButtonPressEvent(buttonId: \(buttonId), pressType: \(pressType))"
//     }
// }

// public struct BluetoothError: Error, CustomStringConvertible {
//     public let code: String
//     public let message: String

//     public init(code: String, message: String) {
//         self.code = code
//         self.message = message
//     }

//     public var description: String {
//         "\(code): \(message)"
//     }
// }

// public enum ScanStopReason {
//     case completed
//     case cancelled
//     case error
// }

// public struct LocalTranscriptionEvent: CustomStringConvertible {
//     public let text: String
//     public let isFinal: Bool
//     public let values: [String: Any]

//     public init(text: String, isFinal: Bool, values: [String: Any]) {
//         self.text = text
//         self.isFinal = isFinal
//         self.values = values
//     }

//     public var description: String {
//         "LocalTranscriptionEvent(text: \(text), isFinal: \(isFinal))"
//     }
// }

// public enum BluetoothEvent: CustomStringConvertible {
//     case localTranscription(LocalTranscriptionEvent)
//     case raw(name: String, values: [String: Any])

//     public var description: String {
//         switch self {
//         case let .localTranscription(event):
//             event.description
//         case let .raw(name, values):
//             "\(name): \(values)"
//         }
//     }
// }

// @MainActor
// public protocol BluetoothSDKDelegate: AnyObject {
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didUpdateBluetoothStatus status: BluetoothStatusUpdate)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didDiscover device: DiscoveredDevice)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didStopScan reason: ScanStopReason)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didReceive event: BluetoothEvent)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didReceiveMicPcm frame: Data)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didReceiveMicLc3 frame: Data)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didChangeDefaultDevice device: PairedDevice?)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didLog message: String)
//     func mentraBluetoothSDK(_ sdk: BluetoothSDK, didFail error: BluetoothError)
// }

// @MainActor
// public extension BluetoothSDKDelegate {
//     func mentraBluetoothSDK(_: BluetoothSDK, didUpdateGlassesStatus _: GlassesStatusUpdate) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didUpdateBluetoothStatus _: BluetoothStatusUpdate) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didDiscover _: DiscoveredDevice) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didStopScan _: ScanStopReason) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didReceive _: BluetoothEvent) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didReceiveMicPcm _: Data) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didReceiveMicLc3 _: Data) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didChangeDefaultDevice _: PairedDevice?) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didLog _: String) {}
//     func mentraBluetoothSDK(_: BluetoothSDK, didFail _: BluetoothError) {}
// }

// @MainActor
// public final class BluetoothSDK {
//     public weak var delegate: BluetoothSDKDelegate?

//     private let configuration: BluetoothSDKConfiguration
//     private var discoveredDeviceNames = Set<String>()
//     private var bridgeEventSinkId: String?
//     private var storeListenerId: String?

//     public init(configuration: BluetoothSDKConfiguration = .default) {
//         self.configuration = configuration
//     }

//     public var glassesStatus: GlassesStatus {
//         GlassesStatus(values: GlassesStore.shared.store.getCategory("glasses"))
//     }

//     public var bluetoothStatus: BluetoothStatus {
//         BluetoothStatus(values: GlassesStore.shared.store.getCategory(ObservableStore.coreCategory))
//     }

//     public func startScan(model: DeviceModel) {
//         discoveredDeviceNames.removeAll()
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", true)
//         CoreManager.shared.findCompatibleDevices(model.deviceType)
//     }

//     public func stopScan() {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", false)
//         delegate?.mentraBluetoothSDK(self, didStopScan: .cancelled)
//     }

//     public func connect(to device: DiscoveredDevice) {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "pending_wearable", device.model.deviceType)
//         CoreManager.shared.connectByName(device.name)
//     }

//     public func connect(model: DeviceModel, name: String) {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "pending_wearable", model.deviceType)
//         CoreManager.shared.connectByName(name)
//     }

//     public func connectByName(_ name: String) {
//         CoreManager.shared.connectByName(name)
//     }

//     public func connectDefault() {
//         CoreManager.shared.connectDefault()
//     }

//     public func connectSimulated() {
//         CoreManager.shared.connectSimulated()
//     }

//     public func disconnect() {
//         CoreManager.shared.disconnect()
//     }

//     public func forget() {
//         CoreManager.shared.forget()
//     }

//     public func displayText(_ request: DisplayTextRequest) async throws {
//         CoreManager.shared.displayText(request.dictionary)
//     }

//     public func displayEvent(_ request: DisplayEventRequest) async throws {
//         CoreManager.shared.displayEvent(request.values)
//     }

//     public func clearDisplay() async throws {
//         CoreManager.shared.sgc?.clearDisplay()
//     }

//     public func showDashboard() {
//         CoreManager.shared.showDashboard()
//     }

//     public func setBrightness(_ level: Int, autoMode: Bool? = nil) async throws {
//         if let autoMode {
//             GlassesStore.shared.apply(ObservableStore.coreCategory, "auto_brightness", autoMode)
//         }
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "brightness", level)
//     }

//     public func setAutoBrightness(enabled: Bool) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "auto_brightness", enabled)
//     }

//     public func setDashboardPosition(_ request: DashboardPositionRequest) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_height", request.height)
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_depth", request.depth)
//     }

//     public func setDashboardMenu(_ items: [DashboardMenuItem]) async throws {
//         GlassesStore.shared.apply(
//             ObservableStore.coreCategory,
//             "dashboard_menu_apps",
//             items.map(\.dictionary)
//         )
//     }

//     public func setHeadUpAngle(_ angleDegrees: Int) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "head_up_angle", angleDegrees)
//     }

//     public func setScreenDisabled(_ disabled: Bool) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "screen_disabled", disabled)
//     }

//     public func setGalleryMode(_ mode: GalleryMode) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "gallery_mode", mode == .auto)
//     }

//     public func setButtonMode(_ mode: ButtonMode) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "button_mode", mode.rawValue)
//     }

//     public func setButtonPhotoSettings(_ settings: ButtonPhotoSettings) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "button_photo_size", settings.size.rawValue)
//     }

//     public func setButtonVideoRecordingSettings(_ settings: ButtonVideoRecordingSettings) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_width", settings.width)
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_height", settings.height)
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_fps", settings.fps)
//     }

//     public func setButtonCameraLed(enabled: Bool) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "button_camera_led", enabled)
//     }

//     public func setButtonMaxRecordingTime(minutes: Int) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "button_max_recording_time", minutes)
//     }

//     public func setCameraFov(_ fov: CameraFov) async throws {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "camera_fov", fov.value)
//     }

//     public func setMicState(_ config: MicConfiguration) {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_pcm", config.sendPcmData)
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_lc3", config.sendLc3Data)
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_transcript", config.sendTranscript)
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "bypass_vad", config.bypassVad)
//         CoreManager.shared.setMicState()
//     }

//     public func setPreferredMic(_ preferredMic: MicPreference) {
//         GlassesStore.shared.apply(ObservableStore.coreCategory, "preferred_mic", preferredMic.rawValue)
//     }

//     public func setOwnAppAudioPlaying(_ playing: Bool) {
//         PhoneAudioMonitor.getInstance().setOwnAppAudioPlaying(playing)
//     }

//     public func requestWifiScan() {
//         CoreManager.shared.requestWifiScan()
//     }

//     public func sendWifiCredentials(ssid: String, password: String) {
//         CoreManager.shared.sendWifiCredentials(ssid, password)
//     }

//     public func forgetWifiNetwork(ssid: String) {
//         CoreManager.shared.forgetWifiNetwork(ssid)
//     }

//     public func setHotspotState(enabled: Bool) {
//         CoreManager.shared.setHotspotState(enabled)
//     }

//     public func requestPhoto(_ request: PhotoRequest) {
//         CoreManager.shared.photoRequest(
//             request.requestId,
//             request.appId,
//             request.size,
//             request.webhookUrl,
//             request.authToken,
//             request.compress,
//             request.flash,
//             request.sound
//         )
//     }

//     public func queryGalleryStatus() {
//         CoreManager.shared.queryGalleryStatus()
//     }

//     public func startStream(_ request: StreamRequest) {
//         CoreManager.shared.startStream(request.values)
//     }

//     public func keepStreamAlive(_ request: StreamKeepAliveRequest) {
//         CoreManager.shared.keepStreamAlive(request.values)
//     }

//     public func stopStream() {
//         CoreManager.shared.stopStream()
//     }

//     public func startVideoRecording(_ request: VideoRecordingRequest) {
//         CoreManager.shared.startVideoRecording(
//             request.requestId,
//             request.save,
//             request.flash,
//             request.sound
//         )
//     }

//     public func stopVideoRecording(requestId: String) {
//         CoreManager.shared.stopVideoRecording(requestId)
//     }

//     public func requestVersionInfo() {
//         CoreManager.shared.requestVersionInfo()
//     }

//     public func sendOtaStart() {
//         CoreManager.shared.sendOtaStart()
//     }

//     public func sendShutdown() {
//         CoreManager.shared.sendShutdown()
//     }

//     public func sendReboot() {
//         CoreManager.shared.sendReboot()
//     }

//     public func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil) {
//         CoreManager.shared.sendIncidentId(incidentId, apiBaseUrl: apiBaseUrl)
//     }

//     public func invalidate() {
//         if let bridgeEventSinkId {
//             Bridge.removeEventSink(bridgeEventSinkId)
//             self.bridgeEventSinkId = nil
//         }
//         delegate = nil
//     }
// }