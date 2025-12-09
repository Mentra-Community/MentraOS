//
//  G1.swift
//  MentraOS_Manager
//
//  Created by Matthew Fosse on 3/3/25.
//

import Combine
import CoreBluetooth
import Foundation
import React
import UIKit

extension Data {
    func chunked(into size: Int) -> [Data] {
        var chunks = [Data]()
        var index = 0
        while index < count {
            let chunkSize = Swift.min(size, count - index)
            let chunk = subdata(in: index ..< (index + chunkSize))
            chunks.append(chunk)
            index += chunkSize
        }
        return chunks
    }

    func hexEncodedString() -> String {
        return map { String(format: "%02x", $0) }.joined(separator: " ")
        //    return map { String(format: "%02x", $0) }.joined(separator: ", ")
    }

    // Extension for CRC32 calculation
    var crc32: UInt32 {
        return withUnsafeBytes { bytes in
            let buffer = bytes.bindMemory(to: UInt8.self)
            var crc: UInt32 = 0xFFFF_FFFF

            for byte in buffer {
                crc ^= UInt32(byte)
                for _ in 0 ..< 8 {
                    if crc & 1 == 1 {
                        crc = (crc >> 1) ^ 0xEDB8_8320
                    } else {
                        crc >>= 1
                    }
                }
            }

            return ~crc
        }
    }

    /// Initialize Data from hex string
    init?(hexString: String) {
        let cleanHex = hexString.replacingOccurrences(of: " ", with: "")
        guard cleanHex.count % 2 == 0 else { return nil }

        var data = Data()
        var index = cleanHex.startIndex

        while index < cleanHex.endIndex {
            let nextIndex = cleanHex.index(index, offsetBy: 2)
            let byteString = cleanHex[index ..< nextIndex]
            guard let byte = UInt8(byteString, radix: 16) else { return nil }
            data.append(byte)
            index = nextIndex
        }

        self = data
    }
}

public struct QuickNote: Equatable {
    let id: UUID
    let text: String
    let timestamp: Date

    public static func == (lhs: QuickNote, rhs: QuickNote) -> Bool {
        return lhs.id == rhs.id
    }
}

struct BufferedCommand {
    let chunks: [[UInt8]]
    let sendLeft: Bool
    let sendRight: Bool
    let waitTime: Int
    let ignoreAck: Bool
    let chunkTimeMs: Int
    let lastFrameMs: Int

    init(
        chunks: [[UInt8]], sendLeft: Bool = true, sendRight: Bool = true, waitTime: Int = -1,
        ignoreAck: Bool = false, chunkTimeMs: Int = 10, lastFrameMs: Int = 0
    ) {
        self.chunks = chunks
        self.sendLeft = sendLeft
        self.sendRight = sendRight
        self.waitTime = waitTime
        self.ignoreAck = ignoreAck
        self.chunkTimeMs = chunkTimeMs
        self.lastFrameMs = lastFrameMs
    }
}

// Simple struct to hold app info
struct AppInfo {
    let id: String
    let name: String
}

enum GlassesError: Error {
    case missingGlasses(String)
}

class G1: NSObject, SGCManager {
    func sendGalleryMode() {}

    func sendButtonMaxRecordingTime() {}

    var glassesAppVersion: String = ""

    var glassesBuildNumber: String = ""

    var glassesDeviceModel: String = ""

    var glassesAndroidVersion: String = ""

    var glassesOtaVersionUrl: String = ""

    var glassesSerialNumber: String = ""

    var glassesStyle: String = ""

    var glassesColor: String = ""

    var caseBatteryLevel: Int = -1

    var wifiSsid: String = ""

    var wifiConnected: Bool = false

    var wifiLocalIp: String = ""

    var isHotspotEnabled: Bool = false

    var micEnabled: Bool = false

    var hotspotSsid: String = ""

    var hotspotPassword: String = ""

    var hotspotGatewayIp: String = ""

    func requestPhoto(
        _: String, appId _: String, size _: String?, webhookUrl _: String?, authToken _: String?,
        compress _: String?
    ) {}

    func startRtmpStream(_: [String: Any]) {}

    func stopRtmpStream() {}

    func sendRtmpKeepAlive(_: [String: Any]) {}

    func startBufferRecording() {}

    func stopBufferRecording() {}

    func saveBufferVideo(requestId _: String, durationSeconds _: Int) {}

    func startVideoRecording(requestId _: String, save _: Bool) {}

    func stopVideoRecording(requestId _: String) {}

    func sendButtonPhotoSettings() {}

    func sendButtonModeSetting() {}

    func sendButtonVideoRecordingSettings() {}

    func sendButtonMaxRecordingTime(_: Int) {}

    func sendButtonCameraLedSetting() {}

    func showDashboard() {}

    func setSilentMode(_: Bool) {}

    func requestWifiScan() {}

    func sendWifiCredentials(_: String, _: String) {}

    func sendHotspotState(_: Bool) {}

    func queryGalleryStatus() {}

