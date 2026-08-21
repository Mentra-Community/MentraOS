//
//  Ar99.swift
//  MentraBluetoothSDK
//
//  Native iOS implementation for AR99 glasses.
//

import AVFoundation
import CoreBluetooth
import Foundation

private enum Ar99BLE {
    static let ctrlService = CBUUID(string: "A72EC9A8-CF72-8544-AD96-D1481A02CE98")
    static let ctrlHostToSlave = CBUUID(string: "A72EC9A9-CF72-8544-AD96-D1481A02CE98")
    static let ctrlSlaveToHost = CBUUID(string: "A72EC9AA-CF72-8544-AD96-D1481A02CE98")
    static let opusService = CBUUID(string: "F6B26AAD-41A5-93F5-F640-AC3BA3C73597")
    static let opusSlaveToHost = CBUUID(string: "F6B26AAF-41A5-93F5-F640-AC3BA3C73597")
    static let otaService = CBUUID(string: "E49A25F8-F69A-11E8-8EB2-F2801F1B9FD1")
    static let otaWrite = CBUUID(string: "E49A25E0-F69A-11E8-8EB2-F2801F1B9FD1")
    static let otaNotify = CBUUID(string: "E49A28E1-F69A-11E8-8EB2-F2801F1B9FD1")
}

private enum Ar99Protocol {
    static let magicNumber: UInt32 = 0x1A2B3C4D
    static let messageStart: [UInt8] = [0x0D, 0x4D, 0x3C, 0x2B, 0x1A]

    static let funcComm = 1
    static let funcTrans = 3
    static let funcCommDisplay = 7

    static let cmdTransDisplayStart = 100
    static let cmdTransDisplayStop = 101
    static let cmdTransDisplaySetContent = 102

    static let cmdDisplayGetDeviceInfo = 100
    static let cmdDisplayGetBright = 102
    static let cmdDisplayGetBattery = 104
    static let cmdCommSetTime = 31
    static let cmdDisplaySetLanguage = 131
    static let cmdDisplaySetBright = 132
    static let cmdDisplaySetAutoAdjustLight = 138
    static let cmdDisplayCtrlAudioRecord = 161
    static let cmdDisplayCtrlFactoryReset = 162
    static let cmdDisplayCtrlSysFunction = 164
    static let cmdDisplayCtrlMinimalTextStart = 181
    static let cmdDisplayCtrlMinimalTextSet = 182
    static let cmdDisplayCtrlMinimalTextClear = 183
    static let cmdDisplayCtrlMinimalTextStop = 184

    static let textStreamStateUpdate = 1
    static let transDisplaySourceLanguage = 0
    static let transDisplayTargetLanguage = 1
    static let transDisplayMicSourcePhone = 0
    static let transDisplayFontSize = 24
    static let displayFunctionTypeUiMode = 2
    static let displayUiModeMinimal = 1
    static let displayLanguageEnglish = 1
    static let factoryResetConfirmCode = 0xAA

    static let targetMobileApp = 0
    static let targetGlassAndroid = 1
    static let targetGlassMcuDisplay = 3

    static let ctrlSenderMask = 0x03
    static let ctrlActionResponse = 0x40

    static let bleWriteChunkSize = 180
    static let bleWriteChunkDelayMs = 10
    static let scanDurationMs = 15_000
    static let initialBatteryRetryDelayMs = 1_000
    static let maxInitialBatteryRetries = 5
    static let batteryPollIntervalMs = 60_000
    static let readyMinimalModeDelayMs = 40
    static let readyLanguageDelayMs = 90
    static let readyDeviceInfoDelayMs = 140
    static let readyBrightnessDelayMs = 280
    static let readyBatteryDelayMs = 420
    static let displaySessionIdleRestartMs = 8_000
}

private struct Ar99MessageHeader {
    let function: Int
    let cmd: Int
    let ctrl: Int
    let sequence: Int
    let payload: Data
    let totalBytes: Int
}

private struct Ar99CommonResult {
    let success: Bool
    let errorCode: Int
    let errorMessage: String
}

private struct Ar99BatteryInfo {
    let battery: Int
    let charging: Bool?
}

private struct Ar99DeviceInfo {
    let firmwareVersion: String?
    let deviceName: String?
    let productName: String?
    let btMac: String?
    let serialNumber: String?
}

private struct Ar99LanguageResponse {
    let success: Bool
    let language: Int?
}

private struct Ar99SetTimeResponse {
    let success: Bool
    let timeValue: Int64?
}

private struct Ar99ParsedAdvertisement {
    let bleName: String?
    let projectName: String?
    let bleAddress: String?
    let btAddress: String?
    let serialNumber: String?
}

private struct Ar99ProtoReader {
    private let bytes: [UInt8]
    private(set) var offset = 0

    init(_ data: Data) {
        bytes = Array(data)
    }

    var isAtEnd: Bool {
        offset >= bytes.count
    }

    mutating func nextField() -> (field: Int, wire: Int)? {
        guard let tag = readVarint(), tag != 0 else { return nil }
        return (Int(tag >> 3), Int(tag & 0x07))
    }

    mutating func readVarint() -> UInt64? {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while offset < bytes.count, shift < 64 {
            let byte = bytes[offset]
            offset += 1
            result |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 {
                return result
            }
            shift += 7
        }
        return nil
    }

    mutating func readFixed32() -> UInt32? {
        guard offset + 4 <= bytes.count else { return nil }
        let value =
            UInt32(bytes[offset])
                | (UInt32(bytes[offset + 1]) << 8)
                | (UInt32(bytes[offset + 2]) << 16)
                | (UInt32(bytes[offset + 3]) << 24)
        offset += 4
        return value
    }

    mutating func readLengthDelimited() -> Data? {
        guard let rawLength = readVarint() else { return nil }
        let length = Int(rawLength)
        guard length >= 0, offset + length <= bytes.count else { return nil }
        let data = Data(bytes[offset ..< offset + length])
        offset += length
        return data
    }

    mutating func readString() -> String? {
        guard let data = readLengthDelimited() else { return nil }
        return String(data: data, encoding: .utf8)
    }

    mutating func skipField(wire: Int) -> Bool {
        switch wire {
        case 0:
            return readVarint() != nil
        case 1:
            guard offset + 8 <= bytes.count else { return false }
            offset += 8
            return true
        case 2:
            guard let rawLength = readVarint() else { return false }
            let length = Int(rawLength)
            guard length >= 0, offset + length <= bytes.count else { return false }
            offset += length
            return true
        case 5:
            guard offset + 4 <= bytes.count else { return false }
            offset += 4
            return true
        default:
            return false
        }
    }
}

private enum Ar99ProtoWriter {
    static func writeTag(field: Int, wire: Int, to data: inout Data) {
        writeVarint(UInt64((field << 3) | wire), to: &data)
    }

    static func writeVarint(_ value: UInt64, to data: inout Data) {
        var value = value
        while value >= 0x80 {
            data.append(UInt8(value & 0x7F) | 0x80)
            value >>= 7
        }
        data.append(UInt8(value))
    }

    static func writeUInt32(field: Int, value: Int, to data: inout Data) {
        writeTag(field: field, wire: 0, to: &data)
        writeVarint(UInt64(max(0, value)), to: &data)
    }

    static func writeInt64(field: Int, value: Int64, to data: inout Data) {
        writeTag(field: field, wire: 0, to: &data)
        writeVarint(UInt64(bitPattern: value), to: &data)
    }

    static func writeInt32(field: Int, value: Int, to data: inout Data) {
        writeTag(field: field, wire: 0, to: &data)
        writeVarint(UInt64(bitPattern: Int64(Int32(value))), to: &data)
    }

    static func writeBool(field: Int, value: Bool, to data: inout Data) {
        writeTag(field: field, wire: 0, to: &data)
        writeVarint(value ? 1 : 0, to: &data)
    }

    static func writeFixed32(field: Int, value: UInt32, to data: inout Data) {
        writeTag(field: field, wire: 5, to: &data)
        data.append(UInt8(value & 0xFF))
        data.append(UInt8((value >> 8) & 0xFF))
        data.append(UInt8((value >> 16) & 0xFF))
        data.append(UInt8((value >> 24) & 0xFF))
    }

    static func writeBytes(field: Int, value: Data, to data: inout Data) {
        writeTag(field: field, wire: 2, to: &data)
        writeVarint(UInt64(value.count), to: &data)
        data.append(value)
    }

    static func writeString(field: Int, value: String, to data: inout Data) {
        writeBytes(field: field, value: Data(value.utf8), to: &data)
    }
}

private final class Ar99SystemOpusDecoder {
    private let opusFormat: AVAudioFormat
    private let pcmFormat: AVAudioFormat
    private var converter: AVAudioConverter?

    init?() {
        var desc = AudioStreamBasicDescription(
            mSampleRate: 16_000,
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 320,
            mBytesPerFrame: 0,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 0,
            mReserved: 0
        )
        guard let input = AVAudioFormat(streamDescription: &desc),
              let output = AVAudioFormat(
                  commonFormat: .pcmFormatInt16,
                  sampleRate: 16_000,
                  channels: 1,
                  interleaved: true
              )
        else {
            return nil
        }

        opusFormat = input
        pcmFormat = output
        converter = AVAudioConverter(from: input, to: output)
        if converter == nil {
            return nil
        }
    }

