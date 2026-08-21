//
//  MentraNex.swift
//  MentraOS_Manager
//
//  Created by Gemini on 2024-07-29.
//

import Combine
import CoreBluetooth
import Foundation
import SwiftProtobuf
import UIKit

/// Helper extension for debugging
extension Data {
    func toHexString() -> String {
        map { String(format: "%02x", $0) }.joined(separator: " ")
    }
}

/// Nex firmware expects tier 1–4 in protobuf `DisplayDistanceConfig.distance_cm` (name is legacy, not cm).
/// Keep in sync with `NexProtobufUtils.dashboardDepthToDistanceCm` (Android `NexSGCUtils.kt`).
enum NexDashboardDisplayWire {
    static let depthMin = 1
    static let depthMax = 4

    static func depthToWireTier(_ depth: Int) -> UInt32 {
        UInt32(min(max(depth, depthMin), depthMax))
    }

    /// Read an `Any?` value from the store, default to `depthMin`, and clamp to valid range.
    static func clampDepthFromStore(_ value: Any?) -> Int {
        let raw = value as? Int ?? depthMin
        return min(max(raw, depthMin), depthMax)
    }
}

@MainActor
@objc(MentraNexSGC)
class MentraNexSGC: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, SGCManager {
    func sendIncidentId(_: String, apiBaseUrl _: String?) {}

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}

    func setMicEnabled(_ enabled: Bool) {
        shouldUseGlassesMic = enabled
        if enabled {
            startMicBeat()
        } else {
            stopMicBeat()
        }
    }

    func requestPhoto(_: PhotoRequest) {}

    func startStream(_: [String: Any]) {}

    func stopStream() {}

    func sendStreamKeepAlive(_: [String: Any]) {}

    func startVideoRecording(requestId _: String, save _: Bool, sound _: Bool) {}

    func stopVideoRecording(requestId _: String) {}

    func sendButtonPhotoSettings() {}

    func sendButtonVideoRecordingSettings() {}

    func sendButtonMaxRecordingTime() {}

    func sendCameraFovSetting() {}

    func setBrightness(_ level: Int, autoMode: Bool) {
        updateGlassesBrightness(level)
        updateGlassesAutoBrightness(autoMode)
    }

    func sendText(_ text: String) async {
        await sendTextWall(text)
    }

    func sendDoubleTextWall(_ top: String, _ bottom: String) async {
        await sendTextWall("\(top)\n\(bottom)")
    }

    func displayBitmap(base64ImageData: String, x _: Int32? = nil, y _: Int32? = nil, width: Int32? = nil, height: Int32? = nil) async -> Bool {
        guard let imageData = Data(base64Encoded: base64ImageData),
              let image = UIImage(data: imageData)
        else {
            Bridge.log("NEX: Failed to decode base64 image payload")
            return false
        }
        // Same glasses-native pipeline as the canvas path: scale to the target
        // size when given, invert + dither, encode a real 1-bit BMP (the old
        // conversion emitted raw RGBA the firmware couldn't decode).
        // Legacy callers can hand us zero/negative dims — clamp to the canvas
        // so the scale/encode path can't divide by zero or allocate garbage.
        let rawWidth = width ?? Int32(image.cgImage?.width ?? Int(image.size.width * image.scale))
        let rawHeight = height ?? Int32(image.cgImage?.height ?? Int(image.size.height * image.scale))
        let pixelWidth = min(max(rawWidth, 1), 500)
        let pixelHeight = min(max(rawHeight, 1), 220)
        let scaled = scaledImage(image, toWidth: pixelWidth, height: pixelHeight)
        guard let bmpData = convertImageToNex1BitBmp(scaled) else {
            Bridge.log("NEX: Failed to convert UIImage to 1-bit BMP")
            return false
        }
        displayBitmapData(bmpData, width: Int(pixelWidth), height: Int(pixelHeight))
        return true
    }

    // MARK: - Canvas scene verbs (display.render() pipeline)

    // Retained-mode canvas registry: elementId → firmware component. Mirrors
    // MentraNex.kt. Text ids come from the firmware pool 1–6, bitmaps from
    // 10–13 (mos_display_canvas_view.c); insertion order drives real oldest-out
    // eviction when a pool is exhausted.
    private struct CanvasElement {
        let firmwareId: UInt32
        let isBitmap: Bool
        var rect: String
    }

    private var canvasElements: [(key: String, value: CanvasElement)] = []
    private var currentLayoutId: String?
    private let canvasTextIdPool: [UInt32] = [1, 2, 3, 4, 5, 6]
    private let canvasBitmapIdPool: [UInt32] = [10, 11, 12, 13]

    private func canvasElementIndex(_ key: String) -> Int? {
        canvasElements.firstIndex(where: { $0.key == key })
    }

    private func sendCanvasCommand(_ configure: (inout Mentraos_Ble_PhoneToGlasses) -> Void) {
        var msg = Mentraos_Ble_PhoneToGlasses()
        configure(&msg)
        guard let data = try? msg.serializedData() else { return }
        queueDataWithOptimalChunking(data, packetType: PACKET_TYPE_PROTOBUF, waitTimeMs: 10)
    }

    /**
     Handle a scene/layout change. DeviceManager sweeps the previous app's
     elements before a cross-app frame arrives, so the registry is usually empty
     here and switching costs nothing. Stale components are deleted
     individually, NOT via CanvasClear — clear also exits the canvas VIEW (the
     first create re-activates it), which reads as a full-screen flash.
     */
    private func ensureLayout(_ layoutId: String?) {
        guard let layoutId, layoutId != currentLayoutId else { return }
        if !canvasElements.isEmpty {
            for (_, el) in canvasElements {
                sendCanvasCommand { $0.canvasDeleteComponent = .with { $0.id = el.firmwareId } }
            }
            canvasElements.removeAll()
        }
        currentLayoutId = layoutId
    }

    /// Replay frames repaint from scratch: forget the registry so every element
    /// takes the CREATE path (create-on-existing-id is replace in firmware;
    /// updates to dead component ids are dropped silently).
    func onSceneReplay(_ appId: String) async {
        canvasElements.removeAll()
        currentLayoutId = appId
    }

    /// Free firmware id from the type's pool, evicting the oldest same-type
    /// element (delete on glasses + registry) when the pool is exhausted.
    private func allocFirmwareId(isBitmap: Bool) -> UInt32? {
        let pool = isBitmap ? canvasBitmapIdPool : canvasTextIdPool
        let used = Set(canvasElements.filter { $0.value.isBitmap == isBitmap }.map(\.value.firmwareId))
        if let free = pool.first(where: { !used.contains($0) }) {
            return free
        }
        guard let oldestIdx = canvasElements.firstIndex(where: { $0.value.isBitmap == isBitmap }) else {
            return nil
        }
        let oldest = canvasElements.remove(at: oldestIdx)
        Bridge.log("NEX: pool full — evicting oldest \(isBitmap ? "bitmap" : "text") element '\(oldest.key)' (fw id \(oldest.value.firmwareId))")
        sendCanvasCommand { $0.canvasDeleteComponent = .with { $0.id = oldest.value.firmwareId } }
        return oldest.value.firmwareId
    }

    func drawLayoutText(
        _ text: String, x: Int32, y: Int32, width: Int32, height: Int32,
        borderWidth: Int32, borderRadius: Int32, elementId: String, layoutId: String?
    ) async {
        ensureLayout(layoutId)
        let rect = "\(x),\(y),\(width)x\(height),\(borderWidth),\(borderRadius)"
        if let i = canvasElementIndex(elementId), !canvasElements[i].value.isBitmap {
            let fid = canvasElements[i].value.firmwareId
            if canvasElements[i].value.rect != rect {
                // Geometry moved/restyled — recreate the box at the SAME
                // firmware id (create-on-existing-id = replace), then set text.
                sendCanvasCommand {
                    $0.canvasCreateComponent = .with {
                        $0.id = fid
                        $0.type = .canvasTextbox
                        $0.x = UInt32(max(0, x)); $0.y = UInt32(max(0, y))
                        $0.width = UInt32(max(0, width)); $0.height = UInt32(max(0, height))
                        $0.borderWidth = UInt32(max(0, borderWidth))
                        $0.borderRadius = UInt32(max(0, borderRadius))
                    }
                }
                canvasElements[i].value.rect = rect
            }
            sendCanvasCommand { $0.canvasUpdateText = .with { $0.id = fid; $0.text = self.sanitizeDisplayText(text) } }
            return
        }
        guard let fid = allocFirmwareId(isBitmap: false) else {
            Bridge.log("NEX: text pool exhausted — dropping element '\(elementId)'")
            return
        }
        canvasElements.append((key: elementId, value: CanvasElement(firmwareId: fid, isBitmap: false, rect: rect)))
        sendCanvasCommand {
            $0.canvasCreateComponent = .with {
                $0.id = fid
                $0.type = .canvasTextbox
                $0.x = UInt32(max(0, x)); $0.y = UInt32(max(0, y))
                $0.width = UInt32(max(0, width)); $0.height = UInt32(max(0, height))
                $0.borderWidth = UInt32(max(0, borderWidth))
                $0.borderRadius = UInt32(max(0, borderRadius))
            }
        }
        sendCanvasCommand { $0.canvasUpdateText = .with { $0.id = fid; $0.text = self.sanitizeDisplayText(text) } }
    }

    func drawLayoutBitmap(
        base64ImageData: String, x: Int32, y: Int32, width: Int32, height: Int32,
        elementId: String, layoutId: String?
    ) async -> Bool {
        ensureLayout(layoutId)
        guard let imageData = Data(base64Encoded: base64ImageData),
              let image = UIImage(data: imageData)
        else {
            Bridge.log("NEX: drawLayoutBitmap failed to decode base64 image")
            return false
        }
        // Scale phone-side to the component box (never on glasses), then run
        // the glasses-native pipeline: invert → Floyd–Steinberg dither → real
        // 1-bit BMP encode (Android parity; the old convertUIImageToBmpData
        // emitted raw RGBA, which the firmware BMP decoder can't read).
        let scaled = scaledImage(image, toWidth: width, height: height)
        guard let bmpData = convertImageToNex1BitBmp(scaled) else {
            Bridge.log("NEX: drawLayoutBitmap failed to convert image")
            return false
        }

        let rect = "\(x),\(y),\(width)x\(height)"
        let fid: UInt32
        if let i = canvasElementIndex(elementId), canvasElements[i].value.isBitmap {
            fid = canvasElements[i].value.firmwareId
            if canvasElements[i].value.rect != rect {
                sendCanvasCommand {
                    $0.canvasCreateComponent = .with {
                        $0.id = fid
                        $0.type = .canvasBitmap
                        $0.x = UInt32(max(0, x)); $0.y = UInt32(max(0, y))
                        $0.width = UInt32(max(0, width)); $0.height = UInt32(max(0, height))
                    }
                }
                canvasElements[i].value.rect = rect
            }
        } else {
            guard let allocated = allocFirmwareId(isBitmap: true) else {
                Bridge.log("NEX: bitmap pool exhausted — dropping element '\(elementId)'")
                return false
            }
            fid = allocated
            canvasElements.append((key: elementId, value: CanvasElement(firmwareId: fid, isBitmap: true, rect: rect)))
            sendCanvasCommand {
                $0.canvasCreateComponent = .with {
                    $0.id = fid
                    $0.type = .canvasBitmap
                    $0.x = UInt32(max(0, x)); $0.y = UInt32(max(0, y))
                    $0.width = UInt32(max(0, width)); $0.height = UInt32(max(0, height))
                }
            }
        }

        // Stream pixels into the component: CanvasUpdateImage header, then the
        // same 0xB0 chunk transport the legacy DisplayImage path uses.
        let streamId = String(format: "%04X", Int.random(in: 0 ... 0xFFFF))
        let totalChunks = Int(ceil(Double(bmpData.count) / Double(bmpChunkSize)))
        sendCanvasCommand {
            $0.canvasUpdateImage = .with {
                $0.id = fid
                $0.streamID = streamId
                $0.totalChunks = UInt32(totalChunks)
            }
        }
        sendImageChunks(streamId: streamId, imageData: bmpData)
        return true
    }

    func removeLayoutElement(_ elementId: String, layoutId _: String?) async {
        guard let i = canvasElementIndex(elementId) else { return }
        let el = canvasElements.remove(at: i)
        sendCanvasCommand { $0.canvasDeleteComponent = .with { $0.id = el.value.firmwareId } }
    }

    private func scaledImage(_ image: UIImage, toWidth width: Int32, height: Int32) -> UIImage {
        let size = CGSize(width: CGFloat(max(1, width)), height: CGFloat(max(1, height)))
        if image.size == size { return image }
        UIGraphicsBeginImageContextWithOptions(size, false, 1)
        image.draw(in: CGRect(origin: .zero, size: size))
        let out = UIGraphicsGetImageFromCurrentImageContext() ?? image
        UIGraphicsEndImageContext()
        return out
    }

    func showDashboard() {
        exit()
    }

    func setDashboardPosition(_ height: Int, _ depth: Int) {
        // Same order as Android MentraNex: display_height then display_distance.
        updateGlassesDisplayHeight(height)
        updateGlassesDisplayDistance(depth: depth)
    }

    func setDashboardHeightOnly(_ height: Int) {
        updateGlassesDisplayHeight(height)
    }

    func setDashboardDepthOnly(_ depth: Int) {
        updateGlassesDisplayDistance(depth: depth)
    }

    func setHeadUpAngle(_ angle: Int) {
        updateGlassesHeadUpAngle(angle)
    }

    func getBatteryStatus() {
        queryBatteryStatus()
    }

    func setSilentMode(_: Bool) {}

    func exit() {
        queueChunks([[0x18]], waitTimeMs: 100)
    }

    func sendShutdown() {}

    func sendReboot() {}

    func sendRgbLedControl(
        requestId _: String, packageName _: String?, action _: String, color _: String?, onDurationMs _: Int,
        offDurationMs _: Int, count _: Int
    ) {}

    func forget() {
        destroy()
    }

    func connectById(_ id: String) {
        savePreferredDeviceId(id)
        connect(name: id)
    }

    func getConnectedBluetoothName() -> String? {
        peripheral?.name
    }

    func cleanup() {
        destroy()
    }

    func ping() {
        Bridge.log("NEX: ping() is host-side no-op for this transport")
    }

    func connectController() {}
    func disconnectController() {}

    func dbg1() {}
    func dbg2() {}

    func requestWifiScan(scanId _: String?) {}

    func sendWifiCredentials(_: String, _: String) {}

    func forgetWifiNetwork(_: String) {}

    func sendHotspotState(_: Bool) {}

    func sendOtaStart(otaVersionUrl: String?, otaTransport: String?) {}
    func sendOtaQueryStatus() {}

    func sendUserEmailToGlasses(_: String) {}

    func queryGalleryStatus() {}

    @objc static func requiresMainQueueSetup() -> Bool {
        true
    }

    func sendGalleryMode() {}

    func requestVersionInfo() {
        Bridge.log("MentraNex: requestVersionInfo - not supported on MentraNex")
    }

    // MARK: - Properties

    private var centralManager: CBCentralManager?

    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var notifyCharacteristic: CBCharacteristic?
    private var _isScanning = false
    private var isConnecting = false
    private var nexReady = false
    private var isDisconnecting = false
    private var reconnectionTimer: Timer?
    private var reconnectionAttempts = 0
    private let maxReconnectionAttempts = -1 // -1 for unlimited
    private let reconnectionInterval: TimeInterval = 2.0
    private var peripheralToConnectName: String?
    /// True while the current scan is a user-initiated discovery scan (the "scan for devices"
    /// list). Discovery must NOT short-circuit into reconnecting the last paired device by
    /// stored UUID / saved name — otherwise, once a device has been connected, every later
    /// discovery scan silently reconnects the old glasses instead of listing nearby devices.
    private var isDiscoveryScan = false
    private let INITIAL_CONNECTION_DELAY_MS: UInt64 = 350
    private let DELAY_BETWEEN_CHUNKS_SEND_MS: UInt64 = 10

    // Heartbeat tracking (like Java implementation)
    private var heartbeatCount = 0
    private var lastHeartbeatSentTime: TimeInterval = 0
    private var lastHeartbeatReceivedTime: TimeInterval = 0

    // Microphone beat system (like Java implementation)
    private var micBeatTimer: Timer?
    private var micBeatCount = 0
    private let MICBEAT_INTERVAL_MS: TimeInterval = 30 * 60 // 30 minutes like Java
    private var shouldUseGlassesMic = true
    private var isMicrophoneEnabled = true
    private var microphoneStateBeforeDisconnection = false

    // Whitelist system (like Java implementation)
    private var whiteListedAlready = false
    private let WHITELIST_CMD: UInt8 = 0x04

    /// Protobuf version tracking (like Java implementation)
    private var protobufVersionPosted = false

    /// Device discovery cache (like MentraLive)
    private var discoveredPeripherals = [String: CBPeripheral]() // name -> peripheral
    private var lastConnectionTimestamp: TimeInterval = 0
    private var lastReceivedLc3Sequence = -1
    private var currentImageChunks: [[UInt8]] = []
    private var isImageSendProgressing = false
    private var servicesReady = false
    private var serviceReadyWaiters: [CheckedContinuation<Void, Never>] = []
    private var pendingWriteContinuation: CheckedContinuation<Void, Never>?
    // Separate from pendingWriteContinuation (which is flow-control for
    // .withoutResponse): this one is resumed by didWriteValueFor, i.e. the ATT
    // ack for a .withResponse write. Kept distinct so a peripheralIsReady
    // flow-control callback can't spuriously resume an in-flight acked write.
    private var pendingAckContinuation: CheckedContinuation<Void, Never>?

    // MARK: - Published Properties (G1-compatible)

    @Published var vadActive: Bool = false
    @Published var deviceReady: Bool = false

    // Audio properties (G1-compatible)
    @Published var compressedVoiceData: Data = .init()
    @Published var aiListening: Bool = false

    // Device info properties
    @Published var deviceFirmwareVersion: String = ""
    @Published var deviceHardwareModel: String = ""

    // IMU data properties
    @Published var accelerometer: [Float] = [0.0, 0.0, 0.0]
    @Published var gyroscope: [Float] = [0.0, 0.0, 0.0]
    @Published var magnetometer: [Float] = [0.0, 0.0, 0.0]

    // Button state properties
    @Published var lastButtonPressed: Int = -1
    @Published var lastButtonState: String = ""

    // Head gesture properties
    @Published var lastHeadGesture: String = ""
    @Published var headUpAngle: Int = 0

    // Enhanced device persistence (from Java implementation)
    private let PREFS_DEVICE_NAME = "MentraNexLastConnectedDeviceName"
    private let PREFS_DEVICE_ADDRESS = "MentraNexLastConnectedDeviceAddress"
    private let PREFS_DEVICE_ID = "SavedNexIdKey"
    private let SHARED_PREFS_NAME = "NexGlassesPrefs"

    // Device state tracking (ported from Java)
    private var savedDeviceName: String?
    private var savedDeviceAddress: String?
    private var preferredDeviceId: String?
    private var isKilled = false
    private var scanOnPowerOn = false

    private let bluetoothQueue = DispatchQueue(label: "MentraNexBluetooth", qos: .userInitiated)

    /// Protocol-required connectionState (String)
    var connectionState: String = ConnTypes.DISCONNECTED

    // Protocol-required properties
    var type: String = DeviceTypes.NEX
    var ready: Bool {
        get { nexReady }
        set { nexReady = newValue }
    }

    var hasMic: Bool = true

    private var peripheralUUID: UUID? {
        get {
            if let uuidString = UserDefaults.standard.string(forKey: "nexPeripheralUUID") {
                return UUID(uuidString: uuidString)
            }
            return nil
        }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue.uuidString, forKey: "nexPeripheralUUID")
            } else {
                UserDefaults.standard.removeObject(forKey: "nexPeripheralUUID")
            }
        }
    }

    /// Custom Bluetooth queue for better performance (like G1)
    private static let _bluetoothQueue = DispatchQueue(
        label: "com.mentra.nex.bluetooth", qos: .background
    )

    static var instance: MentraNexSGC?

    // MARK: - Singleton Access

    @objc static func getInstance() -> MentraNexSGC {
        if let existing = instance, existing.centralManager != nil {
            return existing
        }
        instance = MentraNexSGC()
        return instance!
    }

    // UUIDs from MentraNexSGC.java
    private let MAIN_SERVICE_UUID = CBUUID(string: "00004860-0000-1000-8000-00805f9b34fb")
    private let WRITE_CHAR_UUID = CBUUID(string: "000071FF-0000-1000-8000-00805f9b34fb")
    private let NOTIFY_CHAR_UUID = CBUUID(string: "000070FF-0000-1000-8000-00805f9b34fb")

    // Packet types from MentraNexSGC.java
    private let PACKET_TYPE_JSON: UInt8 = 0x01
    private let PACKET_TYPE_PROTOBUF: UInt8 = 0x02
    private let PACKET_TYPE_AUDIO: UInt8 = 0xA0
    private let PACKET_TYPE_IMAGE: UInt8 = 0xB0

    // MTU Configuration (iOS-optimized)
    private let MTU_MAX_IOS = 185 // iOS maximum (platform limitation)
    private let MTU_DEFAULT = 23 // Default BLE MTU
    private var currentMTU = 23 // Currently negotiated MTU
    private var deviceMaxMTU = 23 // Device's maximum capability
    private var maxChunkSize = 176 // Calculated optimal chunk size
    private var bmpChunkSize = 176 // Image chunk size (iOS-optimized)
    private var protobufSeq: UInt8 = 0 // Rolling sequence for fragmented control messages

    // MARK: - Command Queue (modeled after ERG1Manager)

    private struct BufferedCommand {
        let chunks: [[UInt8]]
        let waitTimeMs: Int
        let chunkDelayMs: Int
        // true → fragments written .withResponse (firmware ATT-acks each, worker
        // waits for the ack before the next). false → .withoutResponse (captions):
        // fire-and-forget for throughput, newest caption supersedes the last.
        let ack: Bool

        init(chunks: [[UInt8]], waitTimeMs: Int = 0, chunkDelayMs: Int = 8, ack: Bool = true) {
            self.chunks = chunks
            self.waitTimeMs = waitTimeMs
            self.chunkDelayMs = chunkDelayMs
            self.ack = ack
        }
    }

    private actor CommandQueue {
        private var commands: [BufferedCommand] = []
        private var continuations: [CheckedContinuation<BufferedCommand, Never>] = []

        func enqueue(_ command: BufferedCommand) {
            if let continuation = continuations.first {
                continuations.removeFirst()
                continuation.resume(returning: command)
            } else {
                commands.append(command)
            }
        }

        func dequeue() async -> BufferedCommand {
            if let command = commands.first {
                commands.removeFirst()
                return command
            }

            return await withCheckedContinuation { continuation in
                continuations.append(continuation)
            }
        }

        func clear() {
            commands.removeAll()
        }
    }

    private let commandQueue = CommandQueue()
    private var isQueueWorkerRunning = false

    // MARK: - Text wall coalescing (G2-style)

    // Captions arrive per interim transcript (several/sec while speaking) but are
    // only worth showing if they're the freshest text. A single latest-wins slot +
    // a 100 ms drain ticker caps glasses-bound text writes at 10/sec and discards
    // stale interim results instead of queueing them. Without this, continuous
    // speech while the phone is locked backlogs the FIFO commandQueue (drain slows
    // at relaxed connection intervals) and the app does unbounded background work.
    // Mirrors G2's pendingTextMsg/drainEvenHubQueue. One repair resend covers a
    // dropped final caption (writes are no-ack); mid-stream drops are repaired by
    // the next update anyway.
    private let textWallLock = NSLock()
    private var pendingTextWall: Data?
    private var lastTextWall: Data?
    private var textWallResendsRemaining = 0
    private let TEXT_WALL_RESEND_COUNT = 1
    private var textWallDrainTask: Task<Void, Never>?

    // MARK: - Initialization

    override private init() {
        super.init()
        Bridge.log("NEX: 🚀 MentraNexSGC initialization started")

        // Load saved device information (from Java implementation)
        loadSavedDeviceInfo()

        // Using custom Bluetooth queue for better performance (like G1)
        Bridge.log("NEX: 📱 Creating CBCentralManager with custom Bluetooth queue")
        centralManager = CBCentralManager(delegate: self, queue: MentraNexSGC._bluetoothQueue)

        Bridge.log("NEX: ✅ MentraNexSGC initialization completed")
        Bridge.log("NEX: 📱 Central Manager created: \(centralManager != nil ? "YES" : "NO")")
        if let centralManager {
            Bridge.log("NEX: 📱 Initial Bluetooth State: \(centralManager.state.rawValue)")
        }

        Bridge.log(
            "NEX: 💾 Loaded saved device - Name: \(savedDeviceName ?? "None"), Address: \(savedDeviceAddress ?? "None")"
        )
        DeviceStore.shared.apply("glasses", "micEnabled", false)
    }

    private func setupCommandQueue() {
        if isQueueWorkerRunning { return }
        isQueueWorkerRunning = true

        Task.detached { [weak self] in
            guard let self else { return }
            while true {
                let command = await self.commandQueue.dequeue()
                await self.processCommand(command)
            }
        }
    }

    private func queueChunks(_ chunks: [[UInt8]], waitTimeMs: Int = 0, chunkDelayMs: Int = 10, ack: Bool = true) {
        let cmd = BufferedCommand(
            chunks: chunks, waitTimeMs: waitTimeMs, chunkDelayMs: chunkDelayMs, ack: ack
        )
        Task { [weak self] in
            await self?.commandQueue.enqueue(cmd)
        }
    }

    private func waitUntilServicesReady() async {
        if servicesReady {
            return
        }
        await withCheckedContinuation { continuation in
            serviceReadyWaiters.append(continuation)
        }
    }

    private func setServicesReady(_ ready: Bool) {
        servicesReady = ready
        guard ready else { return }
        releaseServiceWaiters()
    }

    private func releaseServiceWaiters() {
        let waiters = serviceReadyWaiters
        serviceReadyWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    /// Suspends until CoreBluetooth signals it can accept another write-without-response
    /// (resumed by peripheralIsReady(toSendWriteWithoutResponse:), or by the disconnect
    /// handlers so an in-flight send can't wedge the queue across a drop).
    private func waitUntilReadyToWrite() async {
        await withCheckedContinuation { continuation in
            pendingWriteContinuation = continuation
        }
    }

    private func resumePendingWrite() {
        pendingWriteContinuation?.resume()
        pendingWriteContinuation = nil
    }

    /// Suspends until the ATT ack for a .withResponse write arrives (resumed by
    /// didWriteValueFor, or by the disconnect handlers so an in-flight acked
    /// write can't wedge the queue across a drop).
    private func waitUntilAcked() async {
        await withCheckedContinuation { continuation in
            pendingAckContinuation = continuation
        }
    }

    private func resumePendingAck() {
        pendingAckContinuation?.resume()
        pendingAckContinuation = nil
    }

    private func emitBleCommandSent(_ packetData: Data) {
        guard packetData.first == PACKET_TYPE_PROTOBUF else { return }
        guard packetData.count > 1 else { return }
        let payload = packetData.subdata(in: 1 ..< packetData.count)
        let commandName: String
        if let phoneToGlasses = try? Mentraos_Ble_PhoneToGlasses(serializedData: payload) {
            commandName = String(describing: phoneToGlasses.payload)
        } else {
            commandName = "UNKNOWN"
        }
        Bridge.sendTypedMessage("send_command_to_ble", body: [
            "command": commandName,
            "commandText": packetData.toHexString(),
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ])
    }

    private func emitBleCommandReceived(_ packetData: Data, payloadDescription: String) {
        Bridge.sendTypedMessage("receive_command_from_ble", body: [
            "command": payloadDescription,
            "commandText": packetData.toHexString(),
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ])
    }

    /// Splits a serialized protobuf message into BLE-sized fragments, each prefixed with a
    /// 4-byte transport header [packetType][seq][totalChunks][chunkIndex] so the firmware can
    /// reassemble messages larger than one MTU. Single-fragment messages set totalChunks = 1
    /// and are decoded directly by the firmware's fast path.
    private func queueDataWithOptimalChunking(
        _ data: Data, packetType: UInt8 = 0x02, waitTimeMs: Int = 0, emitTelemetry: Bool = true, ack: Bool = true
    ) {
        // Telemetry: report the full logical command (type byte + protobuf) before fragmenting.
        // Callers on high-rate paths (caption text walls, up to 10/sec) pass
        // emitTelemetry: false — emitBleCommandSent re-parses the protobuf,
        // hex-dumps the packet, and crosses to the JS thread per call.
        if emitTelemetry {
            var packetData = Data([packetType])
            packetData.append(data)
            emitBleCommandSent(packetData)
        }

        let headerSize = 4 // [packetType][seq][totalChunks][chunkIndex]
        let effectiveChunkSize = max(1, maxChunkSize - headerSize)
        let totalChunks = data.isEmpty
            ? 1 : Int(ceil(Double(data.count) / Double(effectiveChunkSize)))

        guard totalChunks <= 255 else {
            Bridge.log(
                "NEX: ❌ Protobuf message too large to fragment (\(totalChunks) chunks) - dropping"
            )
            return
        }

        let seq = protobufSeq
        protobufSeq = protobufSeq &+ 1

        var chunks: [[UInt8]] = []
        var offset = 0
        var index = 0
        while offset < data.count || (index == 0 && data.isEmpty) {
            let end = min(offset + effectiveChunkSize, data.count)
            var frame: [UInt8] = [packetType, seq, UInt8(totalChunks), UInt8(index)]
            if end > offset {
                frame.append(contentsOf: data.subdata(in: offset ..< end))
            }
            chunks.append(frame)
            offset = end
            index += 1
        }

        // No per-send log: fires for every outbound message (up to 10/sec text
        // walls during captions).
        // Bridge.log(
        //     "NEX: 📦 Fragmented protobuf into \(chunks.count) chunk(s) (seq=\(seq), max payload \(effectiveChunkSize) bytes)"
        // )
        queueChunks(chunks, waitTimeMs: waitTimeMs, ack: ack)
    }

    private func processCommand(_ command: BufferedCommand) async {
        guard let peripheral, let writeCharacteristic else {
            Bridge.log("NEX: ⚠️ processCommand: peripheral/characteristic not ready")
            return
        }

        await waitUntilServicesReady()

        // Send each chunk sequentially
        for (index, chunk) in command.chunks.enumerated() {
            // let timeSinceConnection = Date().timeIntervalSince1970 * 1000 - lastConnectionTimestamp
            // if timeSinceConnection < Double(INITIAL_CONNECTION_DELAY_MS) {
            //     let remainingMs = UInt64(Double(INITIAL_CONNECTION_DELAY_MS) - timeSinceConnection)
            //     try? await Task.sleep(nanoseconds: remainingMs * 1_000_000)
            // }
            let data = Data(chunk)
            // Bridge.log(
            //     "NEX: 📦 Sending chunk \(index) of \(command.chunks.count) to \(peripheral.name ?? "Unknown")"
            // )
            // Bridge.log("NEX: 📦 Chunk data: \(data.toHexString())")
            if command.ack {
                // Acked path (everything except captions): write WITH response so the
                // firmware ATT-acks each fragment, then wait for that ack
                // (didWriteValueFor) before sending the next — reliable delivery, one
                // outstanding write at a time.
                peripheral.writeValue(data, for: writeCharacteristic, type: .withResponse)
                await waitUntilAcked()
            } else {
                // Captions: write WITHOUT response. A write-with-response is one
                // outstanding request gated on a remote round trip, which puts the
                // (screen-off-throttled) app thread in the path of every fragment and
                // makes captions crawl in the background. .withoutResponse lets
                // CoreBluetooth batch fragments into connection events; the newest
                // caption supersedes the last, so a dropped fragment self-heals.
                peripheral.writeValue(data, for: writeCharacteristic, type: .withoutResponse)
            }

            // // Delay between chunks except maybe after the last chunk if waitTime will handle it
            // if index < command.chunks.count - 1 {
            //     try? await Task.sleep(nanoseconds: UInt64(command.chunkDelayMs) * 1_000_000)
            // }
            // try? await Task.sleep(nanoseconds: DELAY_BETWEEN_CHUNKS_SEND_MS * 1_000_000)
        }

        // Optional wait after the command
        if command.waitTimeMs > 0 {
            try? await Task.sleep(nanoseconds: UInt64(command.waitTimeMs) * 1_000_000)
        }
    }

    // MARK: - Device Persistence (ported from Java)

    private func loadSavedDeviceInfo() {
        savedDeviceName = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME)
        savedDeviceAddress = UserDefaults.standard.string(forKey: PREFS_DEVICE_ADDRESS)
        preferredDeviceId = UserDefaults.standard.string(forKey: PREFS_DEVICE_ID)

        Bridge.log(
            "NEX: 💾 Loaded device info - Name: \(savedDeviceName ?? "None"), Address: \(savedDeviceAddress ?? "None"), ID: \(preferredDeviceId ?? "None")"
        )
    }

    private func savePairedDeviceInfo(name: String?, address: String?) {
        if let name {
            UserDefaults.standard.set(name, forKey: PREFS_DEVICE_NAME)
            savedDeviceName = name
            Bridge.log("NEX: 💾 Saved device name: \(name)")
        }

        if let address {
            UserDefaults.standard.set(address, forKey: PREFS_DEVICE_ADDRESS)
            savedDeviceAddress = address
            Bridge.log("NEX: 💾 Saved device address: \(address)")
        }
    }

    @objc func savePreferredDeviceId(_ deviceId: String) {
        UserDefaults.standard.set(deviceId, forKey: PREFS_DEVICE_ID)
        preferredDeviceId = deviceId
        Bridge.log("NEX: 💾 Saved preferred device ID: \(deviceId)")
    }

    @objc func clearSavedDeviceInfo() {
        UserDefaults.standard.removeObject(forKey: PREFS_DEVICE_NAME)
        UserDefaults.standard.removeObject(forKey: PREFS_DEVICE_ADDRESS)
        UserDefaults.standard.removeObject(forKey: PREFS_DEVICE_ID)

        savedDeviceName = nil
        savedDeviceAddress = nil
        preferredDeviceId = nil
        peripheralUUID = nil

        Bridge.log("NEX: 🗑️ Cleared all saved device information")
    }

    // MARK: - Enhanced Device Filtering (ported from Java)

    private func isCompatibleNexDevice(_ deviceName: String) -> Bool {
        // Keep in parity with Android MentraNex.kt scan filter.
        let compatiblePrefixes = [
            "Nex1-",
            "MENTRA_DISPLAY_",
        ]

        for prefix in compatiblePrefixes {
            if deviceName.contains(prefix) {
                Bridge.log("NEX: ✅ Device '\(deviceName)' matches compatible prefix: \(prefix)")
                return true
            }
        }

        return false
    }

    private func extractDeviceId(from deviceName: String) -> String? {
        // Extract device ID pattern similar to Java implementation
        let patterns = [
            "Mentra_([0-9A-Fa-f]+)",
            "NEX_([0-9A-Fa-f]+)",
            "MENTRA_NEX_([0-9A-Fa-f]+)",
            "MENTRA_DISPLAY_([0-9A-Fa-f]+)",
        ]

        for pattern in patterns {
            let regex = try? NSRegularExpression(pattern: pattern)
            let range = NSRange(deviceName.startIndex ..< deviceName.endIndex, in: deviceName)
            if let match = regex?.firstMatch(in: deviceName, options: [], range: range),
               let matchRange = Range(match.range(at: 1), in: deviceName)
            {
                let deviceId = String(deviceName[matchRange])
                Bridge.log("NEX: 🏷️ Extracted device ID: \(deviceId) from \(deviceName)")
                return deviceId
            }
        }

        Bridge.log("NEX: ⚠️ Could not extract device ID from: \(deviceName)")
        return nil
    }

    // MARK: - Connection Logic (enhanced from G1)

    @objc(connectByName:)
    func connect(name: String) {
        Bridge.log("NEX-CONN: 🔗 connect(name:) called with \(name)")
        if _isScanning {
            stopScan()
        }
        peripheralToConnectName = name
        isDiscoveryScan = false
        startScan()
    }

    private func connectByUUID() -> Bool {
        guard let uuid = peripheralUUID else {
            Bridge.log("NEX-CONN: 🔵 No stored UUID to connect by.")
            return false
        }

        guard let centralManager else {
            Bridge.log("NEX-CONN: ❌ Central Manager is nil, cannot connect by UUID.")
            return false
        }

        Bridge.log(
            "NEX-CONN: 🔵 Attempting to retrieve peripheral with stored UUID: \(uuid.uuidString)"
        )
        let peripherals = centralManager.retrievePeripherals(withIdentifiers: [uuid])

        guard let peripheralToConnect = peripherals.first else {
            Bridge.log(
                "NEX-CONN: 🔵 Could not find peripheral for stored UUID. Will proceed to scan."
            )
            return false
        }

        // The stored UUID is a single "last connected" identifier. When the caller is
        // targeting a specific device by name, only take this fast-path if the cached
        // peripheral IS that device — otherwise we'd silently reconnect the *previously*
        // paired glasses, and since iOS's connect() never times out and startScan()
        // returns early on success, pairing the new device would hang forever.
        // (Mirrors Android, which reconnects to the target device's own address, never a
        // global "last" one. peripheralToConnectName == nil means an auto-reconnect with no
        // specific target, so the cached device is exactly what we want — keep using it.)
        if let targetName = peripheralToConnectName,
           !(peripheralToConnect.name?.contains(targetName) ?? false)
        {
            Bridge.log(
                "NEX-CONN: 🔵 Stored UUID is '\(peripheralToConnect.name ?? "unnamed")' but target is '\(targetName)'. Skipping UUID fast-path; will scan for the target."
            )
            return false
        }

        Bridge.log(
            "NEX-CONN: 🔵 Found peripheral by UUID: \(peripheralToConnect.name ?? "Unknown"). Initiating connection."
        )
        peripheral = peripheralToConnect
        centralManager.connect(peripheralToConnect, options: nil)
        return true
    }

    private func startReconnectionTimer() {
        Bridge.log("NEX-CONN: 🔄 Starting reconnection timer...")
        stopReconnectionTimer() // Ensure no existing timer is running
        reconnectionAttempts = 0

        DispatchQueue.main.async {
            self.reconnectionTimer = Timer.scheduledTimer(
                timeInterval: self.reconnectionInterval,
                target: self,
                selector: #selector(self.attemptReconnection),
                userInfo: nil,
                repeats: true
            )
        }
    }

    private func stopReconnectionTimer() {
        if reconnectionTimer != nil {
            Bridge.log("NEX-CONN: 🛑 Stopping reconnection timer.")
            reconnectionTimer?.invalidate()
            reconnectionTimer = nil
        }
    }

    @objc private func attemptReconnection() {
        if nexReady {
            Bridge.log("NEX-CONN: ✅ Already connected, stopping reconnection attempts.")
            stopReconnectionTimer()
            return
        }

        if maxReconnectionAttempts != -1, reconnectionAttempts >= maxReconnectionAttempts {
            Bridge.log("NEX-CONN: ❌ Max reconnection attempts reached.")
            stopReconnectionTimer()
            return
        }

        reconnectionAttempts += 1
        Bridge.log("NEX-CONN: 🔄 Attempting reconnection (\(reconnectionAttempts))...")
        isDiscoveryScan = false
        startScan()
    }

    // MARK: - Public Methods

    private func startScan() {
        Bridge.log("NEX-CONN: 🔍 startScan called")

        isDisconnecting = false // Reset intentional disconnect flag

        guard let centralManager else {
            Bridge.log("NEX-CONN: ❌ Central Manager is nil!")
            return
        }

        guard centralManager.state == .poweredOn else {
            Bridge.log(
                "NEX-CONN: ❌ Bluetooth not powered on. State: \(centralManager.state.rawValue)"
            )
            return
        }

        // Reconnect short-circuits below are for the targeted connect/reconnect paths only.
        // A user-initiated discovery scan must fall through to scanForPeripherals so the
        // device list populates even after we've previously paired (which persisted a UUID).
        if !isDiscoveryScan {
            // First, try to reconnect using stored UUID (faster and works in background)
            if connectByUUID() {
                Bridge.log("NEX-CONN: 🔄 Attempting connection with stored UUID. Halting scan.")
                return
            }

            // If that fails, check for already-connected system devices
            let connectedPeripherals = centralManager.retrieveConnectedPeripherals(withServices: [
                MAIN_SERVICE_UUID,
            ])
            if let targetName = peripheralToConnectName,
               let existingPeripheral = connectedPeripherals.first(where: {
                   $0.name?.contains(targetName) == true
               })
            {
                Bridge.log(
                    "NEX-CONN: 📱 Found already connected peripheral that matches target: \(existingPeripheral.name ?? "Unknown")"
                )
                if peripheral == nil {
                    peripheral = existingPeripheral
                    centralManager.connect(existingPeripheral, options: nil)
                    return
                }
            }

            // Check if we have a saved device name to reconnect to (like MentraLive)
            if let savedDeviceName = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME),
               !savedDeviceName.isEmpty
            {
                Bridge.log("NEX-CONN: 🔄 Looking for saved device: \(savedDeviceName)")
                // This will be handled in didDiscover when the device is found
            }
        }

        Bridge.log("NEX-CONN: ✅ Bluetooth is powered on, starting scan...")
        _isScanning = true
        connectionState = ConnTypes.SCANNING
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.SCANNING)

        // Scan for ALL devices, not just those with specific services
        // Use same options as G1 scanner for consistency
        let scanOptions: [String: Any] = [
            CBCentralManagerScanOptionAllowDuplicatesKey: false, // Don't allow duplicate advertisements
        ]
        centralManager.scanForPeripherals(withServices: nil, options: scanOptions)

        Bridge.log("NEX-CONN: 🚀 Scan started successfully")

        // Re-emit already discovered peripherals (like MentraLive)
        for (_, peripheral) in discoveredPeripherals {
            Bridge.log(
                "NEX-CONN: 📡 (Re-emitting from cache) peripheral: \(peripheral.name ?? "Unknown")"
            )
            if let name = peripheral.name {
                emitDiscoveredDevice(name)
            }
        }

        // No auto-stop timer (like G1) - manual control
        Bridge.log("NEX-CONN: 💡 To stop scanning manually, call: MentraNexSGC.shared.stopScan()")
    }

    @objc func stopScan() {
        centralManager?.stopScan()
        _isScanning = false
        // The flag describes the scan that's currently running; once it stops (10s discovery
        // timeout, manual stop, or the stop inside connect()), clear it so a later
        // reconnect/autoconnect scan isn't wrongly treated as discovery and suppressed.
        isDiscoveryScan = false
        Bridge.log("NEX-CONN: 🛑 Stopped scanning.")
    }

    @objc func isScanning() -> Bool {
        _isScanning
    }

    @objc func isConnected() -> Bool {
        nexReady && connectionState == ConnTypes.CONNECTED
    }

    @objc func getConnectionState() -> String {
        switch connectionState {
        case ConnTypes.DISCONNECTED:
            return "disconnected"
        case ConnTypes.CONNECTING:
            return "connecting"
        case ConnTypes.CONNECTED:
            return "connected"
        case ConnTypes.SCANNING:
            return "scanning"
        default:
            return "disconnected"
        }
    }

    // MARK: - MTU Information Access

    @objc func getCurrentMTU() -> Int {
        currentMTU
    }

    @objc func getMaxChunkSize() -> Int {
        maxChunkSize
    }

    @objc func getDeviceMaxMTU() -> Int {
        deviceMaxMTU
    }

    @objc func getMTUInfo() -> [String: Any] {
        [
            "current_mtu": currentMTU,
            "device_max_mtu": deviceMaxMTU,
            "max_chunk_size": maxChunkSize,
            "bmp_chunk_size": bmpChunkSize,
            "mtu_negotiated": nexReady,
        ]
    }

    @objc func findCompatibleDevices() {
        Bridge.log("NEX-DISCOVERY: Finding compatible devices.")

        // Clear specific connect target, but keep saved pairing data like Android.
        peripheralToConnectName = nil
        // Pure discovery: don't let startScan short-circuit into reconnecting the last
        // paired device, and don't auto-connect a saved device found mid-scan.
        isDiscoveryScan = true

        Task {
            if centralManager == nil {
                centralManager = CBCentralManager(
                    delegate: self, queue: bluetoothQueue,
                    options: ["CBCentralManagerOptionShowPowerAlertKey": 0]
                )
                // wait for the central manager to be fully initialized before we start scanning:
                try? await Task.sleep(nanoseconds: 100 * 1_000_000) // 100ms
            }

            if centralManager?.state == .poweredOn {
                startScan()
                DispatchQueue.main.asyncAfter(deadline: .now() + 10.0) { [weak self] in
                    self?.stopScan()
                }
            } else {
                Bridge.log("NEX-DISCOVERY: Bluetooth not ready, will scan on power on.")
                scanOnPowerOn = true
            }
        }
    }

    // Characters the Nex font can render: letters, digits, whitespace, and a small
    // punctuation set. Everything else (CJK, emoji, smart quotes, …) is stripped when
    // Chinese captions are off. Matches UNSUPPORTED_GLYPH_REGEX in NexSGCUtils.kt.
    private static let unsupportedGlyphPattern = #"[^A-Za-z0-9 \r\n\.,!\?;:\-\[\]\(\)\{\}'"\+=/]"#

    /// Sanitize text bound for the glasses. When Chinese captions are disabled (the
    /// default) the Nex font can't render CJK/emoji/etc., so em-dashes are normalised
    /// to hyphens and unsupported glyphs are dropped; when enabled, text passes through
    /// untouched. Every text path to the display funnels through here so captions and
    /// layout text filter identically. Mirrors sanitizeDisplayText in NexSGCUtils.kt.
    private func sanitizeDisplayText(_ text: String) -> String {
        let chineseCaptionsEnabled = DeviceStore.shared.get("bluetooth", "nex_chinese_captions") as? Bool ?? false
        if chineseCaptionsEnabled { return text }
        let normalized = text.replacingOccurrences(of: "—", with: "-")
        return normalized.replacingOccurrences(
            of: MentraNexSGC.unsupportedGlyphPattern, with: "", options: .regularExpression
        )
    }

    func sendTextWall(_ text: String) async {
        guard nexReady else {
            Bridge.log("NEX: Not ready to display text. Device not initialized.")
            return
        }

        // sanitizeDisplayText applies the Chinese-captions gate internally: off (default)
        // strips glyphs the Nex font can't render, on passes the text through unmodified.
        let sanitizedText = sanitizeDisplayText(text)
        // No per-call log: this runs for every interim transcript (several/sec
        // during continuous speech) and each Bridge.log costs the JS thread.
        // Bridge.log("NEX: Displaying text wall: '\(sanitizedText)'")

        let displayText = Mentraos_Ble_DisplayText.with {
            $0.text = sanitizedText
            $0.size = 48
            $0.x = 20
            $0.y = 260
            $0.color = 10000
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.displayText = displayText
        }

        let protobufData = try! phoneToGlasses.serializedData()
        // Latest-wins: overwrite the pending slot; the 100 ms drain ticker sends it.
        // Do NOT enqueue on commandQueue — that's what backlogs under continuous speech.
        textWallLock.lock()
        pendingTextWall = protobufData
        textWallLock.unlock()
    }

    private func startTextWallDrain() {
        textWallDrainTask?.cancel()
        textWallDrainTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled else { break }
                self?.drainPendingTextWall()
            }
        }
    }

    private func stopTextWallDrain() {
        textWallDrainTask?.cancel()
        textWallDrainTask = nil
        textWallLock.lock()
        pendingTextWall = nil
        lastTextWall = nil
        textWallResendsRemaining = 0
        textWallLock.unlock()
    }

    private func drainPendingTextWall() {
        textWallLock.lock()
        let msg = pendingTextWall
        pendingTextWall = nil
        var toSend: Data?
        if let msg {
            lastTextWall = msg
            textWallResendsRemaining = TEXT_WALL_RESEND_COUNT
            toSend = msg
        } else if textWallResendsRemaining > 0, let last = lastTextWall {
            textWallResendsRemaining -= 1
            toSend = last
        }
        textWallLock.unlock()
        guard let toSend else { return }
        // Captions go out unacked (.withoutResponse) for throughput; every other
        // command uses acked writes. Mirrors MentraNex.kt.
        queueDataWithOptimalChunking(toSend, packetType: PACKET_TYPE_PROTOBUF, emitTelemetry: false, ack: false)
    }

    @objc func displayTextLine(_ text: String) {
        Task { await sendTextWall(text) }
    }

    @objc func displayDoubleTextWall(_ textTop: String, textBottom: String) {
        let combinedText = "\(textTop)\n\(textBottom)"
        Task { await sendTextWall(combinedText) }
    }

    @objc func displayReferenceCardSimple(_ title: String, body: String) {
        let combinedText = "\(title)\n\n\(body)"
        Task { await sendTextWall(combinedText) }
    }

    @objc func displayRowsCard(_ rowStrings: [String]) {
        let combinedText = rowStrings.joined(separator: "\n")
        Task { await sendTextWall(combinedText) }
    }

    @objc func displayBulletList(_ title: String, bullets: [String]) {
        var text = title
        if !title.isEmpty {
            text += "\n"
        }
        text += bullets.map { "• \($0)" }.joined(separator: "\n")
        Task { await sendTextWall(text) }
    }

    @objc func displayScrollingText(_ text: String) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to display scrolling text. Device not initialized.")
            return
        }

        Bridge.log("NEX: Displaying scrolling text: '\(text)'")

        let displayScrollingText = Mentraos_Ble_DisplayScrollingText.with {
            $0.text = text
            $0.size = 48
            $0.x = 20
            $0.y = 50
            $0.width = 200
            $0.height = 100
            $0.speed = 50
            $0.pauseMs = 10
            $0.loop = true
            $0.align = .center
            $0.lineSpacing = 2
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.displayScrollingText = displayScrollingText
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    // MARK: - Display Image Commands

    @objc func displayBitmap(_ bitmap: UIImage) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to display bitmap. Device not initialized.")
            return
        }

        Bridge.log("NEX: Displaying bitmap image")

        // Convert UIImage to raw bitmap data
        guard let bmpData = convertUIImageToBmpData(bitmap) else {
            Bridge.log("NEX: Failed to convert UIImage to BMP data")
            return
        }

        displayBitmapData(bmpData, width: Int(bitmap.size.width), height: Int(bitmap.size.height))
    }

    @objc func displayBitmapFromData(_ bmpData: Data, width: Int, height: Int) {
        displayBitmapData(bmpData, width: width, height: height)
    }

    private func displayBitmapData(_ bmpData: Data, width: Int, height: Int) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to display bitmap data. Device not initialized.")
            return
        }

        Bridge.log("NEX: Displaying bitmap data (\(bmpData.count) bytes, \(width)x\(height))")

        // Generate stream ID for image transfer
        let streamId = String(format: "%04X", Int.random(in: 0 ... 0xFFFF))
        let totalChunks = Int(ceil(Double(bmpData.count) / Double(bmpChunkSize)))

        // Send display image command first
        let displayImage = Mentraos_Ble_DisplayImage.with {
            $0.streamID = streamId
            $0.totalChunks = UInt32(totalChunks)
            $0.x = 0
            $0.y = 0
            $0.width = UInt32(width)
            $0.height = UInt32(height)
            $0.encoding = "raw"
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.msgID = "img_start_1"
            $0.displayImage = displayImage
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(
            protobufData, packetType: PACKET_TYPE_PROTOBUF, waitTimeMs: 100
        )

        // Send image chunks
        sendImageChunks(streamId: streamId, imageData: bmpData)
    }

    private func sendImageChunks(streamId: String, imageData: Data) {
        let streamIdInt = Int(streamId, radix: 16) ?? 0
        let totalChunks = Int(ceil(Double(imageData.count) / Double(bmpChunkSize)))

        var chunks: [[UInt8]] = []

        for i in 0 ..< totalChunks {
            let start = i * bmpChunkSize
            let end = min(start + bmpChunkSize, imageData.count)
            let chunkData = imageData.subdata(in: start ..< end)

            var header: [UInt8] = [
                PACKET_TYPE_IMAGE, // 0xB0
                UInt8((streamIdInt >> 8) & 0xFF), // Stream ID high byte
                UInt8(streamIdInt & 0xFF), // Stream ID low byte
                UInt8(i & 0xFF), // Chunk index
            ]
            header.append(contentsOf: chunkData)
            chunks.append(header)
        }

        Bridge.log("NEX: Sending \(chunks.count) image chunks")
        currentImageChunks = chunks
        isImageSendProgressing = true
        queueChunks(chunks, waitTimeMs: 50)
    }

    private func convertUIImageToBmpData(_ image: UIImage) -> Data? {
        // This is a simplified conversion - in production you'd want proper BMP encoding
        guard let cgImage = image.cgImage else { return nil }

        let width = cgImage.width
        let height = cgImage.height
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        let bitsPerComponent = 8

        var pixelData = Data(count: width * height * bytesPerPixel)

        pixelData.withUnsafeMutableBytes { bytes in
            guard
                let context = CGContext(
                    data: bytes.bindMemory(to: UInt8.self).baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: bitsPerComponent,
                    bytesPerRow: bytesPerRow,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )
            else { return }

            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        }

        return pixelData
    }

    // MARK: - Glasses-native 1-bit BMP pipeline (parity with Android's decodeBitmapForNex)

    /**
     Decode → invert → Floyd–Steinberg dither → 1-bit BMP encode, mirroring
     Android's `decodeBitmapForNex` + `BitmapJavaUtils.convertBitmapTo1BitBmpBytes`.

     The panel is 1-bpp and renders white-on-black; the firmware BMP decoder
     normalises palette polarity, so the only way to flip the on-glass result is
     to invert the actual pixel content. Dithering preserves gradients as dot
     patterns instead of a hard 50% threshold. Output byte layout matches the
     Android encoder exactly: 14-byte file header + 40-byte BITMAPINFOHEADER +
     8-byte palette (index 0 = white, 1 = black), rows padded to 4 bytes,
     bottom-to-top, bit set when the (post-invert, post-dither) pixel is dark.
     */
    private func convertImageToNex1BitBmp(_ image: UIImage) -> Data? {
        guard let cgImage = image.cgImage else { return nil }
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return nil }

        // RGBA readback.
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        guard
            let context = CGContext(
                data: &rgba,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return nil }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        // Luminance (Rec. 601), INVERTED — same order as Android (invert, then dither).
        var lum = [Float](repeating: 0, count: width * height)
        for i in 0 ..< (width * height) {
            let r = Float(rgba[i * 4])
            let g = Float(rgba[i * 4 + 1])
            let b = Float(rgba[i * 4 + 2])
            lum[i] = 255.0 - (0.299 * r + 0.587 * g + 0.114 * b)
        }

        // Floyd–Steinberg error diffusion (7/3/5/1 over 16, right/below neighbours).
        var dark = [Bool](repeating: false, count: width * height)
        for y in 0 ..< height {
            for x in 0 ..< width {
                let idx = y * width + x
                let old = lum[idx]
                let newVal: Float = old < 128 ? 0 : 255
                let err = old - newVal
                dark[idx] = newVal < 128
                if x + 1 < width { lum[idx + 1] += err * 7 / 16 }
                if y + 1 < height {
                    if x >= 1 { lum[idx + width - 1] += err * 3 / 16 }
                    lum[idx + width] += err * 5 / 16
                    if x + 1 < width { lum[idx + width + 1] += err * 1 / 16 }
                }
            }
        }

        // 1-bpp BMP encode (Android layout, invert=false palette).
        let rowSizeBytes = ((width + 31) / 32) * 4
        let imageSize = rowSizeBytes * height
        let dataOffset = 62
        var bmp = Data(capacity: dataOffset + imageSize)

        func putU16(_ v: UInt16) {
            bmp.append(UInt8(v & 0xFF)); bmp.append(UInt8(v >> 8))
        }
        func putU32(_ v: UInt32) {
            bmp.append(UInt8(v & 0xFF)); bmp.append(UInt8((v >> 8) & 0xFF))
            bmp.append(UInt8((v >> 16) & 0xFF)); bmp.append(UInt8((v >> 24) & 0xFF))
        }

        bmp.append(UInt8(ascii: "B")); bmp.append(UInt8(ascii: "M"))
        putU32(UInt32(dataOffset + imageSize)) // file size
        putU16(0); putU16(0) // reserved
        putU32(UInt32(dataOffset)) // pixel data offset
        putU32(40) // DIB header size
        putU32(UInt32(width))
        putU32(UInt32(height)) // positive => bottom-to-top
        putU16(1) // planes
        putU16(1) // bits per pixel
        putU32(0) // BI_RGB
        putU32(UInt32(imageSize))
        putU32(2835); putU32(2835) // 72 DPI
        putU32(2) // palette colors
        putU32(0) // important colors
        // Palette: index 0 = white, index 1 = black (Android invert=false).
        bmp.append(contentsOf: [0xFF, 0xFF, 0xFF, 0x00])
        bmp.append(contentsOf: [0x00, 0x00, 0x00, 0x00])

        var row = [UInt8](repeating: 0, count: rowSizeBytes)
        for y in 0 ..< height {
            let py = height - 1 - y // BMP rows are bottom-to-top
            for i in 0 ..< rowSizeBytes { row[i] = 0 }
            for x in 0 ..< width where dark[py * width + x] {
                row[x / 8] |= UInt8(0x80 >> (x % 8))
            }
            bmp.append(contentsOf: row)
        }
        return bmp
    }

    // MARK: - Display Control Commands

    @objc func clearDisplay() {
        guard nexReady else {
            Bridge.log("NEX: Not ready to clear display. Device not initialized.")
            return
        }

        Bridge.log("NEX: Clearing display")

        // Tear down any canvas components and forget the registry — clear_view
        // wipes the whole screen, canvas included.
        if !canvasElements.isEmpty || currentLayoutId != nil {
            canvasElements.removeAll()
            currentLayoutId = nil
            sendCanvasCommand { $0.canvasClear = Mentraos_Ble_CanvasClear() }
        }

        // Drop any pending/resendable text wall so a stale caption can't
        // repaint the display after this clear.
        textWallLock.lock()
        pendingTextWall = nil
        lastTextWall = nil
        textWallResendsRemaining = 0
        textWallLock.unlock()

        let clearDisplay = Mentraos_Ble_ClearDisplay()

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.msgID = "clear_disp_001"
            $0.clearDisplay_p = clearDisplay
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    @objc func blankScreen() {
        clearDisplay()
    }

    @objc func showHomeScreen() {
        Bridge.log("NEX: Showing home screen")
        clearDisplay()
    }

    @objc func exitAllFunctions() {
        guard nexReady else {
            Bridge.log("NEX: Not ready to exit functions. Device not initialized.")
            return
        }

        Bridge.log("NEX: Exiting all functions")

        // Send exit command (0x18 from Android implementation)
        let exitCommand: [UInt8] = [0x18]
        queueChunks([exitCommand], waitTimeMs: 100)
    }

    // MARK: - Configuration Commands

    @objc func updateGlassesBrightness(_ brightness: Int) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to update brightness. Device not initialized.")
            return
        }

        let validBrightness: Int
        if brightness != -1 {
            validBrightness = (max(0, min(100, brightness)) * 63) / 100
        } else {
            validBrightness = (30 * 63) / 100
        }
        Bridge.log("NEX: Setting brightness to wire value \(validBrightness)")

        let brightnessConfig = Mentraos_Ble_BrightnessConfig.with {
            $0.value = UInt32(validBrightness)
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.brightness = brightnessConfig
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    @objc func updateGlassesAutoBrightness(_ enabled: Bool) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to update auto brightness. Device not initialized.")
            return
        }

        Bridge.log("NEX: Setting auto brightness to \(enabled)")

        let autoBrightnessConfig = Mentraos_Ble_AutoBrightnessConfig.with {
            $0.enabled = enabled
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.autoBrightness = autoBrightnessConfig
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    @objc func updateGlassesHeadUpAngle(_ angle: Int) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to update head-up angle. Device not initialized.")
            return
        }

        // Validate angle range (0-60 degrees)
        let validAngle = max(0, min(60, angle))
        Bridge.log("NEX: Setting head-up angle to \(validAngle) degrees")

        let headUpAngleConfig = Mentraos_Ble_HeadUpAngleConfig.with {
            $0.angle = UInt32(validAngle)
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.headUpAngle = headUpAngleConfig
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    @objc func updateGlassesDisplayHeight(_ height: Int) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to update display height. Device not initialized.")
            return
        }

        // Validate height range (0-8)
        let validHeight = max(0, min(8, height))
        Bridge.log("NEX: Setting display height to \(validHeight)")

        let displayHeightConfig = Mentraos_Ble_DisplayHeightConfig.with {
            $0.height = UInt32(validHeight)
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.displayHeight = displayHeightConfig
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    private func updateGlassesDisplayDistance(depth: Int) {
        guard nexReady else {
            Bridge.log("NEX: Not ready to update display distance. Device not initialized.")
            return
        }

        let tier = NexDashboardDisplayWire.depthToWireTier(depth)
        Bridge.log("NEX: Setting display distance tier \(tier) in distance_cm field (dashboard depth \(depth))")

        let displayDistanceConfig = Mentraos_Ble_DisplayDistanceConfig.with {
            $0.distanceCm = tier
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.displayDistance = displayDistanceConfig
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    func sendVoiceActivityDetectionSetting() {
        let enabled = DeviceStore.shared.get("bluetooth", "voice_activity_detection_enabled") as? Bool
            ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled
        Bridge.log("NEX: 🎤 Sending Voice Activity Detection setting to glasses: \(enabled)")

        guard nexReady else {
            Bridge.log("NEX: Not ready to send VAD setting. Device not initialized.")
            return
        }

        let vadConfig = Mentraos_Ble_VadEnabledConfig.with {
            $0.enabled = enabled
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.vadEnabled = vadConfig
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
        Bridge.sendVoiceActivityDetectionStatus(enabled)
    }

    @objc func setMicrophoneEnabled(_ enabled: Bool) {
        isMicrophoneEnabled = enabled
        DeviceStore.shared.apply("glasses", "micEnabled", enabled)

        guard nexReady else {
            Bridge.log("NEX: Not ready to set microphone state. Device not initialized.")
            return
        }

        Bridge.log("NEX: Setting microphone enabled: \(enabled)")

        let micStateConfig = Mentraos_Ble_MicStateConfig.with {
            $0.enabled = enabled
        }

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.micState = micStateConfig
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)

        // Update aiListening state when microphone state changes (G1-compatible)
        if enabled, !vadActive {
            // Only set aiListening if VAD isn't already controlling it
            aiListening = enabled
        }
    }

    /// G1-compatible alias for microphone control
    func setMicEnabled(enabled: Bool) async -> Bool {
        setMicrophoneEnabled(enabled)
        return true
    }

    func sortMicRanking(list: [String]) -> [String] {
        return list
    }

    // MARK: - Status Query Commands

    @objc func queryBatteryStatus() {
        guard nexReady else {
            Bridge.log("NEX: Not ready to query battery status. Device not initialized.")
            return
        }

        Bridge.log("NEX: Querying battery status")

        let batteryStateRequest = Mentraos_Ble_BatteryStateRequest()

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.batteryState = batteryStateRequest
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    @objc func queryGlassesInfo() {
        guard nexReady else {
            Bridge.log("NEX: Not ready to query glasses info. Device not initialized.")
            return
        }

        Bridge.log("NEX: Querying glasses information")

        let glassesInfoRequest = Mentraos_Ble_GlassesInfoRequest()

        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.glassesInfo = glassesInfoRequest
        }

        let protobufData = try! phoneToGlasses.serializedData()
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    // MARK: - Utility Methods

    @objc func isDeviceReady() -> Bool {
        nexReady && connectionState == ConnTypes.CONNECTED
    }

    @objc func getDeviceInfo() -> [String: Any] {
        [
            "device_ready": nexReady,
            "connection_state": getConnectionState(),
            "current_mtu": currentMTU,
            "device_max_mtu": deviceMaxMTU,
            "max_chunk_size": maxChunkSize,
            "bmp_chunk_size": bmpChunkSize,
            "device_name": peripheral?.name ?? "Unknown",
            "device_id": peripheral?.identifier.uuidString ?? "Unknown",
        ]
    }

    // MARK: - Advanced Display Methods

    @objc func displayCustomContent(_ content: String) {
        // For now, treat custom content as regular text
        Task { await sendTextWall(content) }
    }

    @objc func setUpdatingScreen(_ updating: Bool) {
        Bridge.log("NEX: Set updating screen: \(updating)")
        // This could be used to prevent display updates during certain operations
        // Implementation depends on specific requirements
    }

    // MARK: - Data Processing and Event Listeners

    private func processReceivedData(_ data: Data) {
        guard data.count > 0 else { return }

        let packetType = data[0]
        Bridge.log("NEX: Processing packet type: 0x\(String(format: "%02X", packetType))")

        switch packetType {
        case PACKET_TYPE_JSON:
            if data.count > 1 {
                let jsonData = data.subdata(in: 1 ..< data.count)
                processJsonData(jsonData)
            }

        case PACKET_TYPE_PROTOBUF:
            if data.count > 1 {
                let protobufData = data.subdata(in: 1 ..< data.count)
                processProtobufData(protobufData)
            }

        case PACKET_TYPE_AUDIO:
            if data.count > 2 {
                let sequenceNumber = data[1]
                let audioData = data.subdata(in: 2 ..< data.count)
                processAudioData(audioData, sequenceNumber: sequenceNumber)
            }

        case PACKET_TYPE_IMAGE:
            processImageData(data)

        default:
            Bridge.log("NEX: Unknown packet type: 0x\(String(format: "%02X", packetType))")
        }
    }

    private func processJsonData(_ jsonData: Data) {
        guard let jsonString = String(data: jsonData, encoding: .utf8) else {
            Bridge.log("NEX: Failed to decode JSON data")
            return
        }

        Bridge.log("NEX: Processing JSON: \(jsonString)")

        do {
            guard let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let type = json["type"] as? String
            else {
                return
            }

            switch type {
            case "battery_status":
                handleBatteryStatusJson(json)
            case "device_info":
                handleDeviceInfoJson(json)
            case "button_event":
                handleButtonEventJson(json)
            case "vad_event":
                handleVadEventJson(json)
            case "imu_data":
                handleImuDataJson(json)
            case "head_gesture":
                handleHeadGestureJson(json)
            default:
                Bridge.log("NEX: Unhandled JSON type: \(type)")
            }
        } catch {
            Bridge.log("NEX: Error parsing JSON: \(error)")
        }
    }

    private func processProtobufData(_ protobufData: Data) {
        do {
            let glassesToPhone = try Mentraos_Ble_GlassesToPhone(serializedData: protobufData)
            // No per-message log: String(describing: payload) stringifies the whole
            // protobuf and every Bridge.log costs the JS thread.
            // Bridge.log("NEX: Processing protobuf payload case: \(glassesToPhone.payload)")

            let fullPacket = Data([PACKET_TYPE_PROTOBUF]) + protobufData
            emitBleCommandReceived(fullPacket, payloadDescription: String(describing: glassesToPhone.payload))

            switch glassesToPhone.payload {
            case let .canvasResult(canvasResult):
                // Ack for CanvasCreateComponent / CanvasClear (updates are
                // unacked). Non-OK (INVALID / OVERSIZE / OOM) invalidates the
                // registry entry so the next frame recreates the component —
                // and a silent blank screen becomes a diagnosable log line.
                if canvasResult.code != .ok {
                    Bridge.log("NEX: CANVAS_RESULT id=\(canvasResult.id) code=\(canvasResult.code) — dropping registry entry for recreate")
                    canvasElements.removeAll { $0.value.firmwareId == canvasResult.id }
                }

            case let .batteryStatus(batteryStatus):
                handleBatteryStatusProtobuf(batteryStatus)

            case let .chargingState(chargingState):
                handleChargingStateProtobuf(chargingState)

            case let .deviceInfo(deviceInfo):
                handleDeviceInfoProtobuf(deviceInfo)

            case let .headPosition(headPosition):
                handleHeadPositionProtobuf(headPosition)

            case let .headUpAngleSet(headUpAngleResponse):
                handleHeadUpAngleResponseProtobuf(headUpAngleResponse)

            case let .vadEvent(vadEvent):
                handleVadEventProtobuf(vadEvent)

            case let .imageTransferComplete(transferComplete):
                handleImageTransferCompleteProtobuf(transferComplete)

            case let .imuData(imuData):
                handleImuDataProtobuf(imuData)

            case let .buttonEvent(buttonEvent):
                handleButtonEventProtobuf(buttonEvent)

            case let .headGesture(headGesture):
                handleHeadGestureProtobuf(headGesture)

            // Note: VersionResponse not available in current protobuf structure

            case .none:
                Bridge.log("NEX: Protobuf payload not set")

            default:
                Bridge.log("NEX: Unhandled protobuf payload type")
            }

        } catch {
            Bridge.log("NEX: Error parsing protobuf data: \(error)")
        }
    }

    private func processAudioData(_ audioData: Data, sequenceNumber: UInt8) {
        // No per-packet log: fires 20x/sec while the mic streams; each Bridge.log
        // costs the JS thread. Keep only the sequence-mismatch log below (rare,
        // fires on actual packet loss).
        if lastReceivedLc3Sequence != -1, UInt8((lastReceivedLc3Sequence + 1) & 0xFF) != sequenceNumber {
            Bridge.log("NEX: LC3 packet sequence mismatch. Expected \((lastReceivedLc3Sequence + 1) & 0xFF), got \(sequenceNumber)")
        }
        lastReceivedLc3Sequence = Int(sequenceNumber)

        // Update @Published property (G1-compatible approach)
        // Create packet with sequence number prefix like G1 expects
        var packetData = Data()
        packetData.append(sequenceNumber)
        packetData.append(audioData)

        compressedVoiceData = packetData
        DeviceManager.shared.handleGlassesMicData(audioData, 40)
    }

    private func processImageData(_ imageData: Data) {
        Bridge.log("NEX: Received image data: \(imageData.count) bytes")
        // Image data processing can be implemented based on specific requirements
    }

    // MARK: - Protobuf Event Handlers

    private func handleBatteryStatusProtobuf(_ batteryStatus: Mentraos_Ble_BatteryStatus) {
        let level = Int(batteryStatus.level)
        let isCharging = batteryStatus.charging

        Bridge.log("NEX: 🔋 Battery Status - Level: \(level)%, Charging: \(isCharging)")

        // Update @Published properties (G1-compatible approach)
        DeviceStore.shared.apply("glasses", "batteryLevel", level)
        DeviceStore.shared.apply("glasses", "charging", isCharging)
    }

    private func handleChargingStateProtobuf(_ chargingState: Mentraos_Ble_ChargingState) {
        let chargingState = chargingState.state == .charging

        Bridge.log("NEX: 🔌 Charging State: \(chargingState ? "CHARGING" : "NOT_CHARGING")")

        // Update @Published property (G1-compatible approach)
        DeviceStore.shared.apply("glasses", "charging", chargingState)
    }

    private func handleDeviceInfoProtobuf(_ deviceInfo: Mentraos_Ble_DeviceInfo) {
        Bridge.log("NEX: 📱 Device Info: \(deviceInfo)")

        // Update @Published properties (G1-compatible approach)
        DeviceStore.shared.apply("glasses", "deviceFirmwareVersion", deviceInfo.fwVersion)
        DeviceStore.shared.apply("glasses", "deviceHardwareModel", deviceInfo.hwModel)
    }

    private func handleHeadPositionProtobuf(_ headPosition: Mentraos_Ble_HeadPosition) {
        let angle = Int(headPosition.angle)

        Bridge.log("NEX: 📐 Head Position - Angle: \(angle)°")

        // Update @Published property (G1-compatible approach)
        headUpAngle = angle
    }

    private func handleHeadUpAngleResponseProtobuf(_ response: Mentraos_Ble_HeadUpAngleResponse) {
        let success = response.success

        Bridge.log("NEX: 📐 Head Up Angle Set Response - Success: \(success)")

        // Emit response event
        let eventBody: [String: Any] = [
            "head_up_angle_set_result": success,
            "device_model": "Mentra Display",
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]

        emitEvent("HeadUpAngleResponseEvent", body: eventBody)
    }

    private func handleVadEventProtobuf(_ vadEvent: Mentraos_Ble_VadEvent) {
        let vadActiveState = vadEvent.state == .active

        Bridge.log("NEX: 🎤 VAD Event - Voice Activity: \(vadActiveState)")

        // Update @Published properties (G1-compatible approach)
        vadActive = vadActiveState
        aiListening = vadActiveState // Mirror G1's aiListening behavior
    }

    private func handleImageTransferCompleteProtobuf(
        _ transferComplete: Mentraos_Ble_ImageTransferComplete
    ) {
        let status = transferComplete.status
        let missingChunks = transferComplete.missingChunks

        Bridge.log("NEX: 🖼️ Image Transfer Complete - Status: \(status)")

        switch status {
        case .ok:
            Bridge.log("NEX: Image transfer completed successfully")
            currentImageChunks.removeAll()
            isImageSendProgressing = false

        case .incomplete:
            Bridge.log("NEX: Image transfer incomplete - Missing chunks: \(missingChunks)")
            resendImageMissingChunks(missingChunks)

        default:
            Bridge.log("NEX: Unknown image transfer status")
        }

        // Emit image transfer complete event
        let eventBody: [String: Any] = [
            "image_transfer_complete": [
                "status": status == .ok ? "success" : "incomplete",
                "missing_chunks": missingChunks,
                "timestamp": Date().timeIntervalSince1970 * 1000,
            ],
        ]

        emitEvent("ImageTransferCompleteEvent", body: eventBody)
    }

    private func resendImageMissingChunks(_ missingChunks: [UInt32]) {
        guard isImageSendProgressing, !currentImageChunks.isEmpty, !missingChunks.isEmpty else {
            return
        }
        let retransmit = missingChunks.compactMap { index -> [UInt8]? in
            let i = Int(index)
            guard i >= 0, i < currentImageChunks.count else { return nil }
            return currentImageChunks[i]
        }
        if !retransmit.isEmpty {
            Bridge.log("NEX: Resending \(retransmit.count) missing image chunks")
            queueChunks(retransmit)
        }
    }

    private func handleImuDataProtobuf(_ imuData: Mentraos_Ble_ImuData) {
        Bridge.log("NEX: 📊 IMU Data: \(imuData)")

        // Update @Published properties (G1-compatible approach)
        accelerometer = [imuData.accel.x, imuData.accel.y, imuData.accel.z]
        gyroscope = [imuData.gyro.x, imuData.gyro.y, imuData.gyro.z]
        magnetometer = [imuData.mag.x, imuData.mag.y, imuData.mag.z]
    }

    private func handleButtonEventProtobuf(_ buttonEvent: Mentraos_Ble_ButtonEvent) {
        let buttonNumber = Int(buttonEvent.button.rawValue)
        let buttonState = buttonEvent.state

        Bridge.log("NEX: 🔘 Button Event - Button: \(buttonNumber), State: \(buttonState)")

        // Update @Published properties (G1-compatible approach)
        lastButtonPressed = buttonNumber
        lastButtonState = "\(buttonState.rawValue)"
    }

    private func handleHeadGestureProtobuf(_ headGesture: Mentraos_Ble_HeadGesture) {
        let gestureType = headGesture.gesture

        Bridge.log("NEX: 👤 Head Gesture: \(gestureType)")

        // Update @Published properties (G1-compatible approach)
        switch gestureType {
        case .headUp:
            DeviceStore.shared.apply("glasses", "headUp", true)
            lastHeadGesture = "headUp"
        case .nod:
            lastHeadGesture = "nod"
        case .shake:
            lastHeadGesture = "shake"
        default:
            Bridge.log("NEX: Unknown head gesture type: \(gestureType)")
            lastHeadGesture = "unknown"
        }
    }

    // MARK: - JSON Event Handlers

    private func handleBatteryStatusJson(_ json: [String: Any]) {
        let level = json["level"] as? Int ?? -1
        let isCharging = json["charging"] as? Bool ?? false

        Bridge.log("NEX: 🔋 JSON Battery Status - Level: \(level)%, Charging: \(isCharging)")

        // Update @Published properties (G1-compatible approach)
        DeviceStore.shared.apply("glasses", "batteryLevel", level)
        DeviceStore.shared.apply("glasses", "charging", isCharging)
    }

    private func handleDeviceInfoJson(_ json: [String: Any]) {
        Bridge.log("NEX: 📱 JSON Device Info: \(json)")

        let eventBody: [String: Any] = [
            "device_info": json,
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]

        emitEvent("DeviceInfoEvent", body: eventBody)
    }

    private func handleButtonEventJson(_ json: [String: Any]) {
        let buttonId = json["button_id"] as? String ?? "unknown"
        let pressType = json["press_type"] as? String ?? "short"

        Bridge.log("NEX: 🔘 JSON Button Event - Button: \(buttonId), Type: \(pressType)")

        let eventBody: [String: Any] = [
            "button_press": [
                "device_model": "Mentra Display",
                "button_id": buttonId,
                "press_type": pressType,
                "timestamp": Date().timeIntervalSince1970 * 1000,
            ],
        ]

        emitEvent("ButtonPressEvent", body: eventBody)
    }

    private func handleVadEventJson(_ json: [String: Any]) {
        let vadActiveState = json["vad"] as? Bool ?? false

        Bridge.log("NEX: 🎤 JSON VAD Event - Voice Activity: \(vadActiveState)")

        // Update @Published properties (G1-compatible approach)
        vadActive = vadActiveState
        aiListening = vadActiveState // Mirror G1's aiListening behavior
    }

    private func handleImuDataJson(_ json: [String: Any]) {
        Bridge.log("NEX: 📊 JSON IMU Data: \(json)")

        let eventBody: [String: Any] = [
            "imu_data": json,
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]

        emitEvent("ImuDataEvent", body: eventBody)
    }

    private func handleHeadGestureJson(_ json: [String: Any]) {
        let gesture = json["gesture"] as? String ?? "unknown"

        Bridge.log("NEX: 👤 JSON Head Gesture: \(gesture)")

        let eventBody: [String: Any] = [
            "head_gesture": [
                "gesture": gesture,
                "timestamp": Date().timeIntervalSince1970 * 1000,
            ],
        ]

        emitEvent("HeadGestureEvent", body: eventBody)
    }

    // MARK: - Event Emission Helper

    private func emitEvent(_ eventName: String, body: [String: Any]) {
        // Use the standardized Bridge.sendTypedMessage helper for consistent type field handling
        Bridge.sendTypedMessage(eventName, body: body)
        Bridge.log("NEX: 📡 Emitted \(eventName) via Bridge.sendTypedMessage")
    }

    // MARK: - Heartbeat Management

    private func notifyHeartbeatSent(_ timestamp: TimeInterval) {
        lastHeartbeatSentTime = timestamp
        Bridge.sendTypedMessage("heartbeat_sent", body: [
            "timestamp": timestamp,
        ])
    }

    private func notifyHeartbeatReceived(_ timestamp: TimeInterval) {
        lastHeartbeatReceivedTime = timestamp
        Bridge.sendTypedMessage("heartbeat_received", body: [
            "timestamp": timestamp,
        ])
    }

    @objc func getLastHeartbeatSentTime() -> TimeInterval {
        lastHeartbeatSentTime
    }

    @objc func getLastHeartbeatReceivedTime() -> TimeInterval {
        lastHeartbeatReceivedTime
    }

    // MARK: - Java-Compatible Initialization Methods

    private func startMicBeat() {
        Bridge.log("NEX: Starting micbeat (30 min interval)")

        if micBeatCount > 0 {
            stopMicBeat()
        }

        sendSetMicEnabled(true, delaySeconds: 0.01)
        micBeatCount += 1

        // Schedule periodic mic beat (like Java lines 1753-1762)
        micBeatTimer = Timer.scheduledTimer(withTimeInterval: MICBEAT_INTERVAL_MS, repeats: true) {
            [weak self] _ in
            guard let self else { return }
            Bridge.log("NEX: SENDING MIC BEAT")
            self.sendSetMicEnabled(self.shouldUseGlassesMic, delaySeconds: 0.001)
        }
    }

    private func stopMicBeat() {
        sendSetMicEnabled(false, delaySeconds: 0.01)
        micBeatTimer?.invalidate()
        micBeatTimer = nil
        micBeatCount = 0
        Bridge.log("NEX: Stopped mic beat")
    }

    private func sendSetMicEnabled(_ enabled: Bool, delaySeconds: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds) { [weak self] in
            self?.setMicrophoneEnabled(enabled)
        }
    }

    private func sendWhiteListCommand() {
        guard !whiteListedAlready else {
            Bridge.log("NEX: Whitelist already sent, skipping")
            return
        }
        whiteListedAlready = true

        Bridge.log("NEX: Sending whitelist command")

        // Create whitelist JSON exactly like Java (lines 2642-2680)
        let whitelistJson = createWhitelistJson()
        let chunks = createWhitelistChunks(json: whitelistJson)

        // Send chunks with delay like Java
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { // 10ms delay
            self.queueChunks(chunks)
        }
    }

    private func createWhitelistJson() -> String {
        // Exact JSON structure from Java implementation (lines 2653-2680)
        let whitelistDict: [String: Any] = [
            "calendar_enable": false,
            "call_enable": false,
            "msg_enable": false,
            "ios_mail_enable": false,
            "app": [
                "list": [
                    ["id": "com.augment.os", "name": "AugmentOS"],
                ],
                "enable": true,
            ],
        ]

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: whitelistDict)
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                Bridge.log("NEX: Created whitelist JSON: \(jsonString)")
                return jsonString
            }
        } catch {
            Bridge.log("NEX: Error creating whitelist JSON: \(error)")
        }

        return "{}"
    }

    private func createWhitelistChunks(json: String) -> [[UInt8]] {
        // Exact chunking logic from Java (lines 2703-2728)
        guard let jsonData = json.data(using: .utf8) else { return [] }

        let totalChunks = Int(ceil(Double(jsonData.count) / Double(maxChunkSize)))
        var chunks: [[UInt8]] = []

        for i in 0 ..< totalChunks {
            let start = i * maxChunkSize
            let end = min(start + maxChunkSize, jsonData.count)
            let payloadChunk = jsonData.subdata(in: start ..< end)

            // Create header: [WHITELIST_CMD, total_chunks, chunk_index] (Java lines 2714-2717)
            var header: [UInt8] = [
                WHITELIST_CMD, // Command ID (0x04)
                UInt8(totalChunks), // Total number of chunks
                UInt8(i), // Current chunk index
            ]

            // Combine header and payload (Java lines 2720-2725)
            header.append(contentsOf: payloadChunk)
            chunks.append(header)
        }

        Bridge.log("NEX: Created \(chunks.count) whitelist chunks")
        return chunks
    }

    private func postProtobufSchemaVersionInfo() {
        guard !protobufVersionPosted else {
            Bridge.log("NEX: Protobuf version already posted, skipping")
            return
        }
        protobufVersionPosted = true

        Bridge.log("NEX: 📋 Posting protobuf schema version info")

        // Emit protobuf schema version event like Java (lines 3709-3728)
        let eventBody: [String: Any] = [
            "protobuf_schema_version": [
                "schema_version": 1, // Default version
                "build_info": "Schema v1 | mentraos_ble.proto",
                "device_model": "Mentra Display",
            ],
        ]

        // emitEvent("ProtobufSchemaVersionEvent", body: eventBody)
    }

    /// Save microphone state before disconnection (like Java implementation)
    private func saveMicrophoneStateBeforeDisconnection() {
        UserDefaults.standard.set(isMicrophoneEnabled, forKey: "microphoneStateBeforeDisconnection")
        microphoneStateBeforeDisconnection = isMicrophoneEnabled
        Bridge.log("NEX: Saved microphone state before disconnection: \(isMicrophoneEnabled)")
    }

    @objc func disconnect() {
        Bridge.log("NEX: 🔌 User-initiated disconnect")
        // Light teardown: drop the link but stay able to reconnect.
        sendIntentionalDisconnectThen { [weak self] in self?.finalizeDisconnect() }
    }

    /// Best-effort: tell the glasses this disconnect is intentional so they return to
    /// the welcome screen immediately rather than holding the last frame through the
    /// firmware's unexpected-disconnect grace period, then run `teardown` after a short
    /// window to let the write flush. Falls straight through if nothing is connected.
    private func sendIntentionalDisconnectThen(_ teardown: @escaping () -> Void) {
        isDisconnecting = true
        stopReconnectionTimer()
        guard peripheral != nil, servicesReady else {
            teardown()
            return
        }
        sendDisconnectRequest()
        MentraNexSGC._bluetoothQueue.asyncAfter(deadline: .now() + 0.25, execute: teardown)
    }

    private func sendDisconnectRequest() {
        let phoneToGlasses = Mentraos_Ble_PhoneToGlasses.with {
            $0.disconnect = Mentraos_Ble_DisconnectRequest()
        }
        guard let protobufData = try? phoneToGlasses.serializedData() else {
            Bridge.log("NEX: ⚠️ Failed to serialize DisconnectRequest")
            return
        }
        Bridge.log("NEX: 📤 Sending DisconnectRequest before teardown")
        queueDataWithOptimalChunking(protobufData, packetType: PACKET_TYPE_PROTOBUF)
    }

    private func finalizeDisconnect() {
        if let peripheral {
            // Save microphone state before disconnection (like Java implementation)
            saveMicrophoneStateBeforeDisconnection()

            // Stop mic beat system
            stopMicBeat()

            connectionState = ConnTypes.DISCONNECTED
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        setServicesReady(false)
        releaseServiceWaiters()
        Task { await commandQueue.clear() }
        resumePendingWrite()
        resumePendingAck()
        stopReconnectionTimer()
        stopTextWallDrain()
    }

    // MARK: - Lifecycle Management (ported from Java)

    @objc func destroy() {
        // Route through the shared path so forget()/cleanup() also signal an
        // intentional disconnect to the glasses before the link goes down.
        sendIntentionalDisconnectThen { [weak self] in self?.performDestroy() }
    }

    private func performDestroy() {
        Bridge.log("NEX: 💥 Destroying MentraNexSGC instance")

        isKilled = true
        isDisconnecting = true

        // Stop all timers
        // Save microphone state before destruction (like Java implementation)
        saveMicrophoneStateBeforeDisconnection()

        // Stop mic beat system (like Java implementation)
        stopMicBeat()

        stopReconnectionTimer()

        // Disconnect from peripheral
        if let peripheral {
            centralManager?.cancelPeripheralConnection(peripheral)
        }

        // Stop scanning
        if _isScanning {
            stopScan()
        }

        // Clear all references
        peripheral = nil
        writeCharacteristic = nil
        notifyCharacteristic = nil
        centralManager?.delegate = nil
        centralManager = nil

        // Clear discovery cache
        discoveredPeripherals.removeAll()
        setServicesReady(false)
        releaseServiceWaiters()
        Task { await commandQueue.clear() }
        resumePendingWrite()
        resumePendingAck()

        Bridge.log("NEX: ✅ MentraNexSGC destroyed successfully")
        // Reset initialization flags
        whiteListedAlready = false
        protobufVersionPosted = false
        currentImageChunks.removeAll()
        isImageSendProgressing = false
        currentMTU = MTU_DEFAULT
        deviceMaxMTU = MTU_DEFAULT
        maxChunkSize = MTU_DEFAULT - 10
        bmpChunkSize = MTU_DEFAULT - 20
        updateConnectedState(isConnected: false)
    }

    @objc func reset() {
        Bridge.log("NEX: 🔄 Resetting MentraNexSGC to fresh state")

        // Disconnect current connection
        disconnect()

        // Clear all saved device information
        clearSavedDeviceInfo()

        // Clear discovery cache
        discoveredPeripherals.removeAll()

        // Reset internal state
        isKilled = false
        isDisconnecting = false
        nexReady = false
        reconnectionAttempts = 0
        peripheralToConnectName = nil

        Bridge.log("NEX: ✅ Reset complete - ready for fresh pairing")
        // Reset initialization flags (like Java implementation)
        whiteListedAlready = false
        protobufVersionPosted = false
        heartbeatCount = 0
        micBeatCount = 0
        shouldUseGlassesMic = true
        microphoneStateBeforeDisconnection = false
        currentImageChunks.removeAll()
        isImageSendProgressing = false
        updateConnectedState(isConnected: false)
    }

    // MARK: - Helper Methods (like G1)

    private func getConnectedDevices() -> [CBPeripheral] {
        guard let centralManager else { return [] }
        // Retrieve peripherals already connected that expose our main service
        return centralManager.retrieveConnectedPeripherals(withServices: [])
    }

    private func emitDiscoveredDevice(_ name: String) {
        // Emit device discovery event using standardized typed message function
        Bridge.log("NEX: 📡 Emitting discovered device: \(name)")
        Bridge.sendDiscoveredDevice(DeviceTypes.NEX, name)
    }

    private func updateConnectedState(isConnected: Bool) {
        connectionState = isConnected ? ConnTypes.CONNECTED : ConnTypes.DISCONNECTED
        DeviceStore.shared.apply("glasses", "connected", isConnected)
        DeviceStore.shared.apply("glasses", "fullyBooted", isConnected)
        DeviceStore.shared.apply("glasses", "connectionState", isConnected ? ConnTypes.CONNECTED : ConnTypes.DISCONNECTED)
    }

    @objc func checkBluetoothState() {
        Bridge.log("NEX: 🔍 Checking Bluetooth State...")
        if let centralManager {
            Bridge.log("NEX: 📱 Central Manager exists: YES")
            Bridge.log("NEX: 📱 Current Bluetooth State: \(centralManager.state.rawValue)")

            switch centralManager.state {
            case .poweredOn:
                Bridge.log("NEX: ✅ Bluetooth is ready for scanning")

                if let savedDeviceName = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME),
                   !savedDeviceName.isEmpty
                {
                    Bridge.log("NEX: 🔄 Looking for saved device: \(savedDeviceName)")
                    // This will be handled in didDiscover when the device is found
                    startScan()
                }
            case .poweredOff:
                Bridge.log("NEX: ❌ Bluetooth is turned off")
            case .resetting:
                Bridge.log("NEX: 🔄 Bluetooth is resetting")
            case .unauthorized:
                Bridge.log("NEX: ❌ Bluetooth permission denied")
            case .unsupported:
                Bridge.log("NEX: ❌ Bluetooth not supported")
            case .unknown:
                Bridge.log("NEX: ❓ Bluetooth state unknown")
            @unknown default:
                Bridge.log("NEX: ❓ Unknown Bluetooth state: \(centralManager.state.rawValue)")
            }
        } else {
            Bridge.log("NEX: ❌ Central Manager is nil!")
        }
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Bridge.log("NEX: 🔄 Bluetooth state changed to: \(central.state.rawValue)")

        switch central.state {
        case .poweredOn:
            Bridge.log("NEX: ✅ Bluetooth is On and ready for scanning")
            if scanOnPowerOn || peripheralToConnectName != nil {
                Bridge.log("NEX: 🚀 Triggering scan after power on.")
                scanOnPowerOn = false
                startScan()
            }
        case .poweredOff:
            Bridge.log("NEX: ❌ Bluetooth is Off - user needs to enable Bluetooth")
            connectionState = ConnTypes.DISCONNECTED
        case .resetting:
            Bridge.log("NEX: 🔄 Bluetooth is resetting - wait for completion")
            connectionState = ConnTypes.DISCONNECTED
        case .unauthorized:
            Bridge.log("NEX: ❌ Bluetooth is unauthorized - check app permissions")
            connectionState = ConnTypes.DISCONNECTED
        case .unsupported:
            Bridge.log("NEX: ❌ Bluetooth is unsupported on this device")
            connectionState = ConnTypes.DISCONNECTED
        case .unknown:
            Bridge.log("NEX: ❓ Bluetooth state is unknown - may be initializing")
        @unknown default:
            Bridge.log("NEX: ❓ A new Bluetooth state was introduced: \(central.state.rawValue)")
        }
    }

    func centralManager(
        _: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData _: [String: Any], rssi RSSI: NSNumber
    ) {
        guard let deviceName = peripheral.name else {
            // Bridge.log("NEX-CONN: 🚫 Ignoring device with no name")
            return
        }

        guard isCompatibleNexDevice(deviceName) else {
            return
        }

        Bridge.log("NEX-CONN: 🎯 === Compatible Nex Device Found ===")
        Bridge.log("NEX-CONN: 📱 Device Name: \(deviceName)")
        Bridge.log("NEX-CONN: 📶 RSSI: \(RSSI) dBm")

        // Store the peripheral in cache (like MentraLive)
        discoveredPeripherals[deviceName] = peripheral

        // Always emit the discovered device for the UI list
        emitDiscoveredDevice(deviceName)

        // Auto-connect logic based on target or saved device (from Java MentraNexSGC)
        var shouldConnect = false
        var connectionReason = ""

        // Check if this matches our target device name for connection
        if let targetName = peripheralToConnectName, deviceName.contains(targetName) {
            shouldConnect = true
            connectionReason = "Target device name match: \(targetName)"
        }
        // During a user-initiated discovery scan, only list devices — never auto-connect a
        // saved/preferred device, so the user can pick a different one.
        else if isDiscoveryScan {
            shouldConnect = false
        }
        // Check if this matches our saved device for reconnection
        else if let savedName = savedDeviceName, deviceName == savedName {
            shouldConnect = true
            connectionReason = "Saved device reconnection: \(savedName)"
        }
        // Check if this matches preferred device ID
        else if let preferredId = preferredDeviceId {
            if let extractedId = extractDeviceId(from: deviceName), extractedId == preferredId {
                shouldConnect = true
                connectionReason = "Preferred device ID match: \(preferredId)"
            }
        }

        if shouldConnect {
            connectToFoundDevice(peripheral, reason: connectionReason)
        }
    }

    // MARK: - Enhanced Connection Helper

    private func connectToFoundDevice(_ peripheral: CBPeripheral, reason: String) {
        guard self.peripheral == nil else {
            Bridge.log(
                "NEX-CONN: ⚠️ Already connected/connecting to a device, ignoring new connect request for '\(peripheral.name ?? "Unknown")'"
            )
            return
        }

        Bridge.log(
            "NEX-CONN: 🔗 Connecting to device '\(peripheral.name ?? "Unknown")' - Reason: \(reason)"
        )

        // Stop scanning since we found our target
        if _isScanning {
            stopScan()
        }

        // Store the peripheral and initiate connection
        self.peripheral = peripheral
        isConnecting = true
        connectionState = ConnTypes.CONNECTING
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTING)

        // Use connection options for better reliability (from Java implementation)
        let connectionOptions: [String: Any] = [
            CBConnectPeripheralOptionNotifyOnConnectionKey: true,
            CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
            CBConnectPeripheralOptionNotifyOnNotificationKey: true,
        ]

        centralManager?.connect(peripheral, options: connectionOptions)

        Bridge.log("NEX-CONN: 🚀 Connection initiated with enhanced options")
    }

    func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Bridge.log("NEX-CONN: ✅ Successfully connected to \(peripheral.name ?? "unknown device").")
        isConnecting = false
        peripheralUUID = peripheral.identifier // Persist UUID
        stopReconnectionTimer() // Successfully connected, stop trying to reconnect.

        // Enhanced device info saving (from Java implementation)
        let deviceName = peripheral.name
        let deviceAddress = peripheral.identifier.uuidString

        // Save all device information for future reconnection
        savePairedDeviceInfo(name: deviceName, address: deviceAddress)

        // Extract and save device ID if possible
        if let deviceName, let deviceId = extractDeviceId(from: deviceName) {
            savePreferredDeviceId(deviceId)
        }

        Bridge.log("NEX-CONN: 💾 Device information saved for reliable reconnection")
        peripheral.delegate = self
        Bridge.log("NEX-CONN: 🔍 Discovering services...")
        setServicesReady(false)
        peripheral.discoverServices([MAIN_SERVICE_UUID])

        // Reset any failed connection attempt counters
        reconnectionAttempts = 0
        Bridge.log("NEX-CONN: 🔄 Reset reconnection attempts counter")
    }

    func centralManager(
        _: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        Bridge.log(
            "NEX-CONN: ❌ Failed to connect to peripheral \(peripheral.name ?? "Unknown"). Error: \(error?.localizedDescription ?? "unknown")"
        )
        isConnecting = false
        connectionState = ConnTypes.DISCONNECTED
        setServicesReady(false)
        releaseServiceWaiters()
        Task { await commandQueue.clear() }
        resumePendingWrite()
        resumePendingAck()
        self.peripheral = nil // Reset peripheral on failure to allow reconnection
        // Optionally, start reconnection attempts here
        if !isDisconnecting, !isKilled {
            startReconnectionTimer()
        }
    }

    func centralManager(
        _: CBCentralManager, didDisconnectPeripheral disconnectedPeripheral: CBPeripheral,
        error: Error?
    ) {
        Bridge.log(
            "NEX-CONN: 🔌 Disconnected from peripheral: \(disconnectedPeripheral.name ?? "Unknown")"
        )

        if let error {
            Bridge.log("NEX-CONN: ⚠️ Disconnect error: \(error.localizedDescription)")
        }

        // The glasses lose their canvas on disconnect — forget the component
        // registry so post-reconnect frames take the CREATE path (firmware
        // silently drops updates to dead component ids). The host replays the
        // current scene after reconnect.
        canvasElements.removeAll()
        currentLayoutId = nil

        // Reset connection state
        // Save microphone state before disconnection (like Java implementation)
        saveMicrophoneStateBeforeDisconnection()
        setServicesReady(false)
        releaseServiceWaiters()
        Task { await commandQueue.clear() }
        resumePendingWrite()
        resumePendingAck()

        // Reset protobuf version posted flag for next connection (like Java implementation)
        protobufVersionPosted = false

        // Stop mic beat system (like Java implementation)
        stopMicBeat()
        stopTextWallDrain()

        nexReady = false
        deviceReady = false
        // batteryLevel = -1
        // charging = false
        DeviceStore.shared.apply("glasses", "batteryLevel", -1)
        DeviceStore.shared.apply("glasses", "charging", false)
        vadActive = false
        compressedVoiceData = .init()
        aiListening = false
        deviceFirmwareVersion = ""
        deviceHardwareModel = ""
        accelerometer = [0.0, 0.0, 0.0]
        gyroscope = [0.0, 0.0, 0.0]
        magnetometer = [0.0, 0.0, 0.0]
        lastButtonPressed = -1
        lastButtonState = ""
        lastHeadGesture = ""
        headUpAngle = 0

        peripheral = nil
        writeCharacteristic = nil
        notifyCharacteristic = nil
        connectionState = ConnTypes.DISCONNECTED
        currentMTU = MTU_DEFAULT
        deviceMaxMTU = MTU_DEFAULT
        maxChunkSize = MTU_DEFAULT - 10
        bmpChunkSize = MTU_DEFAULT - 20
        currentImageChunks.removeAll()
        isImageSendProgressing = false
        updateConnectedState(isConnected: false)

        // Clear command queue if needed
        if isQueueWorkerRunning {
            Bridge.log("NEX-CONN: 🧹 Clearing command queue due to disconnection")
        }

        if !isDisconnecting, !isKilled {
            Bridge.log("NEX-CONN: 🔄 Unintentional disconnect detected. Attempting reconnection...")

            // Enhanced reconnection strategy from Java implementation
            if let savedName = savedDeviceName {
                Bridge.log("NEX-CONN: 🎯 Will attempt to reconnect to saved device: \(savedName)")
            }

            startReconnectionTimer()
        } else {
            Bridge.log(
                "NEX-CONN: ✅ Intentional disconnect (isDisconnecting: \(isDisconnecting), isKilled: \(isKilled))"
            )

            if isDisconnecting {
                // Don't clear device info on intentional disconnect - user might reconnect later
                Bridge.log("NEX-CONN: 💾 Keeping device info for potential future reconnection")
            }
        }
    }

    // MARK: - MTU Negotiation (iOS-specific implementation)

    private func requestOptimalMTU(for peripheral: CBPeripheral) {
        Bridge.log("NEX-CONN:  negotiating MTU")
        Bridge.log("NEX: 🔍 iOS MTU Discovery (Platform Limitation: max \(MTU_MAX_IOS) bytes)")
        Bridge.log("NEX: 🎯 iOS maximum: \(MTU_MAX_IOS) bytes, default: \(MTU_DEFAULT) bytes")

        // iOS MTU is automatically negotiated - we can only discover the current value
        // No manual MTU request available on iOS (platform limitation)

        // Get current MTU capability (iOS-specific approach). Query for .withoutResponse
        // since that's the write type the caption path uses; its limit can differ from
        // .withResponse, and sizing chunks to it avoids oversized writes being dropped.
        let maxWriteLength = peripheral.maximumWriteValueLength(for: .withoutResponse)
        let actualMTU = maxWriteLength + 3 // Add L2CAP header size

        Bridge.log("NEX: 📊 iOS MTU Discovery Results:")
        Bridge.log("NEX:    📏 Max write length: \(maxWriteLength) bytes")
        Bridge.log("NEX:    📡 Effective MTU: \(actualMTU) bytes")

        // Validate against iOS limitations
        let validatedMTU = min(actualMTU, MTU_MAX_IOS)
        if actualMTU > MTU_MAX_IOS {
            Bridge.log("NEX: 🔧 Clamping MTU from \(actualMTU) to iOS maximum: \(MTU_MAX_IOS)")
        }

        // Process MTU result immediately (iOS doesn't have callback like Android)
        onMTUNegotiated(mtu: validatedMTU, success: true)

        // After MTU is set, start device initialization sequence (from Java implementation)
        initializeNexDevice()
    }

    private func onMTUNegotiated(mtu: Int, success: Bool) {
        Bridge.log("NEX-CONN: 🔄 MTU Negotiation Result: Success=\(success), Device MTU=\(mtu)")

        if success, mtu > MTU_DEFAULT {
            // Store device capability and calculate actual negotiated MTU
            deviceMaxMTU = mtu
            // iOS limitation: Use actual MTU but cap at iOS maximum
            currentMTU = min(MTU_MAX_IOS, mtu)

            Bridge.log("NEX: 🎯 iOS MTU Configuration Complete:")
            Bridge.log("NEX:    🍎 iOS Platform Max: \(MTU_MAX_IOS) bytes")
            Bridge.log("NEX:    📡 Device Supports: \(deviceMaxMTU) bytes")
            Bridge.log("NEX:    🤝 Final MTU: \(currentMTU) bytes")

            // Calculate optimal chunk sizes based on iOS MTU constraints
            maxChunkSize = currentMTU - 10 // Reserve 10 bytes for headers
            bmpChunkSize = currentMTU - 20

            Bridge.log("NEX: 📦 Optimized Chunk Sizes:")
            Bridge.log("NEX:    📄 Data Chunk Size: \(maxChunkSize) bytes")
            Bridge.log("NEX:    🖼️ Image Chunk Size: \(bmpChunkSize) bytes")

        } else {
            Bridge.log("NEX: ⚠️ MTU negotiation failed or using minimum, applying iOS defaults")
            currentMTU = MTU_DEFAULT
            deviceMaxMTU = MTU_DEFAULT
            maxChunkSize = 20 // Very conservative for 23-byte MTU
            bmpChunkSize = 20 // Very conservative for 23-byte MTU

            Bridge.log("NEX: 📋 iOS Fallback Configuration:")
            Bridge.log("NEX:    📊 Default MTU: \(MTU_DEFAULT) bytes")
            Bridge.log("NEX:    📦 Data Chunk Size: \(maxChunkSize) bytes")
            Bridge.log("NEX:    🖼️ Image Chunk Size: \(bmpChunkSize) bytes")
            Bridge.log("NEX:    ⚠️ Using minimal chunks due to MTU limitation")
        }

        // Device is now ready for communication
        Bridge.log("NEX-CONN: ✅ Device initialization complete - ready for communication")
        nexReady = true
        connectionState = ConnTypes.CONNECTED
        lastConnectionTimestamp = Date().timeIntervalSince1970 * 1000
        updateConnectedState(isConnected: true)

        // Update @Published property for device ready state
        deviceReady = true

        // Initialize command queue worker to process queued commands
        setupCommandQueue()

        // Start the 100 ms latest-wins drain for caption text walls
        startTextWallDrain()

        // Emit device ready event to React Native
        // emitDeviceReady()
    }

    // MARK: - Device Initialization (ported from Java MentraNexSGC)

    private func initializeNexDevice() {
        Bridge.log("NEX-CONN: 🚀 Starting Nex device initialization (matching Java sequence)")

        // Exact Java initialization sequence from lines 648-691:

        // 1. Do first battery status query (Java line 650)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { // 10ms delay like Java
            Bridge.log("NEX: 🔋 Sending first battery status query")
            self.queryBatteryStatus()
        }

        // 2. Restore previous microphone state (Java lines 657-665)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { // 20ms delay
            let shouldRestoreMic = UserDefaults.standard.bool(
                forKey: "microphoneStateBeforeDisconnection"
            )
            Bridge.log("NEX: 🎤 Restoring microphone state to: \(shouldRestoreMic)")

            if shouldRestoreMic {
                self.startMicBeat()
            } else {
                self.stopMicBeat()
            }
        }

        // 3. Enable AugmentOS notification key (Java line 668)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { // 30ms delay
            self.sendWhiteListCommand()
        }

        // 4. Show home screen to turn on the NexGlasses display (Java line 673)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { // 50ms delay
            self.showHomeScreen()
        }

        // 5. Post protobuf schema version information (Java lines 684-687)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { // 100ms delay
            self.postProtobufSchemaVersionInfo()
        }

        // 6. Version request is removed in current schema; Android sends no-op.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            Bridge.log("NEX: Skipping version request; schema removed VersionRequest")
        }

        // 7. Push current glasses-side Voice Activity Detection setting
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            self.sendVoiceActivityDetectionSetting()
        }

        Bridge.log("NEX-CONN: ✅ Java-compatible initialization sequence started")
    }

    private func emitDeviceReady() {
        let eventBody: [String: Any] = [
            "device_ready": [
                "model_name": "Mentra Display",
                "mtu_negotiated": currentMTU,
                "max_chunk_size": maxChunkSize,
                "connection_state": "ready",
            ],
        ]

        // Use the standardized Bridge.sendTypedMessage helper for consistent type field handling
        Bridge.sendTypedMessage("device_ready", body: eventBody)
        Bridge.log("NEX: 📡 Emitted device ready event with MTU: \(currentMTU)")
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            Bridge.log("NEX-CONN: ❌ Error discovering services: \(error.localizedDescription)")
            return
        }

        guard let services = peripheral.services else {
            Bridge.log("NEX-CONN: ⚠️ No services found for peripheral.")
            return
        }
        for service in services {
            if service.uuid == MAIN_SERVICE_UUID {
                Bridge.log("NEX-CONN: ✅ Found main service. Discovering characteristics...")
                peripheral.discoverCharacteristics(
                    [WRITE_CHAR_UUID, NOTIFY_CHAR_UUID], for: service
                )
            }
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        if let error {
            Bridge.log(
                "NEX-CONN: ❌ Error discovering characteristics: \(error.localizedDescription)"
            )
            return
        }

        guard let characteristics = service.characteristics else {
            Bridge.log("NEX-CONN: ⚠️ No characteristics found for service \(service.uuid).")
            return
        }
        for characteristic in characteristics {
            if characteristic.uuid == WRITE_CHAR_UUID {
                Bridge.log("NEX-CONN: ✅ Found write characteristic.")
                writeCharacteristic = characteristic
            } else if characteristic.uuid == NOTIFY_CHAR_UUID {
                Bridge.log(
                    "NEX-CONN: ✅ Found notify characteristic. Subscribing for notifications."
                )
                notifyCharacteristic = characteristic
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }

        if writeCharacteristic != nil, notifyCharacteristic != nil {
            Bridge.log(
                "NEX-CONN: ✅ All required characteristics discovered. Proceeding to MTU negotiation."
            )

            // Start MTU negotiation like Java implementation
            requestOptimalMTU(for: peripheral)
        }
    }

    func peripheral(
        _: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        if let error {
            Bridge.log("NEX-CONN: ❌ Error on updating value: \(error.localizedDescription)")
            return
        }

        guard let data = characteristic.value else {
            Bridge.log("NEX-CONN: ⚠️ Received notification with no data.")
            return
        }
        // No per-notification logging here: this fires for EVERY inbound packet
        // (~20/sec audio alone), and Bridge.log is a typed message the JS thread
        // must process — plus the toHexString() is O(n) per packet. This was a
        // top contributor to the background CPU kill (cpu_resource_fatal.ips).
        // Bridge.log("NEX-CONN: 📥 Received data (\(data.count) bytes): \(data.toHexString())")

        // Process the received data based on packet type
        processReceivedData(data)
    }

    func peripheral(
        _: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        if let error {
            Bridge.log(
                "NEX-CONN: ❌ Error writing value to \(characteristic.uuid): \(error.localizedDescription)"
            )
            resumePendingAck()
            return
        }
        resumePendingAck()
    }

    func peripheralIsReady(toSendWriteWithoutResponse _: CBPeripheral) {
        // CoreBluetooth can accept more write-without-response data; unblock the sender.
        resumePendingWrite()
    }

    func peripheral(
        _: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error {
            Bridge.log(
                "NEX-CONN: ❌ Error changing notification state for \(characteristic.uuid): \(error.localizedDescription)"
            )
            return
        }

        if characteristic.isNotifying {
            Bridge.log(
                "NEX-CONN: ✅ Successfully subscribed to notifications for characteristic \(characteristic.uuid.uuidString)."
            )
            if characteristic.uuid == NOTIFY_CHAR_UUID {
                setServicesReady(true)
            }
        } else {
            Bridge.log(
                "NEX-CONN:  unsubscribed from notifications for characteristic \(characteristic.uuid.uuidString)."
            )
            if characteristic.uuid == NOTIFY_CHAR_UUID {
                setServicesReady(false)
            }
        }
    }
}