    var connectionState: String = ConnTypes.DISCONNECTED

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}

    var type = DeviceTypes.G1
    let hasMic = true

    // TODO: we probably don't need this
    @objc static func requiresMainQueueSetup() -> Bool { return true }

    // Duplicate BMP prevention with timeout
    private var isDisplayingBMP = false
    private var lastBMPStartTime = Date()

    // Frame synchronization for animations
    private var lastFrameTime = Date()
    private var frameSequence = 0

    // Animation Batching (iOS-Controlled Timing)
    private var animationFrames: [String] = []
    private var animationTimer: Timer?
    private var currentFrameIndex: Int = 0
    private var animationInterval: TimeInterval = 1.650 // Default 1650ms
    private var animationRepeat: Bool = false
    private var isAnimationRunning: Bool = false

    // L/R Synchronization - Track BLE write completions
    private var pendingWriteCompletions: [CBCharacteristic: CheckedContinuation<Bool, Never>] = [:]
    private var pendingAckCompletions: [String: CheckedContinuation<Bool, Never>] = [:]
    private let ackCompletionsQueue = DispatchQueue(
        label: "com.erg1.ackCompletions", attributes: .concurrent
    )
    private var writeCompletionCount = 0

    private var _ready: Bool = false
    var ready: Bool {
        get { return _ready }
        set {
            let oldValue = _ready
            _ready = newValue
            if oldValue != newValue {
                CoreManager.shared.handleConnectionStateChanged()
            }
            if !newValue {
                // Reset battery levels when disconnected
                batteryLevel = -1
                leftBatteryLevel = -1
                rightBatteryLevel = -1
            }
        }
    }

    var leftReady: Bool = false
    var rightReady: Bool = false

    @Published var compressedVoiceData: Data = .init()
    @Published var aiListening: Bool = false
    @Published var quickNotes: [QuickNote] = []
    var batteryLevel: Int = -1
    @Published var leftBatteryLevel: Int = -1
    @Published var rightBatteryLevel: Int = -1
    @Published var caseCharging = false
    @Published var caseOpen = false
    @Published var caseRemoved = true

    var isDisconnecting = false
    private var reconnectionTimer: DispatchSourceTimer?
    private let reconnectionQueue = DispatchQueue(
        label: "com.sample.reconnectionTimerQueue", qos: .background
    )
    private var reconnectionAttempts: Int = 0
    private let maxReconnectionAttempts: Int = -1 // unlimited reconnection attempts
    private let reconnectionInterval: TimeInterval = 30.0 // Seconds between reconnection attempts
    private var globalCounter: UInt8 = 0
    private var heartbeatCounter: UInt8 = 0

    enum AiMode: String {
        case AI_REQUESTED
        case AI_MIC_ON
        case AI_IDLE
    }

    let UART_SERVICE_UUID = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    let UART_TX_CHAR_UUID = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    let UART_RX_CHAR_UUID = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")

    // synchronization:
    private let commandQueue = CommandQueue()

    // Constants
    var DEVICE_SEARCH_ID = "NOT_SET"
    let DELAY_BETWEEN_CHUNKS_SEND: UInt64 = 16_000_000 // 16ms
    let DELAY_BETWEEN_SENDS_MS: UInt64 = 8_000_000 // 8ms
    let INITIAL_CONNECTION_DELAY_MS: UInt64 = 350_000_000 // 350ms
    var textHelper = G1Text()
    var msgId = 100

    static let _bluetoothQueue = DispatchQueue(label: "BluetoothG1", qos: .userInitiated)

    private var aiMode: AiMode = .AI_IDLE {
        didSet {
            if aiMode == .AI_MIC_ON {
                aiListening = true
            } else {
                aiListening = false
            }
        }
    }

    private var centralManager: CBCentralManager?
    private var leftPeripheral: CBPeripheral?
    private var rightPeripheral: CBPeripheral?
    private var connectedDevices: [String: (CBPeripheral?, CBPeripheral?)] = [:]
    var lastConnectionTimestamp: Date = .distantPast
    private var heartbeatTimer: Timer?
    private var heartbeatQueue: DispatchQueue?
    private var leftInitialized: Bool = false
    private var rightInitialized: Bool = false
    @Published var isHeadUp = false

    private var leftGlassUUID: UUID? {
        get {
            if let uuidString = UserDefaults.standard.string(forKey: "leftGlassUUID") {
                return UUID(uuidString: uuidString)
            }
            return nil
        }
        set {
            if let newValue = newValue {
                UserDefaults.standard.set(newValue.uuidString, forKey: "leftGlassUUID")
            } else {
                UserDefaults.standard.removeObject(forKey: "leftGlassUUID")
            }
        }
    }

    private var rightGlassUUID: UUID? {
        get {
            if let uuidString = UserDefaults.standard.string(forKey: "rightGlassUUID") {
                return UUID(uuidString: uuidString)
            }
            return nil
        }
        set {
            if let newValue = newValue {
                UserDefaults.standard.set(newValue.uuidString, forKey: "rightGlassUUID")
            } else {
                UserDefaults.standard.removeObject(forKey: "rightGlassUUID")
            }
        }
    }

    override init() {
        super.init()
        startHeartbeatTimer()
    }

    func forget() {
        // Stop the heartbeat timer
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil

        // Stop the reconnection timer if active
        stopReconnectionTimer()

        // Disconnect BLE peripherals before clearing references
        if let left = leftPeripheral {
            centralManager?.cancelPeripheralConnection(left)
        }
        if let right = rightPeripheral {
            centralManager?.cancelPeripheralConnection(right)
        }

        // Clear all references
        leftGlassUUID = nil
        rightGlassUUID = nil
        leftPeripheral = nil
        rightPeripheral = nil
        DEVICE_SEARCH_ID = "NOT_SET"

        // Clean up central manager delegate
        centralManager?.delegate = nil
    }

    deinit {
        // Stop the heartbeat timer
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil

        // Stop the reconnection timer if active
        stopReconnectionTimer()

        // Clean up central manager delegate
        centralManager?.delegate = nil

        // Clean up peripheral delegates
        leftPeripheral?.delegate = nil
        rightPeripheral?.delegate = nil

        // leftGlassUUID = nil
        // rightGlassUUID = nil

        Bridge.log("G1: ERG1Manager deinitialized")
    }

    func cleanup() {
        // TODO:
    }

    // MARK: - Serial Number and Color Detection

    /// Decodes Even G1 serial number to extract style and color information
    /// - Parameter serialNumber: The full serial number (e.g., "S110LABD020021")
    /// - Returns: Tuple containing (style, color) or ("Unknown", "Unknown") if invalid
    static func decodeEvenG1SerialNumber(_ serialNumber: String) -> (style: String, color: String) {
        guard serialNumber.count >= 6 else {
            return ("Unknown", "Unknown")
        }

        // Style mapping: 2nd character (index 1)
        let style: String
        let styleChar = serialNumber[serialNumber.index(serialNumber.startIndex, offsetBy: 2)]
        switch styleChar {
        case "0":
            style = "Round"
        case "1":
            style = "Rectangular"
        default:
            style = "Round"
        }

        // Color mapping: 5th character (index 4)
        let color: String
        let colorChar = serialNumber[serialNumber.index(serialNumber.startIndex, offsetBy: 5)]
        switch colorChar {
        case "A":
            color = "Grey"
        case "B":
            color = "Brown"
        case "C":
            color = "Green"
        default:
            color = "Grey"
        }

        return (style, color)
    }

    /// Decodes serial number from manufacturer data bytes
    /// - Parameter manufacturerData: The manufacturer data bytes
    /// - Returns: Decoded serial number string or nil if not found
    private func decodeSerialFromManufacturerData(_ manufacturerData: Data) -> String? {
        guard manufacturerData.count >= 10 else {
            return nil
        }

        // Convert bytes to ASCII string
        var serialBuilder = ""
        for byte in manufacturerData {
            if byte == 0x00 {
                // Stop at null terminator
                break
            }
            if byte >= 0x20, byte <= 0x7E {
                // Only include CoreCommsService.logable ASCII characters
                serialBuilder.append(Character(UnicodeScalar(byte)))
            }
        }

        let decodedString = serialBuilder.trimmingCharacters(in: .whitespacesAndNewlines)

        // Check if it looks like a valid Even G1 serial number
        if decodedString.count >= 12,
           decodedString.hasPrefix("S1") || decodedString.hasPrefix("100")
           || decodedString.hasPrefix("110")
        {
            return decodedString
        }

        return nil
    }

    /// Emits serial number information to React Native
    private func emitSerialNumberInfo(serialNumber: String, style: String, color: String) {
        let eventBody: [String: Any] = [
            "type": "glasses_serial_number",
            "serialNumber": serialNumber,
            "style": style,
            "color": color,
        ]

        // Convert to JSON string for CoreMessageEvent
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: eventBody, options: [])
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                Bridge.sendEvent(withName: "CoreMessageEvent", body: jsonString)
                Bridge.log(
                    "G1: 📱 Emitted serial number info: \(serialNumber), Style: \(style), Color: \(color)"
                )

                // Trigger status update to include serial number in status JSON
                DispatchQueue.main.async {
                    CoreManager.shared.handle_request_status()
                }
            }
        } catch {
            Bridge.log("G1: Error creating serial number JSON: \(error)")
        }
    }

    // @@@ REACT NATIVE FUNCTIONS @@@

    @objc func RN_setSearchId(_ searchId: String) {
        Bridge.log("G1: SETTING SEARCH_ID: \(searchId)")
        DEVICE_SEARCH_ID = searchId
    }

    // this scans for glasses to connect to and only connnects if SEARCH_ID is set
    func startScan() {
        Task {

            if centralManager == nil {
                centralManager = CBCentralManager(
                    delegate: self, queue: G1._bluetoothQueue,
                    options: ["CBCentralManagerOptionShowPowerAlertKey": 0]
                )
                setupCommandQueue()
                // wait for the central manager to be fully initialized before we start scanning:
                try? await Task.sleep(nanoseconds: 100 * 1_000_000) // 100ms
            }

            self.isDisconnecting = false // reset intentional disconnect flag
            guard centralManager!.state == .poweredOn else {
                Bridge.log("G1: Attempting to scan but bluetooth is not powered on.")
                return false
            }

            // send our already connected devices to RN:
            let devices = getConnectedDevices()
            Bridge.log("G1: connnectedDevices.count: (\(devices.count))")
            for device in devices {
                if let name = device.name {
                    Bridge.log("G1: Connected to device: \(name)")
                    if name.contains("_L_") && name.contains(DEVICE_SEARCH_ID) {
                        leftPeripheral = device
                        device.delegate = self
                        device.discoverServices([UART_SERVICE_UUID])
                    } else if name.contains("_R_") && name.contains(DEVICE_SEARCH_ID) {
                        rightPeripheral = device
                        device.delegate = self
                        device.discoverServices([UART_SERVICE_UUID])
                    }
                    emitDiscoveredDevice(name)
                }
            }

            // First try: Connect by UUID (works in background)
            if connectByUUID() {
                Bridge.log("G1: 🔄 Found and attempting to connect to stored glasses UUIDs")
                // Wait for connection to complete - no need to scan
                return true
            }

            let scanOptions: [String: Any] = [
                CBCentralManagerScanOptionAllowDuplicatesKey: false, // Don't allow duplicate advertisements
            ]

            centralManager!.scanForPeripherals(withServices: nil, options: scanOptions)
            return true
        }
    }

    func connectById(_ id: String) {
        DEVICE_SEARCH_ID = "_" + id + "_"
        startScan()
    }

    func findCompatibleDevices() {
        DEVICE_SEARCH_ID = "NOT_SET"
        startScan()
    }

    // connect to glasses we've discovered:
    @objc func RN_connectGlasses() -> Bool {
        Bridge.log("RN_connectGlasses()")

        if let side = leftPeripheral {
            Bridge.log("G1: connecting to left glass: \(side.name ?? "(unknown)")")
            centralManager!.connect(side, options: nil)
        }

        if let side = rightPeripheral {
            Bridge.log("G1: connecting to right glass: \(side.name ?? "(unknown)")")
            centralManager!.connect(side, options: nil)
        }

        // just return if we don't have both a left and right arm:
        guard leftPeripheral != nil && rightPeripheral != nil else {
            return false
        }

        Bridge.log(
            "G1: found both glasses \(leftPeripheral!.name ?? "(unknown)"), \(rightPeripheral!.name ?? "(unknown)") stopping scan"
        )
        RN_stopScan()

        // get battery status:
        getBatteryStatus()
        return true
    }

    @objc func RN_sendText(_ text: String) {
        Task {
            let displayText = "\(text)"
            guard let textData = displayText.data(using: .utf8) else { return }

            var command: [UInt8] = [
                0x4E, // SEND_RESULT command
                0x00, // sequence number
                0x01, // total packages
                0x00, // current package
                0x71, // screen status (0x70 Text Show | 0x01 New Content)
                0x00, // char position 0
                0x00, // char position 1
                0x01, // page number
                0x01, // max pages
            ]
            command.append(contentsOf: Array(textData))
            self.queueChunks([command])

            // await sendTextWall(text)

            // // await createQuickNoteIfNeeded(text)
            // // await sendQuickNotesToGlasses()
        }

        // @@@@@@@@ just for testing:
        //    Task {
        //      msgId += 1
        //      let ncsNotification = NCSNotification(
        //          msgId: msgId,
        //          appIdentifier: "io.heckel.ntfy",
        //          title: "Notification Title",
        //          subtitle: "Notification Subtitle",
        //          message: text,
        //          displayName: "Example App"
        //      )
        //
        //      let notification = G1Notification(ncsNotification: ncsNotification)
        //      let encodedChunks = await notification.constructNotification()
        //      CoreCommsService.log("encodedChunks: \(encodedChunks.count)")
        //      self.queueChunks(encodedChunks)
        //    }
    }

    func sendTextWall(_ text: String) {
        // clear the screen with the exit command after 3 seconds if the text is empty or a space:
        if CoreManager.shared.powerSavingMode && text.isEmpty || text == " " {
            CoreManager.shared.sendStateWorkItem?.cancel()
            Bridge.log("Mentra: Clearing display after 3 seconds")
            // if we're clearing the display, after a delay, send a clear command if not cancelled with another
            let workItem = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                if CoreManager.shared.isHeadUp {
                    return
                }
                self.exit()
            }
            CoreManager.shared.sendStateWorkItem = workItem
            CoreManager.shared.sendStateQueue.asyncAfter(deadline: .now() + 3, execute: workItem)
        }

        let chunks = textHelper.createTextWallChunks(text)
        // if text.isEmpty {
        //     clearDisplay()
        //     return
        // }
        // let chunks = textHelper.chunkTextForTransmission(text)
        queueChunks(chunks, sleepAfterMs: 10)
    }

    func createQuickNoteIfNeeded(_ text: String) async {
        if quickNotes.count == 0 {
            await addQuickNote(text)
        } else {
            await updateQuickNote(id: quickNotes[0].id, newText: text)
        }
    }

    func sendDoubleTextWall(_ top: String, _ bottom: String) {
        let chunks = textHelper.createDoubleTextWallChunks(textTop: top, textBottom: bottom)
        queueChunks(chunks, sleepAfterMs: 10)

        // quick note testing:
        // Task {
        //   await createQuickNoteIfNeeded(top + "\n" + bottom)
        //   await sendQuickNotesToGlasses()
        // }
    }

    private func sendQuickNotesToGlasses() async {
        //      guard let rightGlass = rightPeripheral,
        //            let leftGlass = leftPeripheral,
        //            let rightTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: rightGlass),
        //            let leftTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: leftGlass) else {
        //          return
        //      }

        // if !self.isHeadUp {
        //   return
        // }

        // First, clear all existing notes
        //      for noteNumber in 1...2 {
        let noteNumber = 1
        var command = Data()
        command.append(Commands.QUICK_NOTE_ADD.rawValue)
        command.append(0x10) // Fixed length for delete command
        command.append(0x00) // Fixed byte
        command.append(0xE0) // Version byte for delete
        command.append(contentsOf: [0x03, 0x01, 0x00, 0x01, 0x00]) // Fixed bytes
        command.append(UInt8(noteNumber)) // Note number to delete
        command.append(contentsOf: [0x00, 0x01, 0x00, 0x01, 0x00, 0x00]) // Fixed bytes for delete

        //          // Send delete command to both glasses with proper timing
        //          rightGlass.writeValue(command, for: rightTxChar, type: .withResponse)
        //          try? await Task.sleep(nanoseconds: 50 * 1_000_000)
        //          leftGlass.writeValue(command, for: leftTxChar, type: .withResponse)
        //          try? await Task.sleep(nanoseconds: 150 * 1_000_000)

        // convert command to array of UInt8
        let commandArray = command.map { $0 }
        queueChunks([commandArray])
        //      }

        // Then add all current notes
        for (index, note) in quickNotes.prefix(4).enumerated() {
            let slotNumber = index + 1

            guard let textData = note.text.data(using: .utf8),
                  let nameData = "Quick Note2".data(using: .utf8)
            else {
                continue
            }

            // Calculate payload length
            let fixedBytes: [UInt8] = [0x03, 0x01, 0x00, 0x01, 0x00]
            let versionByte = UInt8(
                Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 256))
            let payloadLength =
                1 // Fixed byte
                + 1 // Version byte
                + fixedBytes.count // Fixed bytes sequence
                + 1 // Note number
                + 1 // Fixed byte 2
                + 1 // Name length
                + nameData.count // Name bytes
                + 1 // Text length
                + 1 // Fixed byte after text length
                + textData.count // Text bytes
                + 2 // Final bytes

            // Build command
            var command = Data()
            command.append(Commands.QUICK_NOTE_ADD.rawValue)
            command.append(UInt8(payloadLength & 0xFF))
            command.append(0x00) // Fixed byte
            command.append(versionByte)
            command.append(contentsOf: fixedBytes)
            command.append(UInt8(slotNumber))
            command.append(0x01) // Fixed byte 2
            command.append(UInt8(nameData.count))
            command.append(nameData)
            command.append(UInt8(textData.count))
            command.append(0x00) // Fixed byte
            command.append(textData)

            // convert command to array of UInt8
            let commandArray = command.map { $0 }
            queueChunks([commandArray])
        }
    }

    func addQuickNote(_ text: String) async {
        let note = QuickNote(id: UUID(), text: text, timestamp: Date())
        quickNotes.append(note)
    }

    func updateQuickNote(id: UUID, newText: String) async {
        if let index = quickNotes.firstIndex(where: { $0.id == id }) {
            quickNotes[index] = QuickNote(id: id, text: newText, timestamp: Date())
        }
    }

    func removeQuickNote(id: UUID) async {
        quickNotes.removeAll { $0.id == id }
    }

    func clearQuickNotes() async {
        quickNotes.removeAll()
    }

    // only set to true when we receive init_ack response from the glasses
    func setReadiness(left: Bool?, right: Bool?) {
        let prevLeftReady = leftReady
        let prevRightReady = rightReady

        if left != nil {
            leftReady = left!
            if !prevLeftReady, leftReady {
                Bridge.log("Left ready!")
            }
        }
        if right != nil {
            rightReady = right!
            if !prevRightReady, rightReady {
                Bridge.log("Right ready!")
            }
        }

        //         CoreCommsService.log("g1Ready set to \(leftReady) \(rightReady) \(leftReady && rightReady) left: \(left), right: \(right)")
        ready = leftReady && rightReady
        if ready {
            stopReconnectionTimer()
        }
    }

    @objc func RN_stopScan() {
        centralManager!.stopScan()
        Bridge.log("G1: Stopped scanning for devices")
    }

    @objc func RN_getSerialNumberInfo() -> [String: Any] {
        return [
            "serialNumber": glassesSerialNumber ?? "",
            "style": glassesStyle ?? "",
            "color": glassesColor ?? "",
        ]
    }

    func getConnectedBluetoothName() -> String? {
        // Return the name of the first connected peripheral (either left or right)
        if let leftName = leftPeripheral?.name {
            return leftName
        }
        return rightPeripheral?.name
    }

    func disconnect() {
        isDisconnecting = true
        leftGlassUUID = nil
        rightGlassUUID = nil
        stopReconnectionTimer()

        if let left = leftPeripheral {
            centralManager!.cancelPeripheralConnection(left)
        }

        if let right = rightPeripheral {
            centralManager!.cancelPeripheralConnection(right)
        }

        leftPeripheral = nil
        rightPeripheral = nil
        setReadiness(left: false, right: false)
        Bridge.log("G1: Disconnected from glasses")
    }

    // @@@ END REACT NATIVE FUNCTIONS

    actor CommandQueue {
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
    }

    private func setupCommandQueue() {
        Task.detached { [weak self] in
            guard let self = self else { return }

            while true {
                let command = await self.commandQueue.dequeue()
                await self.processCommand(command)
            }
        }
    }

    func resetSemaphoreToZero(_ semaphore: DispatchSemaphore) {
        // First, try to acquire the semaphore with a minimal timeout
        let result = semaphore.wait(timeout: .now() + 0.001)
        if result == .success {
            // We acquired it, meaning it was at least 1
            // Release it to get back to where we were (if it was 1) or to increment it by 1 (if it was >1)
            semaphore.signal()
            // Try to acquire it again to see if it's still available (meaning it was >1 before)
            while semaphore.wait(timeout: .now() + 0.001) == .success {
                // Keep signaling until we're sure we're at 1
                semaphore.signal()
                break
            }
        } else {
            // Timeout occurred, meaning the semaphore was at 0 or less
            // Signal once to try to bring it to 1
            semaphore.signal()
        }
        // bring it down to 0:
        semaphore.wait(timeout: .now() + 0.001)
    }

    private func attemptSend(cmd: BufferedCommand, side: String) async {
        var maxAttempts = 5
        var attempts = 0
        var success = false
        let chunks = cmd.chunks

        while attempts < maxAttempts, !success {
            if attempts > 0 {
                Bridge.log("G1: trying again to send to:\(side): \(attempts)")
            }
            let data = Data(chunks[0])
            // CoreCommsService.log("SEND (\(side)) \(data.hexEncodedString())")

            if isDisconnecting {
                // forget whatever we were doing since we're disconnecting:
                break
            }

            for i in 0 ..< chunks.count - 1 {
                let chunk = chunks[i]

                let firstFewBytes = String(Data(chunk).hexEncodedString().prefix(16))
                // CoreCommsService.log("SEND (\(side)) \(firstFewBytes)")
                await sendCommandToSideWithoutResponse(chunk, side: side)
                try? await Task.sleep(nanoseconds: UInt64(cmd.chunkTimeMs) * 1_000_000) // 8ms
            }

            let lastChunk = chunks.last!

            var sequenceNumber = -1

            // if this is a text chunk, set the sequence to the 2nd byte of the chunk:
            if lastChunk[0] == Commands.BLE_REQ_EVENAI.rawValue {
                sequenceNumber = Int(lastChunk[1])
            }

            if lastChunk[0] == Commands.CRC_CHECK.rawValue {
                sequenceNumber = Int(lastChunk[1])
            }

            if cmd.lastFrameMs > 0 {
                try? await Task.sleep(nanoseconds: UInt64(cmd.lastFrameMs) * 1_000_000) // 100ms
            }

            let firstFewBytes = String(Data(lastChunk).hexEncodedString().prefix(16)).uppercased()
            // don't log if it starts with 25 (heartbeat):
            if lastChunk[0] != Commands.BLE_REQ_HEARTBEAT.rawValue {
                Bridge.log("SEND (\(side)) \(firstFewBytes)")
            }

            //      if (lastChunk[0] == 0x4E) {
            //        sequenceNumber = Int(lastChunk[1])
            //      }

            //      CoreCommsService.log("G1: SENDING with sequenceNumber: \(sequenceNumber)")

            // for heartbeats, don't retry and assume success since the glasses don't respond:
            if lastChunk[0] == Commands.BLE_REQ_HEARTBEAT.rawValue {
                success = true
                await sendCommandToSideWithoutResponse(lastChunk, side: side)
            } else {
                success = await sendCommandToSide2(
                    lastChunk, side: side, attemptNumber: attempts, sequenceNumber: sequenceNumber
                )
            }

            // CoreCommsService.log("command success: \(success)")
            //      if (!success) {
            //        CoreCommsService.log("G1: timed out waiting for \(s)")
            //      }
            //      await sendCommandToSideWithoutResponse(lastChunk, side: side)
            //      success = true

            attempts += 1
            if !success, attempts >= maxAttempts {
                Bridge.log("G1: ❌ Command timed out!")
                startReconnectionTimer()
                break
            }

            if success {
                stopReconnectionTimer()
                // setReadiness(left: true, right: true)
            }
        }
    }

    // Process a single number with timeouts
    private func processCommand(_ command: BufferedCommand) async {
        if command.chunks.isEmpty {
            Bridge.log("G1: @@@ chunks was empty! @@@")
            return
        }

        // Send to both sides in parallel
        await withTaskGroup(of: Void.self) { group in
            if command.sendLeft {
                group.addTask {
                    await self.attemptSend(cmd: command, side: "L")
                }
            }

            if command.sendRight {
                group.addTask {
                    await self.attemptSend(cmd: command, side: "R")
                }
            }

            // Wait for all tasks to complete
            await group.waitForAll()
        }

        if command.waitTime > 0 {
            // wait waitTime milliseconds before moving on to the next command:
            try? await Task.sleep(nanoseconds: UInt64(command.waitTime) * 1_000_000)
        } else {
            // sleep for a min amount of time unless otherwise specified
            try? await Task.sleep(nanoseconds: 8 * 1_000_000) // Xms
        }
    }

    private func waitForSemaphore(semaphore: DispatchSemaphore, timeout: TimeInterval) -> Bool {
        let result = semaphore.wait(timeout: .now() + timeout)
        return result == .success
    }

    func startHeartbeatTimer() {
        // Check if a timer is already running
        if heartbeatTimer != nil, heartbeatTimer!.isValid {
            Bridge.log("G1: Heartbeat timer already running")
            return
        }

        // Create a new queue if needed
        if heartbeatQueue == nil {
            heartbeatQueue = DispatchQueue(
                label: "com.sample.heartbeatTimerQueue", qos: .background
            )
        }

        heartbeatQueue!.async { [weak self] in
            self?.heartbeatTimer = Timer(timeInterval: 20, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                self.sendHeartbeat()
            }

            RunLoop.current.add(self!.heartbeatTimer!, forMode: .default)
            RunLoop.current.run()
        }
    }

    private func findCharacteristic(uuid: CBUUID, peripheral: CBPeripheral) -> CBCharacteristic? {
        for service in peripheral.services ?? [] {
            for characteristic in service.characteristics ?? [] {
                if characteristic.uuid == uuid {
                    return characteristic
                }
            }
        }
        return nil
    }

    private func getConnectedDevices() -> [CBPeripheral] {
        let connectedPeripherals = centralManager!.retrieveConnectedPeripherals(withServices: [
            UART_SERVICE_UUID,
        ])
        return connectedPeripherals
    }

    private func handleAck(from peripheral: CBPeripheral, success: Bool, sequenceNumber: Int = -1) {
        //    CoreCommsService.log("G1: handleAck \(success)")
        if !success { return }

        let side = peripheral == leftPeripheral ? "L" : "R"
        let key = sequenceNumber == -1 ? side : "\(side)-\(sequenceNumber)"

        // CoreCommsService.log("G1: ACK received for \(key)")

        // Resume any pending ACK continuation for this side (thread-safe)
        var continuation: CheckedContinuation<Bool, Never>?
        ackCompletionsQueue.sync(flags: .barrier) {
            continuation = pendingAckCompletions.removeValue(forKey: key)
        }

        // if peripheral == leftPeripheral {
        //     setReadiness(left: true, right: nil)
        // }
        // if peripheral == rightPeripheral {
        //     setReadiness(left: nil, right: true)
        // }

        if let continuation = continuation {
            continuation.resume(returning: true)
            // Core.log("✅ ACK received for \(side) side, resuming continuation")
        }
    }

    private func handleNotification(from peripheral: CBPeripheral, data: Data) {
        guard let command = data.first else { return } // ensure the data isn't empty

        let side = peripheral == leftPeripheral ? "L" : "R"
        let s = peripheral == leftPeripheral ? "L" : "R"
        // Bridge.log("G1: RECV (\(s)) \(data.hexEncodedString())")

        switch Commands(rawValue: command) {
        case .BLE_REQ_INIT:
            handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
            handleInitResponse(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
        case .QUICK_NOTE_ADD:
            handleAck(from: peripheral, success: data[1] == 0x10 || data[1] == 0x43)
        case .BLE_REQ_MIC_ON:
            handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
        case .BRIGHTNESS:
            handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
        case .BLE_EXIT_ALL_FUNCTIONS:
            handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
        case .WHITELIST:
            // TODO: ios no idea why the glasses send 0xCB before sending ACK: (CB == continue!)
            handleAck(
                from: peripheral,
                success: data[1] == 0xCB || data[1] == CommandResponse.ACK.rawValue
            )
        case .DASHBOARD_LAYOUT_COMMAND:
            // 0x06 seems arbitrary :/
            handleAck(from: peripheral, success: data[1] == 0x06)
        case .DASHBOARD_SHOW:
            handleAck(
                from: peripheral, success: data[1] == 0x07 || data[1] == 0x90 || data[1] == 0x0C
            )
        case .HEAD_UP_ANGLE:
            handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
        case .CRC_CHECK:
            handleAck(from: peripheral, success: true, sequenceNumber: Int(data[1]))
        case .BMP_END:
            handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
        case .SILENT_MODE:
            handleAck(from: peripheral, success: data[1] == CommandResponse.ACK.rawValue)
        case .BLE_REQ_TRANSFER_MIC_DATA:
            // compressedVoiceData = data
            CoreManager.shared.handleGlassesMicData(data)
        //                CoreCommsService.log("G1: Got voice data: " + String(data.count))
        case .UNK_1:
            handleAck(from: peripheral, success: true)
        case .UNK_2:
            handleAck(from: peripheral, success: true)
        case .BLE_REQ_HEARTBEAT:
            Bridge.log("heartbeatCounter: \(heartbeatCounter) data[1]: \(data[1])")
            handleAck(from: peripheral, success: data[1] == heartbeatCounter - 1)
        case .BLE_REQ_BATTERY:
            // TODO: ios handle semaphores correctly here
            // battery info
            guard data.count >= 6 && data[1] == 0x66 else {
                break
            }

            handleAck(from: peripheral, success: data[1] == 0x66)

            // Response format: 2C 66 [battery%] [flags] [voltage_low] [voltage_high] ...
            let batteryPercent = Int(data[2])
            let flags = data[3]
            let voltageLow = Int(data[4])
            let voltageHigh = Int(data[5])
            let rawVoltage = (voltageHigh << 8) | voltageLow
            let voltage = rawVoltage / 10 // Scale down by 10 to get actual millivolts

            //      CoreCommsService.log("G1: Raw battery data - Battery: \(batteryPercent)%, Voltage: \(voltage)mV, Flags: 0x\(String(format: "%02X", flags))")

            // if left, update left battery level, if right, update right battery level
            if peripheral == leftPeripheral {
                if leftBatteryLevel != batteryPercent {
                    Bridge.log("G1: Left glass battery: \(batteryPercent)%")
                    leftBatteryLevel = batteryPercent
                }
            } else if peripheral == rightPeripheral {
                if rightBatteryLevel != batteryPercent {
                    Bridge.log("G1: Right glass battery: \(batteryPercent)%")
                    rightBatteryLevel = batteryPercent
                }
            }

            // update the main battery level as the lower of the two
            let newBatteryLevel = min(leftBatteryLevel, rightBatteryLevel)
            if batteryLevel != newBatteryLevel {
                batteryLevel = min(leftBatteryLevel, rightBatteryLevel)
            }
        case .BLE_REQ_EVENAI:
            guard data.count > 1 else { break }
            handleAck(
                from: peripheral, success: data[1] == CommandResponse.ACK.rawValue,
                sequenceNumber: Int(data[2])
            )
        case .BLE_REQ_DEVICE_ORDER:
            let order = data[1]
            switch DeviceOrders(rawValue: order) {
            case .HEAD_UP:
                Bridge.log("G1: HEAD_UP")
                isHeadUp = true
                CoreManager.shared.updateHeadUp(isHeadUp)
            case .HEAD_UP2:
                Bridge.log("G1: HEAD_UP2")
                isHeadUp = true
                CoreManager.shared.updateHeadUp(isHeadUp)
            // case .HEAD_DOWN:
            //   CoreCommsService.log("HEAD_DOWN")
            //   isHeadUp = false
            //   break
            case .HEAD_DOWN2:
                Bridge.log("G1: HEAD_DOWN2")
                isHeadUp = false
                CoreManager.shared.updateHeadUp(isHeadUp)
            case .ACTIVATED:
                Bridge.log("G1: ACTIVATED")
            case .SILENCED:
                Bridge.log("G1: SILENCED")
            case .DISPLAY_READY:
                Bridge.log("G1: DISPLAY_READY")
            //        sendInitCommand(to: peripheral)// experimental
            case .TRIGGER_FOR_AI:
                Bridge.log("G1: TRIGGER AI")
            case .TRIGGER_FOR_STOP_RECORDING:
                Bridge.log("G1: STOP RECORDING")
            case .TRIGGER_CHANGE_PAGE:
                Bridge.log("G1: TRIGGER_CHANGE_PAGE")
            case .CASE_REMOVED:
                Bridge.log("G1: REMOVED FROM CASE")
                caseRemoved = true
                CoreManager.shared.handle_request_status()
            case .CASE_REMOVED2:
                Bridge.log("G1: REMOVED FROM CASE2")
                caseRemoved = true
                CoreManager.shared.handle_request_status()
            case .CASE_OPEN:
                caseOpen = true
                caseRemoved = false
                Bridge.log("G1: CASE OPEN")
                CoreManager.shared.handle_request_status()
            case .CASE_CLOSED:
                caseOpen = false
                caseRemoved = false
                Bridge.log("G1: CASE CLOSED")
                CoreManager.shared.handle_request_status()
            case .CASE_CHARGING_STATUS:
                guard data.count >= 3 else { break }
                let status = data[2]
                if status == 0x01 {
                    caseCharging = true
                    Bridge.log("G1: CASE CHARGING")
                } else {
                    caseCharging = false
                    Bridge.log("G1: CASE NOT CHARGING")
                }
            case .CASE_CHARGE_INFO:
                Bridge.log("G1: CASE CHARGE INFO")
                guard data.count >= 3 else { break }
                if Int(data[2]) != -1 {
                    caseBatteryLevel = Int(data[2])
                    Bridge.log("G1: Case battery level: \(caseBatteryLevel)%")
                } else {
                    Bridge.log("G1: Case battery level was -1")
                }
            case .DOUBLE_TAP:
                Bridge.log("G1: DOUBLE TAP / display turned off")
            //        Task {
            ////          RN_sendText("DOUBLE TAP DETECTED")
            ////          queueChunks([[UInt8(0x00), UInt8(0x01)]])
            //          try? await Task.sleep(nanoseconds: 1500 * 1_000_000) // 2s delay after sending
            //          sendInit()
            //          clearState()
            //        }
            default:
                //                 Core.log("G1: Received device order: \(data.subdata(in: 1..<data.count).hexEncodedString())")
                break
            }
        default:
            Bridge.log("G1: received from G1(not handled): \(data.hexEncodedString())")
        }
    }
}