    func decode(_ opusFrame: Data) -> Data? {
        guard let converter, !opusFrame.isEmpty else { return nil }

        let compressed = AVAudioCompressedBuffer(
            format: opusFormat,
            packetCapacity: 1,
            maximumPacketSize: opusFrame.count
        )
        opusFrame.withUnsafeBytes { raw in
            guard let baseAddress = raw.baseAddress else { return }
            compressed.data.copyMemory(from: baseAddress, byteCount: opusFrame.count)
        }
        compressed.byteLength = UInt32(opusFrame.count)
        compressed.packetCount = 1
        compressed.packetDescriptions?.pointee = AudioStreamPacketDescription(
            mStartOffset: 0,
            mVariableFramesInPacket: 0,
            mDataByteSize: UInt32(opusFrame.count)
        )

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: 5_760) else {
            return nil
        }

        var didFeedPacket = false
        var error: NSError?
        let status = converter.convert(to: pcmBuffer, error: &error) { _, outStatus in
            if didFeedPacket {
                outStatus.pointee = .noDataNow
                return nil
            }
            didFeedPacket = true
            outStatus.pointee = .haveData
            return compressed
        }
        if status == .error {
            Bridge.log("AR99: Opus decode error: \(error?.localizedDescription ?? "unknown")")
            return nil
        }
        guard pcmBuffer.frameLength > 0, let channel = pcmBuffer.int16ChannelData else {
            return nil
        }
        return Data(bytes: channel[0], count: Int(pcmBuffer.frameLength) * 2)
    }
}

private final class Ar99OpusPcmDecoder {
    private static let frameBytes = 48
    private static let headerBytes = 8
    private static let maxBufferBytes = 10_000
    private static let maxDiagFrames: Int64 = 8
    private static let expectedPrefix = Data([0x00, 0x00, 0x00, 0x28])

    private let queue = DispatchQueue(label: "ar99-opus-decode")
    private let onPcmDecoded: (Data) -> Void
    private var decoder: Ar99SystemOpusDecoder?
    private var buffer = Data()
    private var totalNotifyCount: Int64 = 0
    private var totalFrameCount: Int64 = 0
    private var totalDecodeFailCount: Int64 = 0
    private var totalHeaderMismatchCount: Int64 = 0
    private var totalShortChunkCount: Int64 = 0
    private var totalResyncDropBytes: Int64 = 0
    private var headerLooksStable = true

    init?(onPcmDecoded: @escaping (Data) -> Void) {
        guard let decoder = Ar99SystemOpusDecoder() else { return nil }
        self.decoder = decoder
        self.onPcmDecoded = onPcmDecoded
    }

    func submitBleNotify(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async { [weak self] in
            self?.handleChunk(data)
        }
    }

    func resetBuffer() {
        queue.async { [weak self] in
            self?.resetDecoderState()
        }
    }

    private func resetDecoderState() {
        buffer.removeAll()
        decoder = Ar99SystemOpusDecoder()
        totalNotifyCount = 0
        totalFrameCount = 0
        totalDecodeFailCount = 0
        totalHeaderMismatchCount = 0
        totalShortChunkCount = 0
        totalResyncDropBytes = 0
        headerLooksStable = true
    }

    private func handleChunk(_ data: Data) {
        guard decoder != nil else { return }
        totalNotifyCount += 1
        if data.count < Self.frameBytes {
            totalShortChunkCount += 1
        }

        if buffer.count + data.count > Self.maxBufferBytes {
            Bridge.log("AR99 Opus buffer overflow, clear oldBuf=\(buffer.count), chunk=\(data.count), notify#=\(totalNotifyCount)")
            buffer.removeAll()
        }
        let oldBufferLen = buffer.count
        buffer.append(data)

        var pcmFrames = 0
        var pcmBytesOut = 0
        var decodeFail = 0
        var skipPayload = 0
        var headerMismatch = 0

        while buffer.count >= Self.expectedPrefix.count {
            guard let frameStart = findFrameStart(in: buffer, from: 0) else {
                let keep = min(buffer.count, Self.expectedPrefix.count - 1)
                let drop = buffer.count - keep
                if drop > 0 {
                    totalResyncDropBytes += Int64(drop)
                    headerLooksStable = false
                    let tail = buffer.suffix(keep)
                    Bridge.log("AR99 Opus resync drop(no header) notify#=\(totalNotifyCount) dropBytes=\(drop) keepTail=\(keep) tailHex=\(hex(Data(tail), maxBytes: keep))")
                    buffer = Data(tail)
                }
                break
            }

            if frameStart > 0 {
                let dropped = buffer.prefix(frameStart)
                totalResyncDropBytes += Int64(frameStart)
                headerLooksStable = false
                headerMismatch += 1
                totalHeaderMismatchCount += 1
                Bridge.log("AR99 Opus resync shift notify#=\(totalNotifyCount) dropBytes=\(frameStart) bufLen=\(buffer.count) droppedHex=\(hex(Data(dropped), maxBytes: min(frameStart, 24)))")
                buffer.removeFirst(frameStart)
            }

            if buffer.count < Self.frameBytes {
                break
            }

            let frame = buffer.prefix(Self.frameBytes)
            buffer.removeFirst(Self.frameBytes)
            totalFrameCount += 1

            let prefixOk = Data(frame.prefix(Self.expectedPrefix.count)) == Self.expectedPrefix
            if !prefixOk {
                headerMismatch += 1
                totalHeaderMismatchCount += 1
                headerLooksStable = false
                if totalFrameCount <= Self.maxDiagFrames || !headerLooksStable {
                    Bridge.log("AR99 Opus frame header mismatch frame#=\(totalFrameCount) notify#=\(totalNotifyCount) remain=\(buffer.count) frameHex=\(hex(Data(frame), maxBytes: Self.frameBytes))")
                }
            }

            let payload = frame.dropFirst(Self.headerBytes)
            guard !payload.isEmpty, let pcm = decoder?.decode(Data(payload)), !pcm.isEmpty else {
                if payload.isEmpty {
                    skipPayload += 1
                } else {
                    decodeFail += 1
                    totalDecodeFailCount += 1
                    if totalFrameCount <= Self.maxDiagFrames || !headerLooksStable {
                        Bridge.log("AR99 Opus frame decode failed frame#=\(totalFrameCount) notify#=\(totalNotifyCount) prefixOk=\(prefixOk) frameHex=\(hex(Data(frame), maxBytes: Self.frameBytes)) payloadHex=\(hex(Data(payload), maxBytes: payload.count))")
                    }
                }
                continue
            }
            pcmFrames += 1
            pcmBytesOut += pcm.count
            DispatchQueue.main.async { [onPcmDecoded] in
                onPcmDecoded(pcm)
            }
        }

        if data.count != Self.frameBytes
            || oldBufferLen != 0
            || decodeFail > 0
            || headerMismatch > 0
            || skipPayload > 0
            || pcmFrames == 0
            || !headerLooksStable
        {
            Bridge.log("AR99 Opus decode summary notify#=\(totalNotifyCount) inLen=\(data.count) pcmFrames=\(pcmFrames) pcmBytesOut=\(pcmBytesOut) decodeFail=\(decodeFail) headerMismatch=\(headerMismatch) skipPayload=\(skipPayload) bufRemain=\(buffer.count) totals={frames=\(totalFrameCount),fail=\(totalDecodeFailCount),headerMismatch=\(totalHeaderMismatchCount),shortChunk=\(totalShortChunkCount),resyncDropBytes=\(totalResyncDropBytes)}")
        }
    }

    private func findFrameStart(in data: Data, from: Int) -> Int? {
        guard data.count >= Self.expectedPrefix.count else { return nil }
        let startIndex = data.index(data.startIndex, offsetBy: max(0, from), limitedBy: data.endIndex) ?? data.startIndex
        guard startIndex < data.endIndex,
              let range = data[startIndex...].range(of: Self.expectedPrefix)
        else {
            return nil
        }
        return data.distance(from: data.startIndex, to: range.lowerBound)
    }

    private func hex(_ data: Data, maxBytes: Int) -> String {
        guard !data.isEmpty, maxBytes > 0 else { return "" }
        let prefix = data.prefix(maxBytes)
        var output = prefix.map { String(format: "%02X", $0) }.joined(separator: " ")
        if data.count > prefix.count {
            output += "..."
        }
        return output
    }
}

@MainActor
final class Ar99: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, SGCManager, Ar99OtaGattTransport {
    var type = DeviceTypes.AR99
    let hasMic = true

    private let supportedProjectNames = ["AR99"]
    private var centralManager: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var controlWriteCharacteristic: CBCharacteristic?
    private var controlNotifyCharacteristic: CBCharacteristic?
    private var opusNotifyCharacteristic: CBCharacteristic?
    private var otaWriteCharacteristic: CBCharacteristic?
    private var otaNotifyCharacteristic: CBCharacteristic?
    private var pendingCharacteristicServices = Set<CBUUID>()
    private var pendingNotifyCharacteristics = Set<CBUUID>()
    private var configuredNotifications = false
    private var isScanning = false
    private var scanForConnection = false
    private var targetIdentifier: String?
    private var currentProjectName: String?
    private var currentBroadcastMacAddress: String?
    private var scanTimeoutItem: DispatchWorkItem?
    private var discoveredNames = Set<String>()
    private var lastConnectedDisplayName: String?

    private var writeQueue: [Data] = []
    private var otaWriteQueue: [Data] = []
    private var writeInFlight = false
    private var otaWriteInFlight = false
    private var otaNotificationEnabled = false
    private var writeDelayItem: DispatchWorkItem?
    private var otaWriteDelayItem: DispatchWorkItem?
    private var controlNotifyBuffer = Data()
    private var sequence = 1