// MARK: Commands

extension G1 {
    // Handle whitelist functionality
    func getWhitelistChunks() -> [[UInt8]] {
        // Define the hardcoded whitelist JSON
        let apps = [
            ["id": "com.mentra.os", "name": "MentraOS"],
            ["id": "io.heckel.ntfy", "name": "ntfy"],
        ]
        let whitelistJson = createWhitelistJson(apps: apps)

        Bridge.log("G1: Creating chunks for hardcoded whitelist: \(whitelistJson)")

        // Convert JSON to bytes and split into chunks
        return createWhitelistChunks(json: whitelistJson)
    }

    private func createWhitelistJson(apps: [[String: String]]) -> String {
        do {
            // Create app list array
            var appList: [[String: Any]] = []
            for app in apps {
                let appDict: [String: Any] = [
                    "id": app["id"] ?? "",
                    "name": app["name"] ?? "",
                ]
                appList.append(appDict)
            }

            // Create the whitelist dictionary
            let whitelistDict: [String: Any] = [
                "calendar_enable": true,
                "call_enable": true,
                "msg_enable": true,
                "ios_mail_enable": true,
                "app": [
                    "list": appList,
                    "enable": true,
                ],
            ]

            // Convert to JSON string
            let jsonData = try JSONSerialization.data(withJSONObject: whitelistDict, options: [])
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                return jsonString
            } else {
                return "{}"
            }
        } catch {
            Bridge.log("G1: Error creating whitelist JSON: \(error.localizedDescription)")
            return "{}"
        }
    }

    // Helper function to split JSON into chunks
    private func createWhitelistChunks(json: String) -> [[UInt8]] {
        let MAX_CHUNK_SIZE = 180 - 4 // Reserve space for the header
        guard let jsonData = json.data(using: .utf8) else { return [] }

        let totalChunks = Int(ceil(Double(jsonData.count) / Double(MAX_CHUNK_SIZE)))
        var chunks: [Data] = []

        Bridge.log("G1: jsonData.count = \(jsonData.count), totalChunks = \(totalChunks)")

        for i in 0 ..< totalChunks {
            let start = i * MAX_CHUNK_SIZE
            let end = min(start + MAX_CHUNK_SIZE, jsonData.count)
            let range = start ..< end
            let payloadChunk = jsonData.subdata(in: range)

            // Create the header: [WHITELIST_CMD, total_chunks, chunk_index]
            var headerData = Data()
            headerData.append(Commands.WHITELIST.rawValue)
            headerData.append(UInt8(totalChunks))
            headerData.append(UInt8(i))

            // Combine header and payload
            var chunkData = Data()
            chunkData.append(headerData)
            chunkData.append(payloadChunk)

            chunks.append(chunkData)
        }

        var uintChunks: [[UInt8]] = []
        for chunk in chunks {
            uintChunks.append(Array(chunk))
        }
        return uintChunks
        //    return chunks.flatMap { Array($0) }
    }

    func exitAllFunctions(to peripheral: CBPeripheral, characteristic: CBCharacteristic) {
        var data = Data()
        data.append(Commands.BLE_EXIT_ALL_FUNCTIONS.rawValue)
        peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
    }

    private func sendInitCommand(to peripheral: CBPeripheral) {
        let initData = Data([Commands.BLE_REQ_INIT.rawValue, 0x01])
        let initDataArray = initData.map { UInt8($0) }

        if leftPeripheral == peripheral {
            queueChunks([initDataArray], sendLeft: true, sendRight: false)
        } else if rightPeripheral == peripheral {
            queueChunks([initDataArray], sendLeft: false, sendRight: true)
        }
    }

    private func sendInit() {
        let initData = Data([Commands.BLE_REQ_INIT.rawValue, 0x01])
        let initDataArray = initData.map { UInt8($0) }
        queueChunks([initDataArray])
    }

    func exit() {
        let exitData = Data([Commands.BLE_EXIT_ALL_FUNCTIONS.rawValue])
        let exitDataArray = exitData.map { UInt8($0) }
        queueChunks([exitDataArray])
    }

    func sendRgbLedControl(
        requestId: String, packageName _: String?, action _: String, color _: String?,
        ontime _: Int, offtime _: Int, count _: Int
    ) {
        Bridge.log("sendRgbLedControl - not supported on G1")
        Bridge.sendRgbLedControlResponse(
            requestId: requestId, success: false, error: "device_not_supported"
        )
    }

    // don't call semaphore signals here as it's handled elswhere:
    private func handleInitResponse(from peripheral: CBPeripheral, success: Bool) {
        if peripheral == leftPeripheral {
            leftInitialized = success
            // CoreCommsService.log("G1: Left arm initialized: \(success)")
            setReadiness(left: true, right: nil)
        } else if peripheral == rightPeripheral {
            rightInitialized = success
            // CoreCommsService.log("G1: Right arm initialized: \(success)")
            setReadiness(left: nil, right: true)
        }

        // Only proceed if both glasses are initialized
        if leftInitialized, rightInitialized {
            setReadiness(left: true, right: true)
        }
    }

    private func sendHeartbeat() {
        incrementHeartbeatCounter()

        var heartbeatData = Data()
        // heartbeatData.append(Commands.BLE_REQ_HEARTBEAT.rawValue)
        // heartbeatData.append(UInt8(0x02 & 0xFF))
        heartbeatData.append(Commands.BLE_REQ_HEARTBEAT.rawValue)
        heartbeatData.append(UInt8(heartbeatCounter & 0xFF))

        var heartbeatArray = heartbeatData.map { UInt8($0) }

        if ready {
            queueChunks([heartbeatArray])
        }

        // Periodically request battery status
        if leftBatteryLevel == -1 || rightBatteryLevel == -1 || heartbeatCounter % 10 == 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.getBatteryStatus()
            }
        }
        //    if let txChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: peripheral) {
        //      let hexString = heartbeatData.map { String(format: "%02X", $0) }.joined()
        //      peripheral.writeValue(heartbeatData, for: txChar, type: .withoutResponse)
        //    }
    }

    func sendCommandToSide(_ command: [UInt8], side: String) async {
        // Convert to Data
        let commandData = Data(command)
        //    CoreCommsService.log("G1: Sending command to glasses: \(paddedCommand.map { String(format: "%02X", $0) }.joined(separator: " "))")
        // CoreCommsService.log("G1: SEND (\(side)) \(commandData.hexEncodedString())")

        if side == "L" {
            // send to left
            if let leftPeripheral = leftPeripheral,
               let characteristic = leftPeripheral.services?
               .first(where: { $0.uuid == UART_SERVICE_UUID })?
               .characteristics?
               .first(where: { $0.uuid == UART_TX_CHAR_UUID })
            {
                leftPeripheral.writeValue(commandData, for: characteristic, type: .withResponse)
            }
        } else {
            // send to right
            if let rightPeripheral = rightPeripheral,
               let characteristic = rightPeripheral.services?
               .first(where: { $0.uuid == UART_SERVICE_UUID })?
               .characteristics?
               .first(where: { $0.uuid == UART_TX_CHAR_UUID })
            {
                rightPeripheral.writeValue(commandData, for: characteristic, type: .withResponse)
            }
        }
    }

    func sendCommandToSide2(
        _ command: [UInt8], side: String, attemptNumber: Int = 0, sequenceNumber: Int = -1
    ) async -> Bool {
        let startTime = Date()

        // Convert to Data
        let commandData = Data(command)

        return await withCheckedContinuation { continuation in
            var peripheral: CBPeripheral? = nil
            var characteristic: CBCharacteristic? = nil

            if side == "L" {
                // send to left
                peripheral = leftPeripheral
                characteristic = leftPeripheral?.services?
                    .first(where: { $0.uuid == UART_SERVICE_UUID })?
                    .characteristics?
                    .first(where: { $0.uuid == UART_TX_CHAR_UUID })
            } else {
                // send to right
                peripheral = rightPeripheral
                characteristic = rightPeripheral?.services?
                    .first(where: { $0.uuid == UART_SERVICE_UUID })?
                    .characteristics?
                    .first(where: { $0.uuid == UART_TX_CHAR_UUID })
            }

            if peripheral == nil || characteristic == nil {
                Bridge.log("G1: ⚠️ peripheral/characteristic not found, resuming immediately")
                //        continuation.resume()
                continuation.resume(returning: false)
                return
            }

            let key = sequenceNumber == -1 ? side : "\(side)-\(sequenceNumber)"

            // Store continuation for ACK callback (thread-safe)
            ackCompletionsQueue.async(flags: .barrier) {
                self.pendingAckCompletions[key] = continuation
            }

            peripheral!.writeValue(commandData, for: characteristic!, type: .withResponse)

            let waitTime = 0.3 + (0.2 * Double(attemptNumber))

            // after 200ms, if we haven't received the ack, resume:
            DispatchQueue.main.asyncAfter(deadline: .now() + waitTime) {
                // Check if ACK continuation still exists (if it does, ACK wasn't received)
                var pendingContinuation: CheckedContinuation<Bool, Never>?
                self.ackCompletionsQueue.sync(flags: .barrier) {
                    pendingContinuation = self.pendingAckCompletions.removeValue(forKey: key)
                }

                if let pendingContinuation = pendingContinuation {
                    let elapsed = Date().timeIntervalSince(startTime) * 1000
                    Bridge.log(
                        "G1: ⚠️ ACK timeout for \(key) after \(String(format: "%.0f", elapsed))ms")
                    pendingContinuation.resume(returning: false)
                }
            }
        }
    }

    // FAST BLE TRANSMISSION (.withoutResponse)
    func sendCommandToSideWithoutResponse(_ command: [UInt8], side: String) async {
        // Convert to Data
        let commandData = Data(command)

        if side == "L" {
            // send to left
            if let leftPeripheral = leftPeripheral,
               let characteristic = leftPeripheral.services?
               .first(where: { $0.uuid == UART_SERVICE_UUID })?
               .characteristics?
               .first(where: { $0.uuid == UART_TX_CHAR_UUID })
            {
                // Fast approach: .withoutResponse for speed
                leftPeripheral.writeValue(commandData, for: characteristic, type: .withoutResponse)
            }
        } else {
            // send to right
            if let rightPeripheral = rightPeripheral,
               let characteristic = rightPeripheral.services?
               .first(where: { $0.uuid == UART_SERVICE_UUID })?
               .characteristics?
               .first(where: { $0.uuid == UART_TX_CHAR_UUID })
            {
                // Fast approach: .withoutResponse for speed
                rightPeripheral.writeValue(commandData, for: characteristic, type: .withoutResponse)
            }
        }

        // No waiting for ACK - fire and forget for speed
    }

    func queueChunks(
        _ chunks: [[UInt8]], sendLeft: Bool = true, sendRight: Bool = true, sleepAfterMs: Int = 0,
        ignoreAck: Bool = false, chunkTimeMs: Int = 8, lastFrameMs: Int = 100
    ) {
        let bufferedCommand = BufferedCommand(
            chunks: chunks, sendLeft: sendLeft, sendRight: sendRight, waitTime: sleepAfterMs,
            ignoreAck: ignoreAck, chunkTimeMs: chunkTimeMs, lastFrameMs: lastFrameMs
        )
        Task {
            await commandQueue.enqueue(bufferedCommand)
        }
    }

    @objc func RN_sendWhitelist() {
        Bridge.log("G1: RN_sendWhitelist()")
        let whitelistChunks = getWhitelistChunks()
        queueChunks(whitelistChunks, sendLeft: true, sendRight: true, sleepAfterMs: 100)
    }

    func setBrightness(_ level: Int, autoMode: Bool = false) {
        // Convert from percentage (0-100) to the correct range (0-41)
        let mappedLevel = min(41, max(0, Int((Double(level) / 100.0) * 41.0)))

        // Create and capture the UInt8 value
        let brightnessLevel = UInt8(mappedLevel)

        // Call the async function from a non-async context
        Task {
            let success = await setBrightnessRaw(brightnessLevel, autoMode: autoMode)
            if !success {
                NSLog("Failed to set brightness to level \(level)% (mapped to \(mappedLevel))")
            }
        }
    }

    func setBrightnessRaw(_ level: UInt8, autoMode: Bool = false) async -> Bool {
        Bridge.log("G1: setBrightness()")
        // Ensure level is between 0x00 and 0x29 (0-41)
        var lvl: UInt8 = level
        if level > 0x29 {
            lvl = 0x29
        }

        let command: [UInt8] = [Commands.BRIGHTNESS.rawValue, lvl, autoMode ? 0x01 : 0x00]
        queueChunks([command])

        // buried data point testing:
        //    let command: [UInt8] = [0x3E]
        //    queueChunks([command])

        //    // Send to both glasses with proper timing
        //    if let rightGlass = rightPeripheral,
        //       let rightTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: rightGlass) {
        //      rightGlass.writeValue(Data(command), for: rightTxChar, type: .withResponse)
        //      try? await Task.sleep(nanoseconds: 50 * 1_000_000) // 50ms delay
        //    }
        //
        //    if let leftGlass = leftPeripheral,
        //       let leftTxChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: leftGlass) {
        //      leftGlass.writeValue(Data(command), for: leftTxChar, type: .withResponse)
        //    }

        return true
    }

    func setHeadUpAngle(_ angle: Int) {
        var agl: Int = angle
        if angle < 0 {
            agl = 0
        } else if angle > 60 {
            agl = 60
        }

        // Call the async function from a non-async context
        Task {
            await setHeadUpAngleRaw(UInt8(agl))
        }
    }

    func setHeadUpAngleRaw(_ angle: UInt8) async {
        Bridge.log("G1: setHeadUpAngle()")
        let command: [UInt8] = [Commands.HEAD_UP_ANGLE.rawValue, angle, 0x01]
        queueChunks([command])
    }

    func getBatteryStatus() {
        Bridge.log("G1: getBatteryStatus()")
        let command: [UInt8] = [Commands.BLE_REQ_BATTERY.rawValue, 0x01]
        queueChunks([command])
    }

    func setSilentMode(_ enabled: Bool) async {
        let command: [UInt8] = [Commands.SILENT_MODE.rawValue, enabled ? 0x0C : 0x0A, 0x00]
        queueChunks([command])
    }

    func setDashboardPosition(_ height: Int, _ depth: Int) {
        Task {
            await setDashboardPositionRaw(UInt8(height), UInt8(depth))
        }
    }

    func incrementGlobalCounter() {
        if globalCounter < 255 {
            globalCounter += 1
        } else {
            globalCounter = 0
        }
    }

    func incrementHeartbeatCounter() {
        if heartbeatCounter < 255 {
            heartbeatCounter += 1
        } else {
            heartbeatCounter = 0
        }
    }

    func setDashboardPositionRaw(_ height: UInt8, _ depth: UInt8) async -> Bool {
        let h: UInt8 = min(max(height, 0), 8)
        let d: UInt8 = min(max(depth, 1), 9)

        incrementGlobalCounter()

        // Build dashboard position command
        var command = Data()
        command.append(Commands.DASHBOARD_LAYOUT_COMMAND.rawValue)
        command.append(0x08) // Length
        command.append(0x00) // Sequence
        command.append(globalCounter & 0xFF) // Fixed value
        command.append(0x02) // Fixed value
        command.append(0x01) // State ON
        command.append(h) // height
        command.append(d) // depth

        //    while command.count < 20 {
        //      command.append(0x00)
        //    }

        // convert command to array of UInt8
        let commandArray = command.map { $0 }
        queueChunks([commandArray])
        return true
    }

    func setMicEnabled(_ enabled: Bool) {
        Bridge.log("G1: setMicEnabled() \(enabled)")
        micEnabled = enabled
        var micOnData = Data()
        micOnData.append(Commands.BLE_REQ_MIC_ON.rawValue)
        if enabled {
            micOnData.append(0x01)
        } else {
            micOnData.append(0x00)
        }

        let micOnDataArray: [UInt8] = micOnData.map { UInt8($0) }

        queueChunks([micOnDataArray], sendLeft: false, sendRight: true)

        //    if let txChar = findCharacteristic(uuid: UART_TX_CHAR_UUID, peripheral: peripheral) {
        //      peripheral.writeValue(micOnData, for: txChar, type: .withResponse)
        //    }
    }

    func sortMicRanking(list: [String]) -> [String] {
        return list
    }

    // MARK: - Enhanced BMP Display Methods

    func displayBitmap(base64ImageData: String) async -> Bool {
        guard let bmpData = Data(base64Encoded: base64ImageData) else {
            Bridge.log("G1: Failed to decode base64 image data")
            return false
        }

        Bridge.log("G1: ✅ Successfully decoded base64 image data to \(bmpData.count) bytes")
        let invertedBmpData = invertBmpPixels(bmpData)
        let result = await sendBmp(bmpData: invertedBmpData)
        Bridge.log("G1: 🖼️ Single frame: Transmission \(result ? "SUCCESS" : "FAILED")")
        return result
    }

    func clearDisplay() {
        Bridge.log("G1: clearDisplay() - Using space")
        sendTextWall(" ")
    }

    /// Create a simple test BMP pattern in hex format
    private func createTestBMPHex() -> String {
        // BMP header for 576x135 1-bit monochrome (from our working data)
        let header =
            "424d36260000000000003e0000002800000040020000870000000100010000000000f82500c40e0000c40e00000200000002000000000000ffffff00"

        // Create a simple pattern: alternating lines
        var pixelData = ""
        let bytesPerRow = 72 // 576 pixels / 8 bits per byte

        for row in 0 ..< 135 {
            for col in 0 ..< bytesPerRow {
                // Create a pattern: every other row is different
                if row % 10 < 5 {
                    pixelData += "ff" // White line
                } else {
                    pixelData += col % 4 == 0 ? "00" : "ff" // Pattern line
                }
            }
        }

        return header + pixelData
    }

    private func invertBmpPixels(_ bmpData: Data) -> Data {
        guard bmpData.count > 62 else {
            Bridge.log("G1: BMP data too small to contain pixel data")
            return bmpData
        }

        // BMP header is 62 bytes for your format (14 byte file header + 40 byte DIB header + 8 byte color table)
        let headerSize = 62
        var invertedData = Data(bmpData.prefix(headerSize)) // Keep header unchanged

        // Invert the pixel data (everything after the header)
        let pixelData = bmpData.dropFirst(headerSize)

        for byte in pixelData {
            // Invert each byte (flip all bits)
            let invertedByte = ~byte
            invertedData.append(invertedByte)
        }

        Bridge.log("G1: Inverted BMP pixels: \(pixelData.count) bytes processed")
        return invertedData
    }

    // Core MentraOS-compatible BMP display implementation
    private func sendBmp(bmpData: Data) async -> Bool {
        // Frame timing validation for animation smoothness
        let currentTime = Date()
        let timeSinceLastFrame = currentTime.timeIntervalSince(lastFrameTime)

        // Update frame tracking
        frameSequence += 1
        lastFrameTime = currentTime

        Bridge.log(
            "G1: 🎬 Frame \(frameSequence): \(String(format: "%.0f", timeSinceLastFrame * 1000))ms since last frame"
        )

        // MentraOS constants - exact match
        let packLen = 194 // Exact chunk size from MentraOS
        let iosDelayMs = 8 // iOS delay from MentraOS
        let addressBytes: [UInt8] = [0x00, 0x1C, 0x00, 0x00] // Address from MentraOS

        //    // Debug: Check bmpData integrity before chunking
        //    let pixelDataStart = 62
        //    if bmpData.count > pixelDataStart + 50 {
        //      let beforeChunkSample = Array(bmpData[pixelDataStart..<(pixelDataStart + 20)])
        //      let beforeChunkHex = beforeChunkSample.map { String(format: "%02X", $0) }.joined(separator: " ")
        //      CoreCommsService.log("G1: 🔍 Before chunking - pixel data sample (bytes 62-82): \(beforeChunkHex)")
        //    }

        // Create chunks exactly like MentraOS
        var multiPacks: [Data] = []
        var index = 0
        while index < bmpData.count {
            let end = min(index + packLen, bmpData.count)
            let singlePack = bmpData.subdata(in: index ..< end)

            // Debug first few chunks to see where corruption happens
            if index < 600 { // First 3 chunks (194 * 3 = 582)
                let chunkSample = Array(singlePack.prefix(20))
                let chunkHex = chunkSample.map { String(format: "%02X", $0) }.joined(separator: " ")
                Bridge.log("G1: 🔍 Chunk creation - index \(index), sample: \(chunkHex)")
            }

            multiPacks.append(singlePack)
            index += packLen
        }

        Bridge.log("G1: Created \(multiPacks.count) packs from BMP data (MentraOS format)")

        var chunks: [[UInt8]] = []

        // add bmp data chunks:
        for (packIndex, pack) in multiPacks.enumerated() {
            let packData: Data
            if packIndex == 0 {
                // First package includes address: [0x15, index, address...]
                var firstPacketData = Data([0x15, UInt8(packIndex & 0xFF)])
                firstPacketData.append(Data(addressBytes))
                firstPacketData.append(pack)
                packData = firstPacketData
            } else {
                // Subsequent packages: [0x15, index, data...]
                var packetData = Data([0x15, UInt8(packIndex & 0xFF)])
                packetData.append(pack)
                packData = packetData
            }

            chunks.append(Array(packData))
        }

        //    queueChunks(chunks)
        //    chunks.removeAll()

        // add end command:
        chunks.append([0x20, 0x0D, 0x0E])

        queueChunks(chunks, sleepAfterMs: 25, lastFrameMs: 100)
        chunks.removeAll()

        // CRC validation like MentraOS - frame 1 should be 0x1914adcf
        var imageWithAddress = Data(addressBytes)
        imageWithAddress.append(bmpData)

        // Calculate CRC32-XZ like MentraOS (not standard CRC32)
        let crc32Value = calculateCRC32XZ(data: imageWithAddress)
        let crcBytes = Data([
            UInt8((crc32Value >> 24) & 0xFF),
            UInt8((crc32Value >> 16) & 0xFF),
            UInt8((crc32Value >> 8) & 0xFF),
            UInt8(crc32Value & 0xFF),
        ])

        var crcCommand = Data([0x16])
        crcCommand.append(crcBytes)

        chunks.append(Array(crcCommand))
        queueChunks(chunks)
        return true
    }

    // Helper function to calculate CRC32-XZ like MentraOS (matches Dart crclib)
    private func calculateCRC32XZ(data: Data) -> UInt32 {
        // CRC32-XZ table-based implementation (matches Dart crclib exactly)
        let polynomial: UInt32 = 0x04C1_1DB7
        var crc: UInt32 = 0xFFFF_FFFF

        // Build CRC table for efficiency (matches crclib behavior)
        var table: [UInt32] = Array(repeating: 0, count: 256)
        for i in 0 ..< 256 {
            var entry = UInt32(i) << 24
            for _ in 0 ..< 8 {
                if (entry & 0x8000_0000) != 0 {
                    entry = (entry << 1) ^ polynomial
                } else {
                    entry <<= 1
                }
            }
            table[i] = entry
        }

        // Calculate CRC using table lookup (matches MentraOS's crclib)
        for byte in data {
            let tableIndex = Int((crc >> 24) ^ UInt32(byte)) & 0xFF
            crc = (crc << 8) ^ table[tableIndex]
        }

        return ~crc
    }

    // Helper function to calculate CRC32 (simple implementation)
    private func calculateCRC32(data: Data) -> UInt32 {
        let polynomial: UInt32 = 0xEDB8_8320
        var crc: UInt32 = 0xFFFF_FFFF

        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0 ..< 8 {
                if (crc & 1) != 0 {
                    crc = (crc >> 1) ^ polynomial
                } else {
                    crc = crc >> 1
                }
            }
        }

        return ~crc
    }

    /// Create BMP chunks with MentraOS-compatible headers
    private func createBmpChunks(from bmpData: Data, chunkSize: Int) -> [[UInt8]] {
        var chunks: [[UInt8]] = []
        let glassesAddress: [UInt8] = [0x00, 0x1C, 0x00, 0x00] // MentraOS uses address 0x1c

        let totalChunks = (bmpData.count + chunkSize - 1) / chunkSize

        for i in 0 ..< totalChunks {
            let start = i * chunkSize
            let end = min(start + chunkSize, bmpData.count)
            let chunkData = bmpData.subdata(in: start ..< end)

            var chunk: [UInt8] = []

            // First chunk needs address bytes
            if i == 0 {
                chunk.append(0x15) // Command
                chunk.append(UInt8(i & 0xFF)) // Sequence
                chunk.append(contentsOf: glassesAddress) // Address
                chunk.append(contentsOf: chunkData)
            } else {
                chunk.append(0x15) // Command
                chunk.append(UInt8(i & 0xFF)) // Sequence
                chunk.append(contentsOf: chunkData)
            }

            chunks.append(chunk)
        }

        return chunks
    }

    /// Send CRC with retry logic
    private func sendBmpCrcWithRetry(
        bmpData: Data,
        sendLeft: Bool,
        sendRight: Bool,
        maxAttempts: Int,
        timeoutMs: Int
    ) async -> Bool {
        // Create data with address for CRC calculation (MentraOS pattern)
        let glassesAddress: [UInt8] = [0x00, 0x1C, 0x00, 0x00] // Same address as in chunks
        var dataWithAddress = Data(glassesAddress)
        dataWithAddress.append(bmpData)

        // Calculate CRC32 (simplified - in a real implementation, use proper CRC32-XZ)
        let crcValue = dataWithAddress.crc32

        // Create CRC command packet
        var crcCommand: [UInt8] = [0x16] // CRC command
        crcCommand.append(UInt8((crcValue >> 24) & 0xFF))
        crcCommand.append(UInt8((crcValue >> 16) & 0xFF))
        crcCommand.append(UInt8((crcValue >> 8) & 0xFF))
        crcCommand.append(UInt8(crcValue & 0xFF))

        Bridge.log("G1: Sending CRC command, CRC value: \(String(format: "%08x", crcValue))")

        // Send CRC with retry
        for attempt in 0 ..< maxAttempts {
            queueChunks([crcCommand], sendLeft: sendLeft, sendRight: sendRight)

            // Wait for CRC command to process
            try? await Task.sleep(nanoseconds: UInt64(timeoutMs * 1_000_000))

            // For now, assume success (in a real implementation, you'd check for ACK)
            Bridge.log("G1: CRC command sent successfully")
            return true
        }
        // Bridge.log("G1: CRC command failed, attempt \(attempt + 1)")
        Bridge.log("G1: Failed to send CRC command after \(maxAttempts) attempts")
        return false
    }
}