    private var minimalModeReady = false
    private var displaySessionStarted = false
    private var displayContentStarted = false
    private var lastDisplayContentAtMs: Int64 = 0
    private var hasPendingDisplayUpdate = false
    private var pendingDisplayText = ""
    private var lastDisplayText = ""
    private var pendingSourceText = ""
    private var pendingTargetText = ""
    private var lastDisplaySourceText = ""
    private var lastDisplayTargetText = ""
    private var awaitingMicDisableAck = false

    private var hasReceivedBatteryForCurrentConnection = false
    private var pendingBatteryRetries = 0
    private var initialBatteryRetryItem: DispatchWorkItem?
    private var periodicBatteryTimer: Timer?
    private var readyItems: [DispatchWorkItem] = []
    private var opusDecoder: Ar99OpusPcmDecoder?
    private var opusLoggedFirstInSession = false

    override init() {
        super.init()
        DeviceStore.shared.apply("glasses", "micEnabled", false)
        Ar99OtaManager.shared.setTransport(self)
    }

    deinit {
        Task { @MainActor in
            Ar99OtaManager.shared.setTransport(nil)
        }
        centralManager?.delegate = nil
        peripheral?.delegate = nil
    }

    // MARK: - Audio Control

    func setMicEnabled(_ enabled: Bool) {
        if enabled {
            awaitingMicDisableAck = false
            DeviceStore.shared.apply("glasses", "micEnabled", true)
            ensureOpusDecoder()
        } else {
            awaitingMicDisableAck = true
        }
        sendControlDisplayAudioRecord(enabled)
    }

    func sortMicRanking(list: [String]) -> [String] {
        list
    }