// MARK: BLE Stubs

extension G1: CBCentralManagerDelegate, CBPeripheralDelegate {
    func getWriteCharacteristic(for peripheral: CBPeripheral?) -> CBCharacteristic? {
        guard let peripheral = peripheral else { return nil }
        for service in peripheral.services ?? [] {
            if service.uuid == UART_SERVICE_UUID {
                for characteristic in service.characteristics ?? []
                    where characteristic.uuid == UART_TX_CHAR_UUID
                {
                    return characteristic
                }
            }
        }
        return nil
    }

    func extractIdNumber(_ string: String) -> Int? {
        // Pattern to match "G1_" followed by digits, followed by "_"
        let pattern = "G1_(\\d+)_"

        // Create a regular expression
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return nil
        }

        // Look for matches in the input string
        let range = NSRange(string.startIndex ..< string.endIndex, in: string)
        guard let match = regex.firstMatch(in: string, options: [], range: range) else {
            return nil
        }

        // Extract the captured group (the digits)
        if let matchRange = Range(match.range(at: 1), in: string) {
            let idString = String(string[matchRange])
            return Int(idString)
        }

        return nil
    }

    func emitDiscoveredDevice(_ name: String) {
        if name.contains("_L_") || name.contains("_R_") {
            // exampleName = "Even G1_74_L_57863C", "Even G1_3_L_57863C", "Even G1_100_L_57863C"
            guard let deviceName = extractIdNumber(name) else {
                Bridge.log("Failed to extract ID number from device name: \(name)")
                return
            }
            let modelName = "Even Realities G1"
            let dName = "\(deviceName)"
            Bridge.sendDiscoveredDevice(modelName, dName)
        } else {
            Bridge.log("Unknown device type: \(name)")
        }
    }

    // On BT discovery, automatically connect to both arms if we have them:
    func centralManager(
        _: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any],
        rssi _: NSNumber
    ) {
        guard let name = peripheral.name else { return }
        guard name.contains("Even G1") else { return }

        Bridge.log("G1: found peripheral: \(name) - SEARCH_ID: \(DEVICE_SEARCH_ID)")

        // Only process serial number for devices that match our search ID
        if name.contains(DEVICE_SEARCH_ID) {
            // Extract manufacturer data to decode serial number
            if let manufacturerData = advertisementData[CBAdvertisementDataManufacturerDataKey]
                as? Data
            {
                Bridge.log("G1: 📱 Found manufacturer data: \(manufacturerData.hexEncodedString())")

                // Try to decode serial number from manufacturer data
                if let decodedSerial = decodeSerialFromManufacturerData(manufacturerData) {
                    Bridge.log("G1: 📱 Decoded serial number: \(decodedSerial)")

                    // Decode style and color from serial number
                    let (style, color) = G1.decodeEvenG1SerialNumber(decodedSerial)
                    Bridge.log("G1: 📱 Style: \(style), Color: \(color)")

                    // Store the information
                    glassesSerialNumber = decodedSerial
                    glassesStyle = style
                    glassesColor = color

                    // Emit the serial number information
                    emitSerialNumberInfo(serialNumber: decodedSerial, style: style, color: color)
                } else {
                    Bridge.log("G1: 📱 Could not decode serial number from manufacturer data")
                }
            } else {
                Bridge.log("G1: 📱 No manufacturer data found in advertisement")
            }
        }

        if name.contains("_L_"), name.contains(DEVICE_SEARCH_ID) {
            Bridge.log("G1: Found left arm: \(name)")
            leftPeripheral = peripheral
        } else if name.contains("_R_"), name.contains(DEVICE_SEARCH_ID) {
            Bridge.log("G1: Found right arm: \(name)")
            rightPeripheral = peripheral
        }

        emitDiscoveredDevice(name)

        if leftPeripheral != nil, rightPeripheral != nil {
            //      central.stopScan()
            RN_connectGlasses()
        }
    }

    func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Bridge.log(
            "G1: centralManager(_:didConnect:) device connected!: \(peripheral.name ?? "Unknown")")
        peripheral.delegate = self
        peripheral.discoverServices([UART_SERVICE_UUID])

        // Store the UUIDs for future reconnection
        if peripheral == leftPeripheral || (peripheral.name?.contains("_L_") ?? false) {
            Bridge.log("G1: 🔵 Storing left glass UUID: \(peripheral.identifier.uuidString)")
            leftGlassUUID = peripheral.identifier
            leftPeripheral = peripheral
        }

        if peripheral == rightPeripheral || (peripheral.name?.contains("_R_") ?? false) {
            Bridge.log("G1: 🔵 Storing right glass UUID: \(peripheral.identifier.uuidString)")
            rightGlassUUID = peripheral.identifier
            rightPeripheral = peripheral
        }

        // Update the last connection timestamp
        lastConnectionTimestamp = Date()
        Bridge.log("G1: Connected to peripheral: \(peripheral.name ?? "Unknown")")
    }

    func centralManager(
        _: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error _: (any Error)?
    ) {
        let side =
            peripheral == leftPeripheral
                ? "LEFT" : peripheral == rightPeripheral ? "RIGHT" : "unknown"
        Bridge.log("G1: @@@@@ \(side) PERIPHERAL DISCONNECTED @@@@@")

        // only reconnect if we're not intentionally disconnecting:
        if isDisconnecting {
            return
        }

        if peripheral == leftPeripheral || peripheral == rightPeripheral {
            // force reconnection to both before considering us ready again:
            leftPeripheral = nil
            rightPeripheral = nil
            setReadiness(left: false, right: false)
            startReconnectionTimer() // Start periodic reconnection attempts
        }
    }

    private func stopReconnectionTimer() {
        reconnectionQueue.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("G1: Stopping reconnection timer")
            self.reconnectionTimer?.cancel()
            self.reconnectionTimer = nil
        }
    }

    private func startReconnectionTimer() {
        reconnectionQueue.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("G1: Starting reconnection timer")

            self.reconnectionTimer?.cancel()
            self.reconnectionTimer = nil
            self.reconnectionAttempts = 0

            let timer = DispatchSource.makeTimerSource(queue: self.reconnectionQueue)
            timer.schedule(deadline: .now(), repeating: self.reconnectionInterval)
            timer.setEventHandler { [weak self] in
                self?.attemptReconnection()
            }
            self.reconnectionTimer = timer
            timer.resume()
        }
    }

    // Connect by UUID
    @objc func connectByUUID() -> Bool {
        // don't do this if we don't have a search id set:
        if DEVICE_SEARCH_ID == "NOT_SET" || DEVICE_SEARCH_ID.isEmpty {
            Bridge.log("G1: 🔵 No DEVICE_SEARCH_ID set, skipping connect by UUID")
            return false
        }

        Bridge.log("G1: 🔵 Attempting to connect by UUID")
        var foundAny = false

        if let leftUUID = leftGlassUUID {
            Bridge.log("G1: 🔵 Found stored left glass UUID: \(leftUUID.uuidString)")
            let leftDevices = centralManager!.retrievePeripherals(withIdentifiers: [leftUUID])

            if let leftDevice = leftDevices.first {
                Bridge.log(
                    "G1: 🔵 Successfully retrieved left glass: \(leftDevice.name ?? "Unknown")")
                foundAny = true
                leftPeripheral = leftDevice
                leftDevice.delegate = self
                centralManager!.connect(
                    leftDevice,
                    options: [
                        CBConnectPeripheralOptionNotifyOnConnectionKey: true,
                        CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
                    ]
                )
            }
        }

        if let rightUUID = rightGlassUUID {
            Bridge.log("G1: 🔵 Found stored right glass UUID: \(rightUUID.uuidString)")
            let rightDevices = centralManager!.retrievePeripherals(withIdentifiers: [rightUUID])

            if let rightDevice = rightDevices.first {
                Bridge.log(
                    "G1: 🔵 Successfully retrieved right glass: \(rightDevice.name ?? "Unknown")")
                foundAny = true
                rightPeripheral = rightDevice
                rightDevice.delegate = self
                centralManager!.connect(
                    rightDevice,
                    options: [
                        CBConnectPeripheralOptionNotifyOnConnectionKey: true,
                        CBConnectPeripheralOptionNotifyOnDisconnectionKey: true,
                    ]
                )
            }
        }

        return foundAny
    }

    @objc private func attemptReconnection() {
        Bridge.log("G1: Attempting reconnection (attempt \(reconnectionAttempts))...")
        // Check if we're already connected
        if ready {
            Bridge.log("G1: G1 is already ready, cancelling reconnection attempt (& timer)")
            stopReconnectionTimer()
            return
        }

        // Check if we've exceeded maximum attempts
        if maxReconnectionAttempts > 0, reconnectionAttempts >= maxReconnectionAttempts {
            Bridge.log("G1: Maximum reconnection attempts reached. Stopping reconnection timer.")
            stopReconnectionTimer()
            return
        }

        reconnectionAttempts += 1

        // Start a new scan
        startScan()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices _: Error?) {
        if let services = peripheral.services {
            for service in services where service.uuid == UART_SERVICE_UUID {
                peripheral.discoverCharacteristics(
                    [UART_TX_CHAR_UUID, UART_RX_CHAR_UUID], for: service
                )
            }
        }
    }

    // Update peripheral(_:didDiscoverCharacteristicsFor:error:) to set services waiters
    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
        error _: Error?
    ) {
        guard let characteristics = service.characteristics else { return }

        if service.uuid.isEqual(UART_SERVICE_UUID) {
            for characteristic in characteristics {
                if characteristic.uuid == UART_TX_CHAR_UUID {
                    sendInitCommand(to: peripheral)
                } else if characteristic.uuid == UART_RX_CHAR_UUID {
                    peripheral.setNotifyValue(true, for: characteristic)

                    // enable notification (needed for pairing from scracth!)
                    Thread.sleep(forTimeInterval: 0.5) // 500ms delay
                    let CLIENT_CHARACTERISTIC_CONFIG_UUID = CBUUID(
                        string: "00002902-0000-1000-8000-00805f9b34fb")
                    if let descriptor = characteristic.descriptors?.first(where: {
                        $0.uuid == CLIENT_CHARACTERISTIC_CONFIG_UUID
                    }) {
                        let value = Data([0x01, 0x00]) // ENABLE_NOTIFICATION_VALUE in iOS
                        peripheral.writeValue(value, for: descriptor)
                    } else {
                        Bridge.log("PROC_QUEUE - descriptor not found")
                    }
                }
            }

            // // Mark the services as ready
            // if peripheral == leftPeripheral {
            //     Bridge.log("G1: Left glass services discovered and ready")
            //     setReadiness(left: true, right: nil)
            // } else if peripheral == rightPeripheral {
            //     Bridge.log("G1: Right glass services discovered and ready")
            //     setReadiness(left: nil, right: true)
            // }
        }
    }

    // called whenever bluetooth is initialized / turned on or off:
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            Bridge.log("G1: Bluetooth was powered on")
            setReadiness(left: false, right: false)
            // only automatically start scanning if we have a SEARCH_ID, otherwise wait for RN to call startScan() itself
            if DEVICE_SEARCH_ID != "NOT_SET", !DEVICE_SEARCH_ID.isEmpty {
                startScan()
            }
        } else {
            Bridge.log("G1: Bluetooth was turned off.")
        }
    }

    // called when we get data from the glasses:
    func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error = error {
            Bridge.log("G1: Error updating value for characteristic: \(error.localizedDescription)")
            return
        }

        guard let data = characteristic.value else {
            Bridge.log("G1: Characteristic value is nil.")
            return
        }

        // Process the notification data
        handleNotification(from: peripheral, data: data)
    }

    // L/R Synchronization - Handle BLE write completions
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor _: CBCharacteristic, error: Error?) {
        if let error = error {
            Bridge.log(
                "G1: ❌ BLE write error for \(peripheral.name ?? "unknown"): \(error.localizedDescription)"
            )
        } else {
            // Only log successful writes every 10th operation to avoid spam
            // if writeCompletionCount % 10 == 0 {
            //   CoreCommsService.log("G1: ✅ BLE write \(writeCompletionCount) completed for \(peripheral.name ?? "unknown")")
            // }
            writeCompletionCount += 1
        }

        // Resume continuation to allow sequential execution
        // TODO: use the ack continuation
        //    if let continuation = pendingWriteCompletions.removeValue(forKey: characteristic) {
        //      continuation.resume(returning: false)
        //    }
    }
}