    // MARK: - Messaging

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}

    // MARK: - Camera & Media

    func requestPhoto(_: PhotoRequest) {
        Bridge.log("AR99: requestPhoto not implemented")
    }

    func startStream(_: [String: Any]) {}
    func stopStream() {}
    func sendStreamKeepAlive(_: [String: Any]) {}
    func startVideoRecording(requestId _: String, save _: Bool, sound _: Bool) {}
    func stopVideoRecording(requestId _: String) {}
    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendButtonMaxRecordingTime() {}
    func sendCameraFovSetting() {}

    // MARK: - Display

    func setBrightness(_ level: Int, autoMode: Bool) {
        let brightness = min(max(level, 0), 100)
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplaySetAutoAdjustLight,
            payload: buildProtoBool(field: 1, value: autoMode),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplaySetBright,
            payload: buildProtoUInt32(field: 1, value: brightness),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    func clearDisplay() {
        clearMinimalText()
    }

    func sendText(_ text: String) async {
        await sendTextWall(text)
    }

    func sendTextWall(_ text: String) async {
        sendMinimalText(text)
    }

    func sendDoubleTextWall(_ top: String, _ bottom: String) async {
        sendMinimalText(joinDisplayLines(top, bottom))
    }

    func displayBitmap(
        base64ImageData _: String,
        x _: Int32? = nil,
        y _: Int32? = nil,
        width _: Int32? = nil,
        height _: Int32? = nil
    ) async -> Bool {
        false
    }

    func showDashboard() {}
    func setDashboardPosition(_: Int, _: Int) {}

    // MARK: - Device Control

    func setHeadUpAngle(_: Int) {}

    func getBatteryStatus() {
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayGetBattery,
            payload: Data(),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    func setSilentMode(_: Bool) {}
    func exit() {}
    func sendShutdown() {}
    func sendReboot() {}
    func sendFactoryReset() {
        Bridge.log("AR99: sending factory reset")
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayCtrlFactoryReset,
            payload: buildProtoUInt32(field: 1, value: Ar99Protocol.factoryResetConfirmCode),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    func sendRgbLedControl(
        requestId _: String,
        packageName _: String?,
        action _: String,
        color _: String?,
        onDurationMs _: Int,
        offDurationMs _: Int,
        count _: Int
    ) {}

    // MARK: - Connection

    func findCompatibleDevices() {
        Bridge.log("AR99: findCompatibleDevices()")
        targetIdentifier = nil
        discoveredNames.removeAll()
        startScan(forConnection: false)
    }

    func connectById(_ id: String) {
        Bridge.log("AR99: connectById(\(id))")
        targetIdentifier = id.trimmingCharacters(in: .whitespacesAndNewlines)
        discoveredNames.removeAll()
        startScan(forConnection: true)
    }

    func stopScan() {
        guard isScanning else { return }
        centralManager?.stopScan()
        scanTimeoutItem?.cancel()
        scanTimeoutItem = nil
        isScanning = false
        DeviceStore.shared.apply("bluetooth", "searching", false)
    }

    func disconnect() {
        stopScan()
        cleanupGatt(cancelPeripheral: true)
        updateConnectionState(ConnTypes.DISCONNECTED)
    }

    func forget() {
        targetIdentifier = nil
        disconnect()
    }

    func getConnectedBluetoothName() -> String? {
        lastConnectedDisplayName ?? peripheral?.name
    }

    func connectController() {}
    func disconnectController() {}

    func cleanup() {
        disconnect()
        opusDecoder = nil
    }

    func ping() {
        requestDeviceInfo()
    }

    func dbg1() {}
    func dbg2() {}

    // MARK: - Network and misc

    func requestWifiScan(scanId _: String?) {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
    func sendOtaStart(otaVersionUrl _: String?, otaTransport _: String?) {}
    func sendOtaQueryStatus() {}
    func sendUserEmailToGlasses(_: String) {}

    func sendIncidentId(_: String, apiBaseUrl _: String?) {
        Bridge.log("AR99: sendIncidentId not implemented")
    }

    func queryGalleryStatus() {}
    func sendGalleryMode() {}

    func requestVersionInfo() {
        requestDeviceInfo()
    }

    func startOtaFromFile(_ path: String) -> Bool {
        if path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sendAr99OtaStatus(phase: "failed", progress: 0, offset: 0, total: 0, errorMessage: "Firmware path is empty")
            return false
        }

        let manager = Ar99OtaManager.shared
        manager.setCallback(nil)
        if manager.isOTAInProgress() {
            manager.cancelOTA()
        }

        var lastOffset = 0
        var lastTotal = 0
        manager.setCallback(
            Ar99OtaCallbacks(
                onProgress: { [weak self] offset, total, progress in
                    lastOffset = offset
                    lastTotal = total
                    self?.sendAr99OtaStatus(
                        phase: "transferring",
                        progress: progress,
                        offset: offset,
                        total: total,
                        errorMessage: nil
                    )
                },
                onCompleted: { [weak self, weak manager] _ in
                    self?.sendAr99OtaStatus(
                        phase: "success",
                        progress: 100,
                        offset: lastTotal,
                        total: lastTotal,
                        errorMessage: nil
                    )
                    manager?.setCallback(nil)
                },
                onError: { [weak self, weak manager] _, message in
                    self?.sendAr99OtaStatus(
                        phase: "failed",
                        progress: manager?.getProgress() ?? 0,
                        offset: lastOffset,
                        total: lastTotal,
                        errorMessage: message
                    )
                    manager?.setCallback(nil)
                },
                onCancelled: { [weak self, weak manager] in
                    self?.sendAr99OtaStatus(
                        phase: "cancelled",
                        progress: manager?.getProgress() ?? 0,
                        offset: lastOffset,
                        total: lastTotal,
                        errorMessage: nil
                    )
                    manager?.setCallback(nil)
                },
                onPausedWaitingReconnect: { [weak self, weak manager] in
                    self?.sendAr99OtaStatus(
                        phase: "paused",
                        progress: manager?.getProgress() ?? 0,
                        offset: lastOffset,
                        total: lastTotal,
                        errorMessage: "Waiting for reconnect"
                    )
                }
            )
        )

        sendAr99OtaStatus(phase: "preparing", progress: 0, offset: 0, total: 0, errorMessage: nil)
        let started = manager.startOTA(filePath: path)
        if !started {
            sendAr99OtaStatus(phase: "failed", progress: 0, offset: 0, total: 0, errorMessage: "Unable to start AR99 OTA")
            manager.setCallback(nil)
        }
        return started
    }

    func cancelAr99Ota() {
        Ar99OtaManager.shared.cancelOTA()
    }

    func enableOtaNotification() -> Bool {
        guard let otaNotifyCharacteristic else { return false }
        if otaNotificationEnabled || otaNotifyCharacteristic.isNotifying {
            otaNotificationEnabled = true
            Ar99OtaManager.shared.onOtaNotifyEnabled()
            return true
        }
        peripheral?.setNotifyValue(true, for: otaNotifyCharacteristic)
        return peripheral != nil
    }

    func sendOtaData(_ data: Data) {
        guard !data.isEmpty,
              peripheral != nil,
              otaWriteCharacteristic != nil,
              otaNotificationEnabled
        else {
            return
        }
        otaWriteQueue.append(data)
        processNextOtaWrite()
    }

    func requestMtu(_: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100)) {
            _ = Ar99OtaManager.shared.handleMtuNegotiatedForOta(success: true)
        }
    }

    func isBleConnected() -> Bool {
        connected && peripheral != nil && controlWriteCharacteristic != nil && otaWriteCharacteristic != nil && otaNotifyCharacteristic != nil
    }

    private func sendAr99OtaStatus(phase: String, progress: Int, offset: Int, total: Int, errorMessage: String?) {
        var body: [String: Any] = [
            "type": "ar99_ota_status",
            "phase": phase,
            "progress": min(max(progress, 0), 100),
            "offset": offset,
            "total": total,
        ]
        if let errorMessage, !errorMessage.isEmpty {
            body["errorMessage"] = errorMessage
            body["error_message"] = errorMessage
        }
        Bridge.sendTypedMessage("ar99_ota_status", body: body)
    }

    // MARK: - CBCentralManagerDelegate

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if central.state == .poweredOn, self.isScanning {
                self.beginScan()
            } else if central.state != .poweredOn {
                Bridge.log("AR99: Bluetooth unavailable state=\(central.state.rawValue)")
            }
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.handleScanResult(
                central: central,
                peripheral: peripheral,
                advertisementData: advertisementData,
                rssi: RSSI.intValue
            )
        }
    }

    nonisolated func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("AR99: connected to \(peripheral.name ?? "unknown")")
            peripheral.delegate = self
            peripheral.discoverServices([Ar99BLE.ctrlService, Ar99BLE.opusService, Ar99BLE.otaService])
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            Bridge.log("AR99: failed to connect \(peripheral.name ?? "unknown"): \(error?.localizedDescription ?? "unknown")")
            self?.cleanupGatt(cancelPeripheral: false)
            self?.updateConnectionState(ConnTypes.DISCONNECTED)
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("AR99: disconnected \(peripheral.name ?? "unknown"): \(error?.localizedDescription ?? "clean")")
            if Ar99OtaManager.shared.isOTAInProgress() {
                Ar99OtaManager.shared.onBleDisconnected()
            }
            self.cleanupGatt(cancelPeripheral: false)
            self.updateConnectionState(ConnTypes.DISCONNECTED)
        }
    }

    // MARK: - CBPeripheralDelegate

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let error {
                Bridge.log("AR99: service discovery failed: \(error.localizedDescription)")
                return
            }
            guard let services = peripheral.services else { return }
            self.pendingCharacteristicServices.removeAll()
            for service in services where service.uuid == Ar99BLE.ctrlService || service.uuid == Ar99BLE.opusService || service.uuid == Ar99BLE.otaService {
                self.pendingCharacteristicServices.insert(service.uuid)
                peripheral.discoverCharacteristics(nil, for: service)
            }
            self.checkCharacteristicDiscoveryComplete()
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let error {
                Bridge.log("AR99: characteristic discovery failed: \(error.localizedDescription)")
            }
            for characteristic in service.characteristics ?? [] {
                switch characteristic.uuid {
                case Ar99BLE.ctrlHostToSlave:
                    self.controlWriteCharacteristic = characteristic
                case Ar99BLE.ctrlSlaveToHost:
                    self.controlNotifyCharacteristic = characteristic
                case Ar99BLE.opusSlaveToHost:
                    self.opusNotifyCharacteristic = characteristic
                case Ar99BLE.otaWrite:
                    self.otaWriteCharacteristic = characteristic
                case Ar99BLE.otaNotify:
                    self.otaNotifyCharacteristic = characteristic
                default:
                    break
                }
            }
            self.pendingCharacteristicServices.remove(service.uuid)
            self.checkCharacteristicDiscoveryComplete()
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let error {
                Bridge.log("AR99: notify enable failed \(characteristic.uuid): \(error.localizedDescription)")
            }
            if characteristic.uuid == Ar99BLE.otaNotify {
                self.otaNotificationEnabled = error == nil && characteristic.isNotifying
                if self.otaNotificationEnabled {
                    Ar99OtaManager.shared.onOtaNotifyEnabled()
                }
                return
            }
            self.pendingNotifyCharacteristics.remove(characteristic.uuid)
            if self.pendingNotifyCharacteristics.isEmpty {
                self.markReady()
                Ar99OtaManager.shared.tryResumeOtaAfterGattReady()
            }
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard error == nil, let data = characteristic.value else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if characteristic.uuid == Ar99BLE.ctrlSlaveToHost {
                self.handleControlNotifyChunk(data)
            } else if characteristic.uuid == Ar99BLE.opusSlaveToHost {
                self.handleOpusData(data)
            } else if characteristic.uuid == Ar99BLE.otaNotify {
                Ar99OtaManager.shared.handleOTAResponse(data)
            }
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let error {
                Bridge.log("AR99: write failed \(characteristic.uuid): \(error.localizedDescription)")
            }
            if characteristic.uuid == Ar99BLE.otaWrite {
                self.otaWriteInFlight = false
                self.processNextOtaWrite()
                return
            }
            self.writeInFlight = false
            self.processNextWrite()
        }
    }

    nonisolated func peripheralIsReady(toSendWriteWithoutResponse _: CBPeripheral) {
        DispatchQueue.main.async { [weak self] in
            self?.processNextWrite()
            self?.processNextOtaWrite()
        }
    }

    // MARK: - Scanning

    private func ensureCentralManager() {
        if centralManager == nil {
            centralManager = CBCentralManager(
                delegate: self,
                queue: nil,
                options: [CBCentralManagerOptionShowPowerAlertKey: false]
            )
        }
    }

    private func startScan(forConnection: Bool) {
        stopScan()
        scanForConnection = forConnection
        isScanning = true
        updateConnectionState(ConnTypes.SCANNING)
        ensureCentralManager()
        if centralManager?.state == .poweredOn {
            beginScan()
        }
    }

    private func beginScan() {
        centralManager?.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        scanTimeoutItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.stopScan()
        }
        scanTimeoutItem = item
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(Ar99Protocol.scanDurationMs),
            execute: item
        )
    }

    private func handleScanResult(
        central: CBCentralManager,
        peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi: Int
    ) {
        let localName =
            advertisementData[CBAdvertisementDataLocalNameKey] as? String
                ?? peripheral.name
        let manufacturerData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
        let advertisement = parseAdvertisement(localName: localName, manufacturerData: manufacturerData)
        let name = localName ?? advertisement?.bleName ?? advertisement?.projectName
        guard matchesAr99(name: name, projectName: advertisement?.projectName) else { return }

        let displayName = buildDisplayName(
            fallbackName: name ?? "AR99",
            advertisement: advertisement,
            deviceAddress: advertisement?.bleAddress ?? advertisement?.btAddress ?? peripheral.identifier.uuidString
        )

        if !scanForConnection {
            if discoveredNames.insert(displayName).inserted {
                Bridge.sendDiscoveredDevice(
                    type,
                    displayName,
                    deviceAddress: advertisement?.bleAddress?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                    rssi: rssi,
                    projectName: advertisement?.projectName
                )
            }
            return
        }

        if let projectName = advertisement?.projectName?.trimmingCharacters(in: .whitespacesAndNewlines), !projectName.isEmpty {
            currentProjectName = projectName
            if let bleAddress = advertisement?.bleAddress?.trimmingCharacters(in: .whitespacesAndNewlines), !bleAddress.isEmpty {
                currentBroadcastMacAddress = bleAddress
            } else {
                currentBroadcastMacAddress = nil
            }
        }

        guard matchesTarget(
            targetIdentifier ?? "",
            name: name,
            displayName: displayName,
            peripheralId: peripheral.identifier.uuidString,
            advertisement: advertisement
        ) else {
            return
        }

        stopScan()
        connectPeripheral(central: central, peripheral: peripheral, displayName: displayName)
    }

    private func connectPeripheral(
        central: CBCentralManager,
        peripheral: CBPeripheral,
        displayName: String
    ) {
        cleanupGatt(cancelPeripheral: true)
        lastConnectedDisplayName = displayName
        self.peripheral = peripheral
        peripheral.delegate = self
        DeviceStore.shared.apply("bluetooth", "device_name", displayName)
        DeviceStore.shared.apply("bluetooth", "device_address", peripheral.identifier.uuidString)
        DeviceStore.shared.apply("glasses", "bluetoothName", peripheral.name ?? displayName)
        updateConnectionState(ConnTypes.CONNECTING)
        central.connect(peripheral, options: nil)
    }

    private func matchesTarget(
        _ rawTarget: String,
        name: String?,
        displayName: String,
        peripheralId: String,
        advertisement: Ar99ParsedAdvertisement?
    ) -> Bool {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        if target.isEmpty { return true }
        let normalizedTarget = normalizeDisplayIdentifier(target)
        let targetSerial = extractTargetSerial(target)
        let candidates = [
            name,
            displayName,
            peripheralId,
            advertisement?.bleAddress,
            advertisement?.btAddress,
            advertisement?.serialNumber,
        ].compactMap { $0 }

        for candidate in candidates {
            if candidate.caseInsensitiveCompare(target) == .orderedSame
                || candidate.caseInsensitiveCompare(normalizedTarget) == .orderedSame
            {
                return true
            }
        }
        if let serial = advertisement?.serialNumber, !targetSerial.isEmpty {
            return serial.caseInsensitiveCompare(targetSerial) == .orderedSame
        }
        return false
    }

    // MARK: - GATT setup

    private func checkCharacteristicDiscoveryComplete() {
        guard pendingCharacteristicServices.isEmpty, !configuredNotifications else { return }
        configuredNotifications = true
        guard controlWriteCharacteristic != nil, controlNotifyCharacteristic != nil else {
            Bridge.log("AR99: missing required control characteristics")
            return
        }

        pendingNotifyCharacteristics.removeAll()
        if let controlNotifyCharacteristic {
            pendingNotifyCharacteristics.insert(controlNotifyCharacteristic.uuid)
            peripheral?.setNotifyValue(true, for: controlNotifyCharacteristic)
        }
        if let opusNotifyCharacteristic {
            pendingNotifyCharacteristics.insert(opusNotifyCharacteristic.uuid)
            peripheral?.setNotifyValue(true, for: opusNotifyCharacteristic)
        }
        if pendingNotifyCharacteristics.isEmpty {
            markReady()
            Ar99OtaManager.shared.tryResumeOtaAfterGattReady()
        }
    }

    private func markReady() {
        guard controlWriteCharacteristic != nil, controlNotifyCharacteristic != nil else { return }
        if fullyBooted, connected { return }

        minimalModeReady = false
        hasPendingDisplayUpdate = false
        pendingDisplayText = ""
        pendingSourceText = ""
        pendingTargetText = ""
        resetMinimalTextSession()
        hasReceivedBatteryForCurrentConnection = false
        pendingBatteryRetries = 0

        if let projectName = currentProjectName?.trimmingCharacters(in: .whitespacesAndNewlines), !projectName.isEmpty {
            DeviceStore.shared.apply("bluetooth", "project_name", projectName)
        }
        DeviceStore.shared.apply("glasses", "connected", true)
        DeviceStore.shared.apply("glasses", "fullyBooted", true)
        updateConnectionState(ConnTypes.CONNECTED)

        scheduleReadyCommands()
        scheduleBatteryQueries()
    }

    private func scheduleReadyCommands() {
        readyItems.forEach { $0.cancel() }
        readyItems.removeAll()
        runAfter(ms: Ar99Protocol.readyMinimalModeDelayMs) { [weak self] in self?.setMinimalDisplayMode() }
        runAfter(ms: Ar99Protocol.readyLanguageDelayMs) { [weak self] in self?.setDisplayLanguage(Ar99Protocol.displayLanguageEnglish) }
        runAfter(ms: Ar99Protocol.readyDeviceInfoDelayMs) { [weak self] in self?.requestDeviceInfo() }
        runAfter(ms: Ar99Protocol.readyBrightnessDelayMs) { [weak self] in self?.requestBrightness() }
        runAfter(ms: Ar99Protocol.readyBatteryDelayMs) { [weak self] in self?.getBatteryStatus() }
    }

    private func runAfter(ms: Int, _ block: @escaping () -> Void) {
        let item = DispatchWorkItem(block: block)
        readyItems.append(item)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: item)
    }

    private func scheduleBatteryQueries() {
        initialBatteryRetryItem?.cancel()
        periodicBatteryTimer?.invalidate()
        pendingBatteryRetries = 0
        scheduleInitialBatteryRetry()
        periodicBatteryTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(Ar99Protocol.batteryPollIntervalMs) / 1000, repeats: true) {
            [weak self] _ in
            guard let self, self.connected else { return }
            self.getBatteryStatus()
        }
    }

    private func scheduleInitialBatteryRetry() {
        initialBatteryRetryItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.connected else { return }
            guard !self.hasReceivedBatteryForCurrentConnection,
                  self.pendingBatteryRetries < Ar99Protocol.maxInitialBatteryRetries
            else {
                return
            }
            self.pendingBatteryRetries += 1
            self.getBatteryStatus()
            self.scheduleInitialBatteryRetry()
        }
        initialBatteryRetryItem = item
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(Ar99Protocol.initialBatteryRetryDelayMs),
            execute: item
        )
    }

    private func cleanupGatt(cancelPeripheral: Bool) {
        writeQueue.removeAll()
        otaWriteQueue.removeAll()
        writeDelayItem?.cancel()
        writeDelayItem = nil
        otaWriteDelayItem?.cancel()
        otaWriteDelayItem = nil
        writeInFlight = false
        otaWriteInFlight = false
        otaNotificationEnabled = false
        pendingCharacteristicServices.removeAll()
        pendingNotifyCharacteristics.removeAll()
        configuredNotifications = false
        controlNotifyBuffer.removeAll()
        controlWriteCharacteristic = nil
        controlNotifyCharacteristic = nil
        opusNotifyCharacteristic = nil
        otaWriteCharacteristic = nil
        otaNotifyCharacteristic = nil
        minimalModeReady = false
        resetMinimalTextSession()
        hasPendingDisplayUpdate = false
        pendingDisplayText = ""
        pendingSourceText = ""
        pendingTargetText = ""
        hasReceivedBatteryForCurrentConnection = false
        pendingBatteryRetries = 0
        readyItems.forEach { $0.cancel() }
        readyItems.removeAll()
        initialBatteryRetryItem?.cancel()
        initialBatteryRetryItem = nil
        periodicBatteryTimer?.invalidate()
        periodicBatteryTimer = nil
        opusLoggedFirstInSession = false
        opusDecoder?.resetBuffer()
        awaitingMicDisableAck = false

        if cancelPeripheral, let peripheral {
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        peripheral?.delegate = nil
        peripheral = nil

        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "micEnabled", false)
        DeviceStore.shared.apply("glasses", "batteryLevel", -1)
        DeviceStore.shared.apply("glasses", "charging", false)
    }

    private func updateConnectionState(_ state: String) {
        DeviceStore.shared.apply("glasses", "connectionState", state)
    }

    // MARK: - Writes

    private func enqueueMessage(function: Int, cmd: Int, payload: Data, receiver: Int) {
        let packet = buildHeader(
            function: function,
            cmd: cmd,
            payload: payload,
            sender: Ar99Protocol.targetMobileApp,
            receiver: receiver,
            isResponse: false
        )
        var offset = 0
        while offset < packet.count {
            let end = min(offset + Ar99Protocol.bleWriteChunkSize, packet.count)
            writeQueue.append(packet.subdata(in: offset ..< end))
            offset = end
        }
        processNextWrite()
    }

    private func processNextWrite() {
        guard !writeInFlight,
              let peripheral,
              let characteristic = controlWriteCharacteristic,
              !writeQueue.isEmpty
        else {
            return
        }

        let data = writeQueue.removeFirst()
        let writeType: CBCharacteristicWriteType =
            characteristic.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse

        writeInFlight = true
        peripheral.writeValue(data, for: characteristic, type: writeType)
        if writeType == .withoutResponse {
            writeDelayItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                self?.writeInFlight = false
                self?.processNextWrite()
            }
            writeDelayItem = item
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(Ar99Protocol.bleWriteChunkDelayMs),
                execute: item
            )
        }
    }

    private func processNextOtaWrite() {
        guard !otaWriteInFlight,
              let peripheral,
              let characteristic = otaWriteCharacteristic,
              !otaWriteQueue.isEmpty
        else {
            return
        }

        var writeType: CBCharacteristicWriteType = .withResponse
        if characteristic.properties.contains(.writeWithoutResponse) {
            let maxWithoutResponse = peripheral.maximumWriteValueLength(for: .withoutResponse)
            if otaWriteQueue[0].count <= maxWithoutResponse {
                writeType = .withoutResponse
            }
        }

        let maxLength = peripheral.maximumWriteValueLength(for: writeType)
        guard otaWriteQueue[0].count <= maxLength else {
            let dropped = otaWriteQueue.removeFirst()
            sendAr99OtaStatus(
                phase: "failed",
                progress: Ar99OtaManager.shared.getProgress(),
                offset: 0,
                total: 0,
                errorMessage: "OTA packet too large for current BLE write length: \(dropped.count) > \(maxLength)"
            )
            return
        }

        if writeType == .withoutResponse, !peripheral.canSendWriteWithoutResponse {
            return
        }

        let data = otaWriteQueue.removeFirst()
        otaWriteInFlight = true
        peripheral.writeValue(data, for: characteristic, type: writeType)
        if writeType == .withoutResponse {
            otaWriteInFlight = false
            otaWriteDelayItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                self?.processNextOtaWrite()
            }
            otaWriteDelayItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(1), execute: item)
        }
    }

    private func buildHeader(
        function: Int,
        cmd: Int,
        payload: Data,
        sender: Int,
        receiver: Int,
        isResponse: Bool
    ) -> Data {
        var data = Data()
        let ctrl =
            (sender & Ar99Protocol.ctrlSenderMask)
                | ((receiver & Ar99Protocol.ctrlSenderMask) << 2)
                | (isResponse ? Ar99Protocol.ctrlActionResponse : 0)
        Ar99ProtoWriter.writeFixed32(field: 1, value: Ar99Protocol.magicNumber, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 2, value: function, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 3, value: cmd, to: &data)
        if !payload.isEmpty {
            Ar99ProtoWriter.writeUInt32(field: 4, value: payload.count, to: &data)
        }
        Ar99ProtoWriter.writeUInt32(field: 5, value: ctrl, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 6, value: nextSequence(), to: &data)
        if !payload.isEmpty {
            Ar99ProtoWriter.writeUInt32(field: 7, value: checksum16(payload), to: &data)
            Ar99ProtoWriter.writeBytes(field: 8, value: payload, to: &data)
        }
        return data
    }

    private func nextSequence() -> Int {
        while true {
            let seq = sequence & 0x7F
            sequence += 1
            if seq != 0 { return seq }
        }
    }

    private func checksum16(_ data: Data) -> Int {
        data.reduce(0) { ($0 + Int($1)) & 0xFFFF }
    }

    // MARK: - Payload builders

    private func buildProtoUInt32(field: Int, value: Int) -> Data {
        var data = Data()
        Ar99ProtoWriter.writeUInt32(field: field, value: value, to: &data)
        return data
    }

    private func buildProtoBool(field: Int, value: Bool) -> Data {
        var data = Data()
        Ar99ProtoWriter.writeBool(field: field, value: value, to: &data)
        return data
    }

    private func buildSetTimePayload(timestampMs: Int64) -> Data {
        var data = Data()
        let timeZone = TimeZone.current
        let timezoneOffsetMinutes = timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: TimeInterval(timestampMs) / 1000)) / 60
        let hourFormat = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: Locale.current) ?? ""
        let is24Hour = !hourFormat.contains("a")

        Ar99ProtoWriter.writeInt64(field: 1, value: timestampMs, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 2, value: 1, to: &data)
        Ar99ProtoWriter.writeBool(field: 3, value: is24Hour, to: &data)
        Ar99ProtoWriter.writeInt32(field: 4, value: timezoneOffsetMinutes, to: &data)
        Ar99ProtoWriter.writeString(field: 5, value: timeZone.identifier, to: &data)
        return data
    }

    private func buildTranslationDisplayStartPayload(
        sourceLanguage: Int,
        targetLanguage: Int,
        micSource: Int
    ) -> Data {
        var data = Data()
        Ar99ProtoWriter.writeUInt32(field: 1, value: sourceLanguage, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 2, value: targetLanguage, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 3, value: micSource, to: &data)
        return data
    }

    private func buildTranslationDisplaySetContentPayload(
        state: Int,
        fontSize: Int,
        sourceText: String,
        targetText: String
    ) -> Data {
        var data = Data()
        Ar99ProtoWriter.writeUInt32(field: 1, value: state, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 2, value: fontSize, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 3, value: Ar99Protocol.transDisplaySourceLanguage, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 4, value: Ar99Protocol.transDisplayTargetLanguage, to: &data)
        Ar99ProtoWriter.writeString(field: 5, value: sourceText, to: &data)
        Ar99ProtoWriter.writeString(field: 6, value: targetText, to: &data)
        return data
    }

    private func buildDisplaySystemFunctionPayload(functionType: Int, action: Int) -> Data {
        var data = Data()
        Ar99ProtoWriter.writeUInt32(field: 1, value: functionType, to: &data)
        Ar99ProtoWriter.writeUInt32(field: 2, value: action, to: &data)
        return data
    }

    private func buildControlDisplayAudioRecordPayload(enabled: Bool) -> Data {
        var data = Data()
        Ar99ProtoWriter.writeBool(field: 1, value: !enabled, to: &data)
        return data
    }

    private func buildMinimalTextSetPayload(_ text: String) -> Data {
        var data = Data()
        Ar99ProtoWriter.writeString(field: 1, value: text, to: &data)
        return data
    }

    // MARK: - High-level AR99 commands

    private func sendMinimalText(_ text: String) {
        let normalizedText = text
        if !minimalModeReady {
            pendingDisplayText = normalizedText
            hasPendingDisplayUpdate = true
            return
        }

        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if displaySessionStarted,
           lastDisplayContentAtMs > 0,
           now - lastDisplayContentAtMs >= Ar99Protocol.displaySessionIdleRestartMs
        {
            displaySessionStarted = false
            lastDisplayText = ""
        }
        sendMinimalTextNow(normalizedText)
    }

    private func sendMinimalTextNow(_ text: String) {
        let normalizedText = text
        if normalizedText == lastDisplayText {
            return
        }

        if normalizedText.isEmpty {
            clearMinimalTextNow()
            return
        }

        startMinimalTextIfNeeded()
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayCtrlMinimalTextSet,
            payload: buildMinimalTextSetPayload(normalizedText),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )

        lastDisplayText = normalizedText
        lastDisplayContentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
    }

    private func flushPendingDisplayUpdateIfNeeded() {
        guard minimalModeReady, hasPendingDisplayUpdate else { return }
        let text = pendingDisplayText
        hasPendingDisplayUpdate = false
        pendingDisplayText = ""
        sendMinimalTextNow(text)
    }

    private func startMinimalTextIfNeeded() {
        guard !displaySessionStarted else { return }
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayCtrlMinimalTextStart,
            payload: Data(),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
        displaySessionStarted = true
        lastDisplayContentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
    }

    private func clearMinimalText() {
        if !minimalModeReady {
            pendingDisplayText = ""
            hasPendingDisplayUpdate = false
            lastDisplayText = ""
            return
        }
        clearMinimalTextNow()
    }

    private func clearMinimalTextNow() {
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayCtrlMinimalTextClear,
            payload: Data(),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
        resetMinimalTextSession()
    }

    private func resetMinimalTextSession() {
        displaySessionStarted = false
        displayContentStarted = false
        lastDisplayContentAtMs = 0
        lastDisplayText = ""
        lastDisplaySourceText = ""
        lastDisplayTargetText = ""
    }

    private func joinDisplayLines(_ top: String, _ bottom: String) -> String {
        let first = top.trimmingCharacters(in: .whitespacesAndNewlines)
        let second = bottom.trimmingCharacters(in: .whitespacesAndNewlines)
        if first.isEmpty { return second }
        if second.isEmpty { return first }
        return "\(first)\n\(second)"
    }

    private func sendControlDisplayAudioRecord(_ enabled: Bool) {
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayCtrlAudioRecord,
            payload: buildControlDisplayAudioRecordPayload(enabled: enabled),
            receiver: Ar99Protocol.targetGlassAndroid
        )
    }

    private func setMinimalDisplayMode() {
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayCtrlSysFunction,
            payload: buildDisplaySystemFunctionPayload(
                functionType: Ar99Protocol.displayFunctionTypeUiMode,
                action: Ar99Protocol.displayUiModeMinimal
            ),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    private func setDisplayLanguage(_ language: Int) {
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplaySetLanguage,
            payload: buildProtoUInt32(field: 1, value: language),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    private func requestDeviceInfo() {
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayGetDeviceInfo,
            payload: Data(),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    private func requestBrightness() {
        enqueueMessage(
            function: Ar99Protocol.funcCommDisplay,
            cmd: Ar99Protocol.cmdDisplayGetBright,
            payload: Data(),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    func sendSetSystemTime(_ timestampMs: Int64) {
        Bridge.log("AR99: sending set time timestampMs=\(timestampMs)")
        enqueueMessage(
            function: Ar99Protocol.funcComm,
            cmd: Ar99Protocol.cmdCommSetTime,
            payload: buildSetTimePayload(timestampMs: timestampMs),
            receiver: Ar99Protocol.targetGlassMcuDisplay
        )
    }

    // MARK: - Notifications

    private func handleControlNotifyChunk(_ data: Data) {
        guard !data.isEmpty else { return }
        controlNotifyBuffer.append(data)

        while true {
            guard let start = findMessageStart(in: controlNotifyBuffer, from: 0) else {
                trimControlNotifyBuffer()
                return
            }
            if start > 0 {
                controlNotifyBuffer.removeFirst(start)
            }

            let nextStart = findMessageStart(in: controlNotifyBuffer, from: 1)
            let candidate =
                nextStart.map { controlNotifyBuffer.prefix($0) }
                    ?? controlNotifyBuffer[controlNotifyBuffer.startIndex ..< controlNotifyBuffer.endIndex]
            guard let header = parseHeader(Data(candidate)) else {
                if let nextStart, nextStart > 0 {
                    controlNotifyBuffer.removeFirst(nextStart)
                    continue
                }
                trimControlNotifyBuffer()
                return
            }

            guard controlNotifyBuffer.count >= header.totalBytes else {
                trimControlNotifyBuffer()
                return
            }

            let packet = controlNotifyBuffer.prefix(header.totalBytes)
            controlNotifyBuffer.removeFirst(header.totalBytes)
            handleControlPacket(Data(packet))
        }
    }

    private func trimControlNotifyBuffer() {
        guard controlNotifyBuffer.count > 2_048 else { return }
        if let start = findMessageStart(in: controlNotifyBuffer, from: 0), start > 0 {
            controlNotifyBuffer.removeFirst(start)
        } else {
            controlNotifyBuffer.removeAll()
        }
    }

    private func findMessageStart(in data: Data, from: Int) -> Int? {
        let bytes = Array(data)
        guard bytes.count >= Ar99Protocol.messageStart.count else { return nil }
        let start = max(0, from)
        let maxIndex = bytes.count - Ar99Protocol.messageStart.count
        guard start <= maxIndex else { return nil }
        for index in start ... maxIndex {
            var matched = true
            for j in 0 ..< Ar99Protocol.messageStart.count where bytes[index + j] != Ar99Protocol.messageStart[j] {
                matched = false
                break
            }
            if matched { return index }
        }
        return nil
    }

    private func handleControlPacket(_ data: Data) {
        guard let header = parseHeader(data) else { return }
        let isResponse = (header.ctrl & Ar99Protocol.ctrlActionResponse) != 0
        if header.function == Ar99Protocol.funcComm {
            handleCommMessage(cmd: header.cmd, isResponse: isResponse, payload: header.payload)
        } else if header.function == Ar99Protocol.funcCommDisplay {
            if header.cmd == Ar99Protocol.cmdDisplayCtrlAudioRecord {
                handleLegacyAudioRecordMessage(isResponse: isResponse, payload: header.payload)
            } else {
                handleDisplayMessage(cmd: header.cmd, isResponse: isResponse, payload: header.payload)
            }
        } else if header.function == Ar99Protocol.funcTrans {
            handleTransMessage(cmd: header.cmd, isResponse: isResponse, payload: header.payload)
        }
    }

    private func handleOpusData(_ data: Data) {
        guard !data.isEmpty else { return }
        if !opusLoggedFirstInSession {
            opusLoggedFirstInSession = true
            Bridge.log("AR99: first Opus notify len=\(data.count)")
        }
        ensureOpusDecoder()
        opusDecoder?.submitBleNotify(data)
    }

    private func ensureOpusDecoder() {
        guard opusDecoder == nil else { return }
        opusDecoder = Ar99OpusPcmDecoder { pcm in
            DeviceManager.shared.reportGlassesAudioActivity()
            DeviceManager.shared.handlePcm(pcm)
        }
        if opusDecoder == nil {
            Bridge.log("AR99: system Opus decoder unavailable")
        }
    }

    // MARK: - Response handling

    private func handleTransMessage(cmd: Int, isResponse: Bool, payload: Data) {
        if !isResponse, cmd == Ar99Protocol.cmdTransDisplayStop {
            setMicEnabled(false)
            resetMinimalTextSession()
            return
        }

        if isResponse, cmd == Ar99Protocol.cmdTransDisplayStop {
            if parseSuccessResponse(payload) == true {
                resetMinimalTextSession()
            }
            return
        }
    }

    private func handleDisplayMessage(cmd: Int, isResponse: Bool, payload: Data) {
        switch cmd {
        case Ar99Protocol.cmdDisplayGetBattery:
            guard let info = parseBatteryResponse(payload) else { return }
            guard info.battery >= 0, info.battery <= 100 else { return }
            let charging = info.charging ?? (DeviceStore.shared.get("glasses", "charging") as? Bool ?? false)
            DeviceStore.shared.apply("glasses", "batteryLevel", info.battery)
            if info.charging != nil {
                DeviceStore.shared.apply("glasses", "charging", charging)
            }
            Bridge.sendBatteryStatus(level: info.battery, charging: charging)
            hasReceivedBatteryForCurrentConnection = true
            pendingBatteryRetries = 0
            initialBatteryRetryItem?.cancel()

        case Ar99Protocol.cmdDisplayGetDeviceInfo:
            guard let info = parseDeviceInfoResponse(payload) else { return }
            if let firmwareVersion = info.firmwareVersion {
                DeviceStore.shared.apply("glasses", "firmwareVersion", firmwareVersion)
            }
            if let productName = info.productName {
                DeviceStore.shared.apply("glasses", "deviceModel", productName)
            }
            let preferredBtMac = currentBroadcastMacAddress?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? currentBroadcastMacAddress : info.btMac
            if let btMac = preferredBtMac, !btMac.isEmpty {
                DeviceStore.shared.apply("glasses", "bluetoothMacAddress", btMac)
            }
            if let serialNumber = info.serialNumber {
                DeviceStore.shared.apply("glasses", "serialNumber", serialNumber)
            }
            sendVersionInfo(info)

        case Ar99Protocol.cmdDisplayGetBright:
            if let brightness = parseBrightnessResponse(payload) {
                DeviceStore.shared.apply("glasses", "brightness", brightness)
            }

        case Ar99Protocol.cmdDisplaySetBright:
            if let brightness = parseSetBrightnessResponse(payload) {
                DeviceStore.shared.apply("glasses", "brightness", brightness)
            }

        case Ar99Protocol.cmdDisplaySetLanguage:
            _ = parseLanguageResponse(payload)

        case Ar99Protocol.cmdDisplayCtrlFactoryReset:
            if let success = parseSuccessResponse(payload) {
                let confirmCode = parseFactoryResetConfirmCode(payload) ?? -1
                Bridge.log("AR99: factory reset response success=\(success) confirmCode=\(confirmCode)")
            }

        case Ar99Protocol.cmdDisplayCtrlSysFunction:
            if parseSuccessResponse(payload) == true {
                minimalModeReady = true
                flushPendingDisplayUpdateIfNeeded()
            }

        case Ar99Protocol.cmdDisplayCtrlMinimalTextStart,
             Ar99Protocol.cmdDisplayCtrlMinimalTextSet,
             Ar99Protocol.cmdDisplayCtrlMinimalTextClear,
             Ar99Protocol.cmdDisplayCtrlMinimalTextStop:
            let success = parseSuccessResponse(payload)
            if isResponse, success == false {
                if cmd == Ar99Protocol.cmdDisplayCtrlMinimalTextStart {
                    displaySessionStarted = false
                } else if cmd == Ar99Protocol.cmdDisplayCtrlMinimalTextClear || cmd == Ar99Protocol.cmdDisplayCtrlMinimalTextStop {
                    resetMinimalTextSession()
                }
            }

        default:
            break
        }
    }

    private func handleCommMessage(cmd: Int, isResponse _: Bool, payload: Data) {
        if cmd == Ar99Protocol.cmdCommSetTime {
            _ = parseSetTimeResponse(payload)
        }
    }

    private func handleLegacyAudioRecordMessage(isResponse _: Bool, payload: Data) {
        guard let currentRecording = parseLegacyAudioRecordResponse(payload) else { return }
        if !currentRecording {
            awaitingMicDisableAck = false
            opusDecoder?.resetBuffer()
        }
        DeviceStore.shared.apply("glasses", "micEnabled", currentRecording)
    }

    // MARK: - Proto parsing

    private func parseHeader(_ data: Data) -> Ar99MessageHeader? {
        var reader = Ar99ProtoReader(data)
        var magic: UInt32 = 0
        var function = 0
        var cmd = 0
        var ctrl = 0
        var sequence = 0
        var payload = Data()
        var totalBytes = -1

        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1 where field.wire == 5:
                guard let value = reader.readFixed32() else { return nil }
                magic = value
            case 2 where field.wire == 0:
                guard let value = reader.readVarint() else { return nil }
                function = Int(value)
            case 3 where field.wire == 0:
                guard let value = reader.readVarint() else { return nil }
                cmd = Int(value)
            case 5 where field.wire == 0:
                guard let value = reader.readVarint() else { return nil }
                ctrl = Int(value)
            case 6 where field.wire == 0:
                guard let value = reader.readVarint() else { return nil }
                sequence = Int(value)
            case 8 where field.wire == 2:
                guard let value = reader.readLengthDelimited() else { return nil }
                payload = value
                totalBytes = reader.offset
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }

        guard magic == Ar99Protocol.magicNumber else { return nil }
        return Ar99MessageHeader(
            function: function,
            cmd: cmd,
            ctrl: ctrl,
            sequence: sequence,
            payload: payload,
            totalBytes: totalBytes > 0 ? totalBytes : data.count
        )
    }

    private func parseBatteryResponse(_ payload: Data) -> Ar99BatteryInfo? {
        parseBatteryResponseNested(payload) ?? parseBatteryResponseFlat(payload)
    }

    private func parseBatteryResponseNested(_ payload: Data) -> Ar99BatteryInfo? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        var battery = -1
        var charging: Bool?

        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1:
                success = readSuccessField(reader: &reader, wire: field.wire)
            case 2 where field.wire == 0:
                battery = Int(reader.readVarint() ?? UInt64.max)
            case 3 where field.wire == 0:
                charging = (reader.readVarint() ?? 0) != 0
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }

        guard success == true else { return nil }
        return Ar99BatteryInfo(battery: battery, charging: charging)
    }

    private func parseBatteryResponseFlat(_ payload: Data) -> Ar99BatteryInfo? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        var battery: Int?
        var charging: Bool?

        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1:
                if field.wire == 2, let raw = reader.readLengthDelimited() {
                    success = parseCommonResult(raw)?.success
                } else if field.wire == 0, let value = reader.readVarint() {
                    if value == 0 || value == 1 {
                        success = value == 1
                    } else if battery == nil, value <= 100 {
                        battery = Int(value)
                    }
                } else {
                    guard reader.skipField(wire: field.wire) else { return nil }
                }
            case 2 where field.wire == 0:
                guard let value = reader.readVarint() else { return nil }
                if battery == nil, value <= 100 {
                    battery = Int(value)
                } else if charging == nil, value == 0 || value == 1 {
                    charging = value == 1
                }
            case 3 where field.wire == 0:
                charging = (reader.readVarint() ?? 0) != 0
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }

        guard let battery, success != false else { return nil }
        return Ar99BatteryInfo(battery: battery, charging: charging)
    }

    private func parseDeviceInfoResponse(_ payload: Data) -> Ar99DeviceInfo? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        var firmware: String?
        var version: String?
        var deviceName: String?
        var productName: String?
        var btMac: String?
        var serial: String?

        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1:
                success = readSuccessField(reader: &reader, wire: field.wire)
            case 2 where field.wire == 2:
                firmware = reader.readString()
            case 5 where field.wire == 2:
                version = reader.readString()
            case 6 where field.wire == 2:
                deviceName = reader.readString()
            case 7 where field.wire == 2:
                productName = reader.readString()
            case 8 where field.wire == 2:
                btMac = reader.readString()
            case 9 where field.wire == 2:
                serial = reader.readString()
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }

        guard success == true else { return nil }
        return Ar99DeviceInfo(
            firmwareVersion: (version?.isEmpty == false ? version : firmware),
            deviceName: deviceName,
            productName: productName,
            btMac: btMac,
            serialNumber: serial
        )
    }

    private func parseLanguageResponse(_ payload: Data) -> Ar99LanguageResponse? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        var language: Int?

        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1:
                success = readSuccessField(reader: &reader, wire: field.wire)
            case 2 where field.wire == 0:
                language = Int(reader.readVarint() ?? 0)
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }

        guard let success else { return nil }
        return Ar99LanguageResponse(success: success, language: language)
    }

    private func parseSetTimeResponse(_ payload: Data) -> Ar99SetTimeResponse? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        var timeValue: Int64?

        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1:
                success = readSuccessField(reader: &reader, wire: field.wire)
            case 2 where field.wire == 0:
                timeValue = Int64(bitPattern: reader.readVarint() ?? 0)
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }

        guard let success else { return nil }
        return Ar99SetTimeResponse(success: success, timeValue: timeValue)
    }

    private func sendVersionInfo(_ info: Ar99DeviceInfo) {
        var values: [String: Any] = [:]
        if let firmwareVersion = info.firmwareVersion {
            values["firmwareVersion"] = firmwareVersion
        }
        if let productName = info.productName {
            values["deviceModel"] = productName
        }
        if let serialNumber = info.serialNumber {
            values["serialNumber"] = serialNumber
        }
        Bridge.sendVersionInfo(values)
    }

    private func parseBrightnessResponse(_ payload: Data) -> Int? {
        parseBrightnessPayload(payload)
    }

    private func parseSetBrightnessResponse(_ payload: Data) -> Int? {
        parseBrightnessPayload(payload)
    }

    private func parseBrightnessPayload(_ payload: Data) -> Int? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        var brightness: Int?
        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1:
                success = readSuccessField(reader: &reader, wire: field.wire)
            case 2 where field.wire == 0:
                brightness = Int(reader.readVarint() ?? 0)
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }
        return success == true ? brightness : nil
    }

    private func parseSuccessResponse(_ payload: Data) -> Bool? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            if field.field == 1 {
                success = readSuccessField(reader: &reader, wire: field.wire)
            } else {
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }
        return success
    }

    private func parseFactoryResetConfirmCode(_ payload: Data) -> Int? {
        var reader = Ar99ProtoReader(payload)
        var confirmCode: Int?
        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1:
                _ = readSuccessField(reader: &reader, wire: field.wire)
            case 2 where field.wire == 0:
                confirmCode = Int(reader.readVarint() ?? 0)
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }
        return confirmCode
    }

    private func parseLegacyAudioRecordResponse(_ payload: Data) -> Bool? {
        var reader = Ar99ProtoReader(payload)
        var success: Bool?
        var start: Bool?
        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1 where field.wire == 0:
                success = (reader.readVarint() ?? 0) != 0
            case 2 where field.wire == 0:
                start = (reader.readVarint() ?? 0) != 0
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }
        guard success == true, let start else { return nil }
        return !start
    }

    private func readSuccessField(reader: inout Ar99ProtoReader, wire: Int) -> Bool? {
        if wire == 0 {
            return (reader.readVarint() ?? 0) != 0
        }
        if wire == 2, let raw = reader.readLengthDelimited() {
            return parseCommonResult(raw)?.success
        }
        _ = reader.skipField(wire: wire)
        return nil
    }

    private func parseCommonResult(_ raw: Data) -> Ar99CommonResult? {
        var reader = Ar99ProtoReader(raw)
        var success = false
        var errorCode = 0
        var errorMessage = ""
        while !reader.isAtEnd {
            guard let field = reader.nextField() else { break }
            switch field.field {
            case 1 where field.wire == 0:
                success = (reader.readVarint() ?? 0) != 0
            case 2 where field.wire == 0:
                errorCode = Int(reader.readVarint() ?? 0)
            case 3 where field.wire == 2:
                errorMessage = reader.readString() ?? ""
            default:
                guard reader.skipField(wire: field.wire) else { return nil }
            }
        }
        return Ar99CommonResult(success: success, errorCode: errorCode, errorMessage: errorMessage)
    }

    // MARK: - Advertisement parsing

    private func parseAdvertisement(localName: String?, manufacturerData: Data?) -> Ar99ParsedAdvertisement? {
        var parsed: Ar99ParsedAdvertisement?
        if let data = manufacturerData {
            for base in [0, 2] where base + 20 <= data.count {
                let projectName = trimAscii4(data, offset: base)
                guard matchesAr99(name: nil, projectName: projectName) else { continue }
                parsed = Ar99ParsedAdvertisement(
                    bleName: localName,
                    projectName: projectName,
                    bleAddress: xorMac6ToColon(data, offset: base + 8),
                    btAddress: xorMac6ToColon(data, offset: base + 14),
                    serialNumber: parseAr99SerialNumber(data, base: base)
                )
                break
            }
        }
        if let parsed {
            return parsed
        }
        if matchesAr99(name: localName, projectName: nil) {
            return Ar99ParsedAdvertisement(
                bleName: localName,
                projectName: nil,
                bleAddress: nil,
                btAddress: nil,
                serialNumber: nil
            )
        }
        return nil
    }

    private func matchesAr99(name _: String?, projectName: String?) -> Bool {
        isSupportedProjectName(projectName)
    }

    private func isSupportedProjectName(_ projectName: String?) -> Bool {
        guard let projectName = projectName?.trimmingCharacters(in: .whitespacesAndNewlines), !projectName.isEmpty else {
            return false
        }
        return supportedProjectNames.contains { $0.caseInsensitiveCompare(projectName) == .orderedSame }
    }

    private func trimAscii4(_ data: Data, offset: Int) -> String {
        let bytes = Array(data)
        guard offset < bytes.count else { return "" }
        var end = min(offset + 4, bytes.count)
        while end > offset, bytes[end - 1] == 0 {
            end -= 1
        }
        guard end > offset else { return "" }
        return String(data: Data(bytes[offset ..< end]), encoding: .utf8) ?? ""
    }

    private func xorMac6ToColon(_ data: Data, offset: Int) -> String? {
        let bytes = Array(data)
        guard offset + 6 <= bytes.count else { return nil }
        return (0 ..< 6)
            .map { String(format: "%02X", (bytes[offset + $0] ^ 0xAD) & 0xFF) }
            .joined(separator: ":")
    }

    private func parseAr99SerialNumber(_ data: Data, base: Int) -> String? {
        let bytes = Array(data)
        let serialOffset = base + 20
        if serialOffset + 12 <= bytes.count,
           !isAllZeroBytes(bytes, offset: serialOffset, length: 12),
           isAsciiDigits(bytes, offset: serialOffset, length: 12)
        {
            return safeAscii(bytes, offset: serialOffset, length: 12)
        }

        if serialOffset + 6 <= bytes.count {
            if !isAllZeroBytes(bytes, offset: serialOffset, length: 6),
               isAsciiDigits(bytes, offset: serialOffset, length: 6)
            {
                return safeAscii(bytes, offset: serialOffset, length: 6)
            }
            if !isAllZeroBytes(bytes, offset: serialOffset, length: 6) {
                return bytes6ToHex12(bytes, offset: serialOffset)
            }
        }

        return nil
    }

    private func isAsciiDigits(_ bytes: [UInt8], offset: Int, length: Int) -> Bool {
        guard offset + length <= bytes.count else { return false }
        return (0 ..< length).allSatisfy { bytes[offset + $0] >= 48 && bytes[offset + $0] <= 57 }
    }

    private func isAllZeroBytes(_ bytes: [UInt8], offset: Int, length: Int) -> Bool {
        guard offset + length <= bytes.count else { return true }
        let slice = bytes[offset ..< offset + length]
        return slice.allSatisfy { $0 == 0 } || slice.allSatisfy { $0 == 48 }
    }

    private func safeAscii(_ bytes: [UInt8], offset: Int, length: Int) -> String? {
        guard offset + length <= bytes.count else { return nil }
        return String(data: Data(bytes[offset ..< offset + length]), encoding: .utf8)
    }

    private func bytes6ToHex12(_ bytes: [UInt8], offset: Int) -> String? {
        guard offset + 6 <= bytes.count else { return nil }
        return (0 ..< 6).map { String(format: "%02X", bytes[offset + $0]) }.joined()
    }

    private func buildDisplayName(
        fallbackName: String,
        advertisement: Ar99ParsedAdvertisement?,
        deviceAddress: String?
    ) -> String {
        if let serial = advertisement?.serialNumber?.trimmingCharacters(in: .whitespacesAndNewlines),
           !serial.isEmpty
        {
            return "SN: \(serial)"
        }
        let bleName = advertisement?.bleName ?? fallbackName
        let legacyNameSerial = extractLegacyNameSerial(bleName)
        if !legacyNameSerial.isEmpty {
            return "SN: \(legacyNameSerial)"
        }
        if let deviceAddress = deviceAddress?.trimmingCharacters(in: .whitespacesAndNewlines),
           !deviceAddress.isEmpty
        {
            return "MAC: \(deviceAddress)"
        }
        return fallbackName
    }

    private func extractTargetSerial(_ target: String) -> String {
        let trimmed = normalizeDisplayIdentifier(target)
        guard !trimmed.isEmpty else { return "" }
        if let underscore = trimmed.lastIndex(of: "_"), underscore < trimmed.index(before: trimmed.endIndex) {
            return String(trimmed[trimmed.index(after: underscore)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    private func normalizeDisplayIdentifier(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let upper = trimmed.uppercased()
        if upper.hasPrefix("SN:") {
            return String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if upper.hasPrefix("MAC:") {
            return String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    private func extractLegacyNameSerial(_ bleName: String?) -> String {
        guard let bleName else { return "" }
        let trimmed = bleName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let underscore = trimmed.firstIndex(of: "_"), underscore < trimmed.index(before: trimmed.endIndex) else {
            return ""
        }
        return String(trimmed[trimmed.index(after: underscore)...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
