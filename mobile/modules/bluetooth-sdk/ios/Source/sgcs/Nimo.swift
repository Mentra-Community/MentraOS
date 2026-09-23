//
//  Nimo.swift
//
//  SGC for Nimo glasses. Native implementation of the vendor's BLE protocol:
//  a 0xBF-framed UART channel (service 7033) for commands/content, plus a
//  separate H-T-L-V Opus microphone channel (char 2025).
//

import AVFoundation
import CoreBluetooth
import Foundation

// MARK: - Nimo BLE Constants

enum NimoBLE {
    // UART-style service: TX = phone→glasses commands, RX = glasses→phone notifications.
    // Short UUIDs from the vendor SDK expanded onto the Bluetooth base UUID.
    static let SERVICE_UUID = CBUUID(string: "00007033-0000-1000-8000-00805F9B34FB")
    static let CHAR_TX = CBUUID(string: "00002021-0000-1000-8000-00805F9B34FB")
    static let CHAR_RX = CBUUID(string: "00002022-0000-1000-8000-00805F9B34FB")
    static let CHAR_MIC = CBUUID(string: "00002025-0000-1000-8000-00805F9B34FB")
    static let CHAR_OTA_TX = CBUUID(string: "00002001-0000-1000-8000-00805F9B34FB")
    static let CHAR_OTA_RX = CBUUID(string: "00002002-0000-1000-8000-00805F9B34FB")

    static let NAME_PREFIX = "nimo"
    /// iOS ANCS side-channel devices advertise "<name>_ble" — never the data channel.
    static let BLE_NAME_SUFFIX = "_ble"

    static let CHUNK_SIZE = 501
    static let INTER_FRAME_DELAY_MS = 5
}

// MARK: - Nimo Protocol Constants

// Byte values follow the glasses firmware protocol and must not be changed.

enum NimoProtocol {
    static let FRAME_MAGIC: UInt8 = 0xBF

    // status bits
    static let STATUS_ERR: UInt8 = 0x01
    static let STATUS_ACK: UInt8 = 0x02

    // command categories
    static let CMD_GET_PARAMETER = 0x02
    static let CMD_SET_PARAMETER = 0x03
    static let CMD_INSTRUCTION_REPORT = 0x06
    static let CMD_CONTROL_INSTRUCTION = 0x07
    static let CMD_CONTROL_NOTIFICATION = 0x09

    // get parameter keys
    static let GET_BATTERY = 0x06
    static let GET_VERSION = 0x0A
    static let GET_VERSION_DETAIL = 0x0B
    static let GET_TWS_STATUS = 0x16

    // set parameter keys
    static let SET_TIME = 0x01
    static let SET_BRIGHTNESS = 0x02
    static let SET_DISTANCE = 0x03
    static let SET_ANGLE = 0x04
    static let SET_HEADUP_DISPLAY = 0x0D
    static let SET_AUTO_BRIGHTNESS = 0x0E
    static let SET_DISPLAY_OFF = 0x0F
    static let SET_PHONE_TYPE = 0x14
    static let SET_HEIGHT_LEVEL = 0x17

    // control instruction keys
    static let CTRL_ENTER_APP = 0x01
    static let CTRL_QUIT_APP = 0x03
    static let CTRL_UPDATE_CONTENT = 0x04

    /// notification keys
    static let NOTIFICATION_SEND = 0x01

    // report keys (cmd 0x06)
    static let REPORT_INPUT = 0x01
    static let REPORT_APP = 0x02
    static let REPORT_TWS = 0x03
    static let REPORT_BUSINESS = 0x04
    static let REPORT_GATT_STATE = 0x05

    // business report ids
    static let BUSINESS_HEARTBEAT = 0x03
    static let BUSINESS_BATTERY = 0x05

    // input event codes
    static let INPUT_HEAD_UP = 0x01
    static let INPUT_HEAD_DOWN = 0x02
    static let INPUT_CLICK_RIGHT = 0x03
    static let INPUT_DOUBLE_CLICK_RIGHT = 0x04
    static let INPUT_LONG_PRESS_RIGHT = 0x05
    static let INPUT_TOUCH_PRESS_RIGHT = 0x06
    static let INPUT_TOUCH_RELEASE_RIGHT = 0x07
    static let INPUT_CLICK_LEFT = 0x13
    static let INPUT_DOUBLE_CLICK_LEFT = 0x14
    static let INPUT_LONG_PRESS_LEFT = 0x15
    static let INPUT_TOUCH_PRESS_LEFT = 0x16
    static let INPUT_TOUCH_RELEASE_LEFT = 0x17

    // app state report phases
    static let STATE_ENTER = 0x01
    static let STATE_EXIT = 0x03

    // app ids
    static let APP_ID_DASHBOARD = 0x00
    static let APP_ID_NAV = 0x01
    static let APP_ID_ASR_NOTE = 0x04
    static let APP_ID_PROMPTER = 0x06
    static let APP_ID_AI_TALK = 0x07

    /// enterApp modes
    static let APP_MODE_STANDALONE = 0x00

    // widget resTypes
    static let WIDGET_TEXT_NEW = 0x00
    static let WIDGET_PICTURE = 0x80

    // navigation widget resIds (appId 0x01): mini map 0x00, arrow 0x01, turn text 0x02,
    // status bar 0x03 (raw), tip 0x04, large map 0x05.
    static let NAV_RES_MINI_MAP = 0x00
    static let NAV_RES_TURN_TEXT = 0x02
    static let NAV_RES_LARGE_MAP = 0x05

    // navigation image widget sizes (hard firmware requirements; see IMAGE_PROTOCOL).
    static let NAV_MINI_MAP_SIZE = 160
    static let NAV_LARGE_MAP_WIDTH = 452
    static let NAV_LARGE_MAP_HEIGHT = 170

    /// phone types
    static let PHONE_TYPE_IOS = 0x01

    // image header
    static let COM_IMAGE_HEADER: UInt8 = 0x16
    static let FORMAT_2BPP = 0x02
    static let COMPRESSION_NONE = 0x00
    static let COMPRESSION_ZLIB = 0x07

    static let MAX_BRIGHTNESS_LEVEL = 16
}

// MARK: - CRC16-CCITT

/// CRC-16/CCITT-FALSE: init 0xFFFF, poly 0x1021, no reflection, no final XOR.
/// Computed over the application payload (app header + data), NOT the transport header.
func nimoCrc16(_ data: Data) -> UInt16 {
    var crc: UInt16 = 0xFFFF
    for byte in data {
        crc ^= UInt16(byte) << 8
        for _ in 0 ..< 8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021
            } else {
                crc = crc << 1
            }
        }
    }
    return crc
}

// MARK: - Frame Codec

/// Pure bytes-in/bytes-out frame codec for the Nimo 0xBF transport.
///
/// Frame layout (little-endian):
/// - 8-byte transport header: [magic][status][len(2)][crc16(2)][index(2)]
/// - 4-byte application header (requests): [cmd][key][len(2)]
/// - responses/reports carry an extra status byte: [cmd][key][len(2)][status][data...]
enum NimoFrameCodec {
    static func transportHeader(_ payload: Data, index: Int = 0, needsAck: Bool = true) -> Data {
        var header = Data(count: 8)
        header[0] = NimoProtocol.FRAME_MAGIC
        header[1] = needsAck ? NimoProtocol.STATUS_ACK : 0
        header[2] = UInt8(payload.count & 0xFF)
        header[3] = UInt8((payload.count >> 8) & 0xFF)
        let crc = nimoCrc16(payload)
        header[4] = UInt8(crc & 0xFF)
        header[5] = UInt8((crc >> 8) & 0xFF)
        header[6] = UInt8(index & 0xFF)
        header[7] = UInt8((index >> 8) & 0xFF)
        return header
    }

    static func applicationHeader(cmd: Int, key: Int, payloadSize: Int) -> Data {
        return Data([
            UInt8(cmd & 0xFF),
            UInt8(key & 0xFF),
            UInt8(payloadSize & 0xFF),
            UInt8((payloadSize >> 8) & 0xFF),
        ])
    }

    /// One complete single frame: transport header + app header + payload.
    static func encodeFrame(
        cmd: Int, key: Int, payload: Data = Data(), index: Int = 0, needsAck: Bool = true
    ) -> Data {
        let transportPayload = applicationHeader(cmd: cmd, key: key, payloadSize: payload.count) + payload
        return transportHeader(transportPayload, index: index, needsAck: needsAck) + transportPayload
    }

    /// Content update (cmd=0x07 key=0x04) blind-sliced into 501-byte chunks, each wrapped in its
    /// own transport header. Index rule: last chunk = 0, others = i+1 (first = 1); single chunk = 0.
    static func updateContentFrames(
        appId: Int, layoutId: Int, resId: Int, resType: Int, content: Data,
        chunkSize: Int = NimoBLE.CHUNK_SIZE
    ) -> [Data] {
        // App header payloadSize includes the 4-byte [appId][layoutId][resId][resType] prefix.
        let appHeader = applicationHeader(
            cmd: NimoProtocol.CMD_CONTROL_INSTRUCTION,
            key: NimoProtocol.CTRL_UPDATE_CONTENT,
            payloadSize: 4 + content.count
        )
        var full = appHeader
        full.append(contentsOf: [
            UInt8(appId & 0xFF), UInt8(layoutId & 0xFF), UInt8(resId & 0xFF), UInt8(resType & 0xFF),
        ])
        full.append(content)

        let chunkCount = (full.count + chunkSize - 1) / chunkSize
        var frames: [Data] = []
        for i in 0 ..< chunkCount {
            let start = i * chunkSize
            let end = min(start + chunkSize, full.count)
            let chunk = full.subdata(in: start ..< end)
            let isLast = i == chunkCount - 1
            let index = isLast ? 0 : i + 1
            frames.append(transportHeader(chunk, index: index) + chunk)
        }
        return frames
    }

    /// 15-byte image header. `originalSize` MUST be the uncompressed pixel byte count
    /// (the glasses use it to allocate the decompression buffer).
    static func imageHeader(
        width: Int, height: Int, formatBpp: Int, compression: Int, originalSize: Int,
        compressedSize: Int
    ) -> Data {
        var p = Data(count: 15)
        p[0] = NimoProtocol.COM_IMAGE_HEADER
        p[1] = UInt8(width & 0xFF)
        p[2] = UInt8((width >> 8) & 0xFF)
        p[3] = UInt8(height & 0xFF)
        p[4] = UInt8((height >> 8) & 0xFF)
        p[5] = UInt8(formatBpp & 0xFF)
        p[6] = UInt8(compression & 0xFF)
        p[7] = UInt8(originalSize & 0xFF)
        p[8] = UInt8((originalSize >> 8) & 0xFF)
        p[9] = UInt8((originalSize >> 16) & 0xFF)
        p[10] = UInt8((originalSize >> 24) & 0xFF)
        p[11] = UInt8(compressedSize & 0xFF)
        p[12] = UInt8((compressedSize >> 8) & 0xFF)
        p[13] = UInt8((compressedSize >> 16) & 0xFF)
        p[14] = UInt8((compressedSize >> 24) & 0xFF)
        return p
    }

    /// 9-byte device time: [year(2 LE)][month][day][hour][min][sec][week][zone]
    /// week: Sunday=0..Saturday=6; zone: signed, 15-minute units, clamped to ±48.
    static func encodeDeviceTime(_ date: Date = Date()) -> Data {
        let cal = Calendar.current
        let c = cal.dateComponents(
            [.year, .month, .day, .hour, .minute, .second, .weekday], from: date
        )
        var b = Data(count: 9)
        let year = c.year ?? 2000
        b[0] = UInt8(year & 0xFF)
        b[1] = UInt8((year >> 8) & 0xFF)
        b[2] = UInt8((c.month ?? 1) & 0xFF)
        b[3] = UInt8((c.day ?? 1) & 0xFF)
        b[4] = UInt8((c.hour ?? 0) & 0xFF)
        b[5] = UInt8((c.minute ?? 0) & 0xFF)
        b[6] = UInt8((c.second ?? 0) & 0xFF)
        // Calendar weekday: Sunday=1..Saturday=7 → protocol Sunday=0..Saturday=6
        b[7] = UInt8(((c.weekday ?? 1) - 1) & 0xFF)
        let offsetMinutes = TimeZone.current.secondsFromGMT(for: date) / 60
        let zone = max(-48, min(48, offsetMinutes / 15))
        b[8] = UInt8(bitPattern: Int8(zone))
        return b
    }

    /// A decoded frame. `cmd`/`key`/`statusCode`/`data` are nil when the payload is too short.
    struct DecodedFrame {
        let transportStatus: UInt8
        let index: Int
        let cmd: Int?
        let key: Int?
        let statusCode: Int?
        let data: Data?
    }

    /// Decodes one complete frame (responses and reports both use the 5-byte
    /// [cmd][key][len(2)][status] application header). Returns nil on transport
    /// error, bad CRC, or truncation.
    static func decode(_ frame: Data) -> DecodedFrame? {
        guard frame.count >= 8, frame[0] == NimoProtocol.FRAME_MAGIC else { return nil }
        let transportStatus = frame[1]
        let payloadLen = Int(frame[2]) | (Int(frame[3]) << 8)
        let crcValue = UInt16(frame[4]) | (UInt16(frame[5]) << 8)
        let index = Int(frame[6]) | (Int(frame[7]) << 8)
        guard frame.count >= 8 + payloadLen else { return nil }
        guard transportStatus & NimoProtocol.STATUS_ERR == 0 else { return nil }

        let payload = frame.subdata(in: 8 ..< 8 + payloadLen)
        guard nimoCrc16(payload) == crcValue else { return nil }

        guard payload.count >= 5 else {
            return DecodedFrame(
                transportStatus: transportStatus, index: index, cmd: nil, key: nil,
                statusCode: nil, data: nil
            )
        }
        let data = payload.count > 5 ? payload.subdata(in: 5 ..< payload.count) : Data()
        return DecodedFrame(
            transportStatus: transportStatus,
            index: index,
            cmd: Int(payload[0]),
            key: Int(payload[1]),
            statusCode: Int(payload[4]),
            data: data
        )
    }
}

// MARK: - Receive Assembler

/// Reassembles multi-packet responses. Fragments are grouped by (cmd,key); each fragment carries
/// the full 5-byte response app header. The first fragment (index==1) keeps its header, the
/// continuation fragments (index>1) and the last fragment (index==0) contribute only their data
/// sections, concatenated in ascending index order with the last (0) treated as largest. The
/// merged message is re-framed (lengths and CRC recomputed) so `NimoFrameCodec.decode` can parse
/// it. Single packets (index==0, no cached group) pass through unchanged.
class NimoReceiveAssembler {
    private class Pending {
        var firstAppPayload: Data?
        var dataByIndex: [Int: Data] = [:]
        let startTime = Date()
    }

    private var pending: [Int: Pending] = [:]

    func ingest(_ packet: Data) -> [Data] {
        guard packet.count >= 8 else { return [] }
        let payloadLen = Int(packet[2]) | (Int(packet[3]) << 8)
        let index = Int(packet[6]) | (Int(packet[7]) << 8)
        guard packet.count >= 8 + payloadLen else { return [] }
        let appPayload = packet.subdata(in: 8 ..< 8 + payloadLen)

        guard appPayload.count >= 2 else {
            return index == 0 ? [packet] : []
        }

        let cmd = Int(appPayload[0])
        let key = Int(appPayload[1])
        let groupKey = (cmd << 8) | key

        if index == 0 {
            guard let p = pending.removeValue(forKey: groupKey) else { return [packet] }
            p.dataByIndex[Int.max] = dataSection(appPayload)
            return [reframe(p)]
        }

        if index == 1 {
            // A new first fragment while an old first fragment is cached means the previous
            // round lost its last packet — drop the stale group and start over.
            if let existing = pending[groupKey], existing.firstAppPayload != nil {
                pending.removeValue(forKey: groupKey)
            }
        }

        let p = pending[groupKey] ?? Pending()
        pending[groupKey] = p
        if index == 1 {
            p.firstAppPayload = appPayload
        }
        p.dataByIndex[index] = dataSection(appPayload)
        return []
    }

    func cleanup(timeoutSeconds: TimeInterval = 10) {
        let now = Date()
        pending = pending.filter { now.timeIntervalSince($0.value.startTime) < timeoutSeconds }
    }

    func reset() {
        pending.removeAll()
    }

    private func dataSection(_ appPayload: Data) -> Data {
        return appPayload.count <= 5 ? Data() : appPayload.subdata(in: 5 ..< appPayload.count)
    }

    private func reframe(_ p: Pending) -> Data {
        var merged = Data()
        for k in p.dataByIndex.keys.sorted() {
            merged.append(p.dataByIndex[k]!)
        }
        let first = p.firstAppPayload
        let cmd: UInt8 = (first?.count ?? 0) >= 1 ? first![0] : 0
        let key: UInt8 = (first?.count ?? 0) >= 2 ? first![1] : 0
        let status: UInt8 = (first?.count ?? 0) >= 5 ? first![4] : 0

        var appPayload = Data([
            cmd, key, UInt8(merged.count & 0xFF), UInt8((merged.count >> 8) & 0xFF), status,
        ])
        appPayload.append(merged)
        return NimoFrameCodec.transportHeader(appPayload, index: 0) + appPayload
    }
}

// MARK: - Mic Audio Parser

/// H-T-L-V parser for the mic channel (char 2025). Packets: [0x52][type][len(2 LE)][payload].
/// For Opus packets the payload is [SN(2 LE)][frameCnt][reserved] then frameCnt frames of
/// [frameLen(1)][body] where opusLen = body[3] and the Opus bytes are body[8 .. 8+opusLen].
/// Slicing by opusLen (not frameLen-8) is mandatory — the tail holds CRC/padding bytes.
enum NimoAudioParser {
    static let HEADER: UInt8 = 0x52
    static let TYPE_STOP = 0x00
    static let TYPE_START = 0x01
    static let TYPE_OPUS_LEFT = 0x02
    static let TYPE_OPUS_RIGHT = 0x03

    struct Packet {
        let type: Int
        let sequence: Int
        let opusFrames: [Data]
    }

    static func parse(_ data: Data) -> Packet? {
        guard data.count >= 4, data[0] == HEADER else { return nil }
        let type = Int(data[1])
        let len = Int(data[2]) | (Int(data[3]) << 8)
        guard data.count >= 4 + len else { return Packet(type: type, sequence: 0, opusFrames: []) }
        guard type == TYPE_OPUS_LEFT || type == TYPE_OPUS_RIGHT else {
            return Packet(type: type, sequence: 0, opusFrames: [])
        }

        let payload = data.subdata(in: 4 ..< 4 + len)
        guard payload.count >= 4 else { return Packet(type: type, sequence: 0, opusFrames: []) }
        let sn = Int(payload[0]) | (Int(payload[1]) << 8)
        let frameCnt = Int(payload[2])
        var offset = 4
        var frames: [Data] = []
        var i = 0
        while i < frameCnt, offset < payload.count {
            let frameLen = Int(payload[offset])
            offset += 1
            guard offset + frameLen <= payload.count else { break }
            let body = payload.subdata(in: offset ..< offset + frameLen)
            offset += frameLen
            i += 1
            if frameLen < 8 { continue }
            let opusLen = Int(body[3])
            if 8 + opusLen > frameLen { continue }
            frames.append(body.subdata(in: 8 ..< 8 + opusLen))
        }
        return Packet(type: type, sequence: sn, opusFrames: frames)
    }
}

// MARK: - Opus Decoder (AVAudioConverter)

/// Decodes the glasses' 16 kHz mono Opus frames to 16-bit PCM via the system
/// Opus decoder, so no native Opus library has to be vendored.
private class NimoOpusDecoder {
    private let opusFormat: AVAudioFormat
    private let pcmFormat: AVAudioFormat
    private var converter: AVAudioConverter?

    init?() {
        var desc = AudioStreamBasicDescription(
            mSampleRate: 16000,
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 320, // 20 ms at 16 kHz
            mBytesPerFrame: 0,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 0,
            mReserved: 0
        )
        guard let inFormat = AVAudioFormat(streamDescription: &desc),
              let outFormat = AVAudioFormat(
                  commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true
              )
        else { return nil }
        opusFormat = inFormat
        pcmFormat = outFormat
        converter = AVAudioConverter(from: inFormat, to: outFormat)
        if converter == nil {
            return nil
        }
    }

    func decode(_ opusFrame: Data) -> Data? {
        guard let converter, !opusFrame.isEmpty else { return nil }

        let compressed = AVAudioCompressedBuffer(
            format: opusFormat, packetCapacity: 1, maximumPacketSize: opusFrame.count
        )
        opusFrame.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            compressed.data.copyMemory(from: raw.baseAddress!, byteCount: opusFrame.count)
        }
        compressed.byteLength = UInt32(opusFrame.count)
        compressed.packetCount = 1
        compressed.packetDescriptions?.pointee = AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(opusFrame.count)
        )

        // Up to 40 ms of output per frame, to be safe.
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: 640) else {
            return nil
        }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: pcmBuffer, error: &error) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return compressed
        }
        if status == .error {
            Bridge.log("NIMO: Opus decode error: \(error?.localizedDescription ?? "unknown")")
            return nil
        }
        guard pcmBuffer.frameLength > 0, let channel = pcmBuffer.int16ChannelData else {
            return nil
        }
        return Data(bytes: channel[0], count: Int(pcmBuffer.frameLength) * 2)
    }
}

// MARK: - Reconnection Manager

actor NimoReconnectionManager {
    private var task: Task<Void, Never>?
    private let intervalSeconds: UInt64

    init(intervalSeconds: UInt64 = 30) {
        self.intervalSeconds = intervalSeconds
    }

    func start(_ onAttempt: @escaping () async -> Bool) {
        stop()
        task = Task {
            var attempts = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: intervalSeconds * 1_000_000_000)
                if Task.isCancelled { return }
                attempts += 1
                Bridge.log("NIMO: Reconnection attempt \(attempts)")
                if await onAttempt() {
                    Bridge.log("NIMO: Reconnection successful, stopping")
                    return
                }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}

// MARK: - Nimo Class

class Nimo: NSObject, SGCManager {
    var type: String = DeviceTypes.NIMO
    let hasMic = true
    let showBrightnessConfirmation = false
    let showConnectionConfirmation = false
    let sceneHandoffRequiresClear = false

    private static let _bluetoothQueue = DispatchQueue(label: "BluetoothNimo", qos: .userInitiated)

    private enum Const {
        static let twsTimeoutSeconds: TimeInterval = 10
        static let ackTimeoutSeconds: TimeInterval = 5
        static let pairingTimeoutSeconds: TimeInterval = 15
        static let batteryPollSeconds: TimeInterval = 30
        /// Fall back to the other ear if the preferred one goes quiet for this long.
        static let micSideFallbackSeconds: TimeInterval = 2
    }

    // BLE
    private var centralManager: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var txChar: CBCharacteristic?
    private var rxChar: CBCharacteristic?
    private var micChar: CBCharacteristic?
    private var otaTxChar: CBCharacteristic?
    private var otaRxChar: CBCharacteristic?
    private var firmwareConnectionGeneration = 0
    private var nimoFirmwareUpdater: NimoFirmwareUpdater?
    private var otaTrafficPaused = false
    private var otaPrepareGeneration = 0
    private var otaPrepareCompletion: ((Error?) -> Void)?
    private var pendingOtaWrite: (Data, (Error?) -> Void)?
    private var pendingFirmwareInventory: ((Result<NimoOtaManager.Inventory, Error>) -> Void)?
    private var inventoryPackedReceived = false
    private var inventoryDetailReceived = false
    private var inventoryQueryGeneration = 0

    var firmwareUpdater: FirmwareUpdater? {
        guard let id = peripheral?.identifier.uuidString ?? lastDeviceUUID, !id.isEmpty else { return nil }
        if nimoFirmwareUpdater == nil {
            nimoFirmwareUpdater = NimoFirmwareUpdater(deviceId: id, connectionGeneration: firmwareConnectionGeneration, ports: .init(
                connection: { [weak self] in self?.otaConnection() },
                prepare: { [weak self] callback in self?.prepareOtaChannel(callback) },
                release: { [weak self] in self?.releaseOtaChannel() },
                write: { [weak self] data, callback in self?.writeOta(data, completion: callback) },
                readInventory: { [weak self] callback in self?.readOtaInventory(callback) },
                schedule: Self.scheduler(.main), now: { ProcessInfo.processInfo.systemUptime }
            ))
        }
        return nimoFirmwareUpdater
    }

    var firmwareUpdateOwnsDevice: Bool {
        firmwareOwnsDevice
    }

    private var firmwareOwnsDevice: Bool {
        nimoFirmwareUpdater?.snapshot.safeToRelease == false
    }

    private var isDisconnecting = false

    /// Device search
    private var DEVICE_SEARCH_ID = "NOT_SET"

    private var lastDeviceName: String? {
        get { UserDefaults.standard.string(forKey: "nimo_lastDeviceName") }
        set { UserDefaults.standard.set(newValue, forKey: "nimo_lastDeviceName") }
    }

    private var lastDeviceUUID: String? {
        get { UserDefaults.standard.string(forKey: "nimo_lastDeviceUUID") }
        set { UserDefaults.standard.set(newValue, forKey: "nimo_lastDeviceUUID") }
    }

    private let reconnectionManager = NimoReconnectionManager()
    private let receiveAssembler = NimoReceiveAssembler()

    /// Handshake
    private enum HandshakeState {
        case idle
        case awaitingTws
        case awaitingTimeAck
        case ready
    }

    private var handshakeState = HandshakeState.idle
    private var twsConnected = false
    private var peerCompanionReady: Bool?
    private var setTimeAttempts = 0
    private var twsTimeoutItem: DispatchWorkItem?
    private var pairingTimeoutItem: DispatchWorkItem?

    /// Pending acks keyed by (cmd << 8) | key
    private struct PendingAck {
        let onResult: (Bool) -> Void
        let timeoutItem: DispatchWorkItem
    }

    private var pendingAcks: [Int: PendingAck] = [:]

    private static func scheduler(_ queue: DispatchQueue) -> NimoScheduler {
        { delay, task in
            let item = DispatchWorkItem(block: task)
            queue.asyncAfter(deadline: .now() + delay, execute: item)
            return { item.cancel() }
        }
    }

    private let encoderQueue = DispatchQueue(label: "NimoCanvasEncoder", qos: .userInitiated)
    private lazy var canvasEncoder = NimoCanvasEncoder(
        main: Self.scheduler(.main), worker: Self.scheduler(encoderQueue),
        failure: { Bridge.log("NIMO: canvas encoding failed; retaining last valid scene: \($0)") }
    )
    private lazy var writes = NimoWriteQueue<CBCharacteristic>(
        schedule: Self.scheduler(.main), write: { [weak self] characteristic, bytes in
            guard let self, let peripheral = self.peripheral, peripheral.state == .connected,
                  bytes.count <= peripheral.maximumWriteValueLength(for: .withResponse) else { return false }
            peripheral.writeValue(bytes, for: characteristic, type: .withResponse)
            return true
        }, failure: { [weak self] in self?.abortTransport($0) }
    )
    private lazy var canvas = NimoCanvasCoordinator(
        schedule: Self.scheduler(.main),
        writeCapacity: { [weak self] in min(512, self?.peripheral?.maximumWriteValueLength(for: .withResponse) ?? 20) },
        enqueue: { [weak self] frames, started, completed in
            self?.enqueueFrames(frames, finalStarted: started, completed: completed) ?? false
        }, reconnect: { [weak self] in self?.abortTransport($0) },
        rejected: { Bridge.log("NIMO: canvas rejected status=\($0); not a render ACK") }
    )
    private var batteryPollTimer: Timer?

    // Battery
    private var lastBatteryLevel = -1
    private var lastCharging = false

    // Version info
    private var firmwareVersionPacked = ""
    private var firmwareVersionDetail = ""

    // Mic audio
    private var opusDecoder: NimoOpusDecoder?
    private var lastRightPacketTime = Date.distantPast
    private var preferRightMic = true

    // MARK: - SGCManager: Connection Management

    func findCompatibleDevices() {
        guard !firmwareOwnsDevice else { return }
        Bridge.log("NIMO: findCompatibleDevices()")
        DEVICE_SEARCH_ID = "NOT_SET"
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.SCANNING)
        startScan()
    }

    func connectById(_ id: String) {
        guard !firmwareOwnsDevice else { return }
        Bridge.log("NIMO: connectById(\(id))")
        DEVICE_SEARCH_ID = id
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        isDisconnecting = false
        startPairingTimeout()
        startScan()
    }

    func stopScan() {
        centralManager?.stopScan()
    }

    func disconnect() {
        guard !firmwareOwnsDevice else { Bridge.log("NIMO: firmware update owns the connection"); return }
        Bridge.log("NIMO: disconnect()")
        isDisconnecting = true
        cancelPairingTimeout()
        cancelTwsTimeout()
        stopScan()
        stopTimers()
        Task { await reconnectionManager.stop() }
        failAllPendingAcks()

        if let peripheral {
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        peripheral = nil
        txChar = nil
        rxChar = nil
        micChar = nil
        resetSessionState()

        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
    }

    func forget() {
        guard !firmwareOwnsDevice else { return }
        Bridge.log("NIMO: forget()")
        disconnect()
        lastDeviceName = nil
        lastDeviceUUID = nil
        DEVICE_SEARCH_ID = "NOT_SET"
    }

    func cleanup() {
        guard !firmwareOwnsDevice else { return }
        disconnect()
        opusDecoder = nil
    }

    func getConnectedBluetoothName() -> String? {
        return peripheral?.name
    }

    func ping() {
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_GET_PARAMETER, key: NimoProtocol.GET_TWS_STATUS
            )
        )
    }

    func dbg1() {}
    func dbg2() {}
    func connectController() {}
    func disconnectController() {}

    // MARK: - SGCManager: Audio Control

    func setMicEnabled(_ enabled: Bool) {
        guard !otaTrafficPaused, !firmwareOwnsDevice else { return }
        Bridge.log("NIMO: setMicEnabled(\(enabled))")
        guard let micChar else {
            Bridge.log("NIMO: mic characteristic not available")
            return
        }
        DeviceStore.shared.apply("glasses", "micEnabled", enabled)
        if enabled {
            if opusDecoder == nil {
                opusDecoder = NimoOpusDecoder()
                if opusDecoder == nil {
                    Bridge.log("NIMO: system Opus decoder unavailable — glasses mic disabled")
                }
            }
            enqueueWrite(micChar, Data([0x52, 0x01, 0x00, 0x00]))
        } else {
            enqueueWrite(micChar, Data([0x52, 0x00, 0x00, 0x00]))
        }
    }

    func sortMicRanking(list: [String]) -> [String] {
        return list
    }

    // MARK: - SGCManager: Messaging

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {
        Bridge.log("NIMO: sendJson - not supported")
    }

    // MARK: - SGCManager: Display Control

    func setBrightness(_ level: Int, autoMode: Bool) {
        Bridge.log("NIMO: setBrightness(\(level), auto=\(autoMode))")
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_SET_PARAMETER,
                key: NimoProtocol.SET_AUTO_BRIGHTNESS,
                payload: Data([autoMode ? 1 : 0])
            )
        )
        if !autoMode {
            // The firmware takes a 0–16 level, not a 0–100 percent.
            let clamped = max(0, min(100, level))
            let lvl = Int((Double(clamped) / 100.0 * Double(NimoProtocol.MAX_BRIGHTNESS_LEVEL)).rounded())
            sendFrame(
                NimoFrameCodec.encodeFrame(
                    cmd: NimoProtocol.CMD_SET_PARAMETER,
                    key: NimoProtocol.SET_BRIGHTNESS,
                    payload: Data([UInt8(lvl)])
                )
            )
        }
    }

    func clearDisplay() {
        encodeCanvas(scope: "legacy") { try NimoCanvasCodec.replace([]) }
    }

    func sendText(_ text: String) async {
        await sendTextWall(text)
    }

    func sendTextWall(_ text: String) async {
        encodeCanvas(scope: "legacy") {
            try NimoCanvasCodec.replace(NimoCanvasCodec.text(text, 0, 0, 500, 220, border: 0, radius: 0))
        }
    }

    func sendDoubleTextWall(_ top: String, _ bottom: String) async {
        await sendTextWall(top + "\n\n" + bottom)
    }

    func sendPositionedText(_ text: String, x: Int32, y: Int32, width: Int32, height: Int32,
                            borderWidth: Int32, borderRadius: Int32) async
    {
        encodeCanvas(scope: "legacy") {
            try NimoCanvasCodec.replace(NimoCanvasCodec.text(text, Int(x), Int(y), Int(width), Int(height),
                                                             border: Int(borderWidth), radius: Int(borderRadius)))
        }
    }

    func displayBitmap(base64ImageData: String, x: Int32?, y: Int32?, width: Int32?, height: Int32?) async -> Bool {
        do {
            let left = Int(x ?? 0), top = Int(y ?? 0)
            let w = width.map(Int.init) ?? (NimoCanvasCodec.width - left)
            let h = height.map(Int.init) ?? (NimoCanvasCodec.height - top)
            try NimoCanvasCodec.region(left, top, w, h)
            // True acknowledges bounded local validation, never visible rendering.
            let source = try NimoCanvasImage.source(base64ImageData)
            encodeCanvas(scope: "legacy") {
                try NimoCanvasCodec.replace([NimoCanvasCodec.bitmap(left, top, w, h,
                                                                    gray: NimoCanvasImage.grayscale(source, width: w, height: h))])
            }
            return true
        } catch {
            Bridge.log("NIMO: displayBitmap failed: \(error)")
            return false
        }
    }

    func applySceneFrame(_ frame: SceneFrame) async {
        encodeCanvas(scope: "\(frame.appId):\(frame.epoch)", force: frame.replay) {
            try NimoCanvasCodec.scene(frame.elements) { try NimoCanvasImage.decode($0, width: $1, height: $2) }
        }
    }

    func clearSceneElements(_: [String]) async {
        clearDisplay()
    }

    private func encodeCanvas(scope: String, force: Bool = false, encode: @escaping () throws -> Data) {
        canvasEncoder.submit(encode: encode) { [weak self] bytes in
            self?.canvas.offer(bytes, scope: scope, force: force)
        }
    }

    func showDashboard() {
        exit()
    }

    func setDashboardPosition(_ height: Int, _ depth: Int) {
        Bridge.log("NIMO: setDashboardPosition(\(height), \(depth))")
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_SET_PARAMETER,
                key: NimoProtocol.SET_HEIGHT_LEVEL,
                payload: Data([UInt8(max(0, min(10, height)))])
            )
        )
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_SET_PARAMETER,
                key: NimoProtocol.SET_DISTANCE,
                payload: Data([UInt8(max(0, min(10, depth)))])
            )
        )
    }

    // MARK: - SGCManager: Device Control

    func setHeadUpAngle(_ angle: Int) {
        let clamped = max(0, min(90, angle))
        Bridge.log("NIMO: setHeadUpAngle(\(clamped))")
        // Enable the head-up display gesture, then set the wake angle.
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_SET_PARAMETER,
                key: NimoProtocol.SET_HEADUP_DISPLAY,
                payload: Data([1])
            )
        )
        // setAngle payload is [optType, deg]. TODO: hardware-verify optType semantics.
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_SET_PARAMETER,
                key: NimoProtocol.SET_ANGLE,
                payload: Data([0x01, UInt8(clamped)])
            )
        )
    }

    func getBatteryStatus() {
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_GET_PARAMETER, key: NimoProtocol.GET_BATTERY
            )
        )
    }

    func setSilentMode(_ enabled: Bool) {
        Bridge.log("NIMO: setSilentMode(\(enabled))")
        // TODO: hardware-verify that display-off matches MentraOS silent-mode semantics.
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_SET_PARAMETER,
                key: NimoProtocol.SET_DISPLAY_OFF,
                payload: Data([enabled ? 1 : 0])
            )
        )
    }

    func exit() {
        canvasEncoder.invalidate()
        canvas.exit()
    }

    func sendShutdown() {
        Bridge.log("NIMO: sendShutdown - not supported")
    }

    func sendReboot() {
        Bridge.log("NIMO: sendReboot - not supported")
    }

    func sendRgbLedControl(
        requestId: String, packageName _: String?, action _: String, color _: String?,
        onDurationMs _: Int, offDurationMs _: Int, count _: Int
    ) {
        Bridge.sendRgbLedControlResponse(requestId: requestId, success: false, error: "device_not_supported")
    }

    // MARK: - Notifications

    /// Pushes a notification (cmd=0x09 key=0x01, fixed 319-byte struct:
    /// appId(1) + title(51, UTF-8 zero-padded) + time(9) + contentLen(2 LE) + content(256)).
    func sendNotification(notificationAppId: Int, title: String, content: String) {
        var payload = Data(count: 319)
        payload[0] = UInt8(max(0, min(255, notificationAppId)))
        writeUtf8Padded(&payload, offset: 1, text: title, maxLen: 51)
        let time = NimoFrameCodec.encodeDeviceTime()
        payload.replaceSubrange(52 ..< 61, with: time)
        let contentBytes = Data(content.utf8)
        let clen = min(contentBytes.count, 256)
        payload[61] = UInt8(clen & 0xFF)
        payload[62] = UInt8((clen >> 8) & 0xFF)
        writeUtf8Padded(&payload, offset: 63, text: content, maxLen: 256)
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_CONTROL_NOTIFICATION,
                key: NimoProtocol.NOTIFICATION_SEND,
                payload: payload
            )
        )
    }

    private func writeUtf8Padded(_ dest: inout Data, offset: Int, text: String, maxLen: Int) {
        var bytes = Data(text.utf8)
        if bytes.count > maxLen {
            // Truncate on a UTF-8 boundary
            var end = maxLen
            while end > 0, bytes[end] & 0xC0 == 0x80 {
                end -= 1
            }
            bytes = bytes.subdata(in: 0 ..< end)
        }
        dest.replaceSubrange(offset ..< offset + bytes.count, with: bytes)
    }

    // MARK: - SGCManager: Camera & Media (no camera)

    func requestPhoto(
        _: String, appId _: String, size _: String?, webhookUrl _: String?, authToken _: String?,
        compress _: String?, flash _: Bool, save _: Bool, sound _: Bool, exposureTimeNs _: Double?,
        iso _: Int?
    ) {
        Bridge.log("NIMO: requestPhoto - not supported (no camera)")
    }

    func requestPhoto(_: PhotoRequest) {
        Bridge.log("NIMO: requestPhoto(PhotoRequest) - not supported (no camera)")
    }

    func startStream(_: [String: Any]) {
        Bridge.log("NIMO: startStream - not supported")
    }

    func stopStream() {
        Bridge.log("NIMO: stopStream - not supported")
    }

    func sendStreamKeepAlive(_: [String: Any]) {}

    func startVideoRecording(requestId _: String, save _: Bool, sound _: Bool) {
        Bridge.log("NIMO: startVideoRecording - not supported")
    }

    func stopVideoRecording(requestId _: String) {
        Bridge.log("NIMO: stopVideoRecording - not supported")
    }

    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendButtonMaxRecordingTime() {}
    func sendButtonCameraLedSetting() {}
    func sendCameraFovSetting() {}

    // MARK: - SGCManager: Network (no WiFi)

    func requestWifiScan(scanId _: String?) {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
    func sendOtaStart(otaVersionUrl _: String?) {}
    func sendOtaQueryStatus() {}

    // MARK: - SGCManager: User Context / Gallery / Version

    func sendUserEmailToGlasses(_: String) {}
    func sendIncidentId(_: String, apiBaseUrl _: String?) {}
    func queryGalleryStatus() {}
    func sendGalleryMode() {}

    func requestVersionInfo() {
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_GET_PARAMETER, key: NimoProtocol.GET_VERSION
            )
        )
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_GET_PARAMETER, key: NimoProtocol.GET_VERSION_DETAIL
            )
        )
    }

    // MARK: - BLE Scanning

    private func isNimoMainDevice(_ name: String) -> Bool {
        let lower = name.lowercased()
        return lower.hasPrefix(NimoBLE.NAME_PREFIX) && !lower.hasSuffix(NimoBLE.BLE_NAME_SUFFIX)
    }

    @discardableResult
    private func startScan() -> Bool {
        Bridge.log("NIMO: startScan()")
        if centralManager == nil {
            centralManager = CBCentralManager(
                delegate: self, queue: Nimo._bluetoothQueue,
                options: [CBCentralManagerOptionShowPowerAlertKey: 0]
            )
        }
        guard centralManager!.state == .poweredOn else {
            // centralManagerDidUpdateState retries the scan once the radio is on.
            Bridge.log("NIMO: Bluetooth not powered on yet")
            return false
        }

        // Fast path: reconnect to the cached peripheral UUID.
        if connectByUUID() {
            return true
        }

        centralManager!.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
        return true
    }

    private func connectByUUID() -> Bool {
        guard DEVICE_SEARCH_ID != "NOT_SET", !DEVICE_SEARCH_ID.isEmpty else { return false }
        guard lastDeviceName == DEVICE_SEARCH_ID,
              let uuidString = lastDeviceUUID,
              let uuid = UUID(uuidString: uuidString)
        else { return false }
        guard let known = centralManager?.retrievePeripherals(withIdentifiers: [uuid]).first
        else { return false }

        Bridge.log("NIMO: connectByUUID - \(known.name ?? uuidString)")
        peripheral = known
        known.delegate = self
        centralManager?.connect(known, options: nil)
        return true
    }

    private func startPairingTimeout() {
        cancelPairingTimeout()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if !self.fullyBooted {
                Bridge.log("NIMO: pairing timeout — handshake never completed")
                Bridge.sendPairFailureEvent("errors:pairNeedDisconnect")
            }
        }
        pairingTimeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Const.pairingTimeoutSeconds, execute: item)
    }

    private func cancelPairingTimeout() {
        pairingTimeoutItem?.cancel()
        pairingTimeoutItem = nil
    }

    // MARK: - Write Queue

    private func enqueueWrite(_ characteristic: CBCharacteristic, _ bytes: Data) {
        guard !otaTrafficPaused, !firmwareOwnsDevice else { return }
        guard let peripheral else { return }
        writes.enqueue(peripheral, characteristic: characteristic, frames: [bytes])
    }

    private func sendFrame(_ frame: Data) {
        guard let txChar else { return }
        enqueueWrite(txChar, frame)
    }

    private func enqueueFrames(_ frames: [Data], finalStarted: @escaping () -> Void,
                               completed: @escaping () -> Void) -> Bool
    {
        guard !otaTrafficPaused, !firmwareOwnsDevice, let peripheral, let txChar else { return false }
        return writes.enqueue(peripheral, characteristic: txChar, frames: frames,
                              finalStarted: finalStarted, completed: completed)
    }

    private func abortTransport(_ reason: String) {
        Bridge.log("NIMO: retiring transport: \(reason)")
        resetSessionState()
        if let peripheral { centralManager?.cancelPeripheralConnection(peripheral) }
    }

    // MARK: - Device-owned OTA transport

    private func otaConnection() -> NimoFirmwareUpdater.Connection? {
        guard let peripheral, peripheral.state == .connected,
              otaTxChar?.properties.contains(.writeWithoutResponse) == true, otaRxChar != nil else { return nil }
        return .init(deviceId: peripheral.identifier.uuidString, generation: firmwareConnectionGeneration,
                     writeCapacity: min(512, peripheral.maximumWriteValueLength(for: .withoutResponse)))
    }

    private func prepareOtaChannel(_ completion: @escaping (Error?) -> Void) {
        guard let peripheral, let rx = otaRxChar, otaConnection() != nil else {
            completion(FirmwareUpdaterError("transport", "NIMO OTA characteristics are unavailable")); return
        }
        otaPrepareGeneration += 1
        let expected = otaPrepareGeneration
        otaTrafficPaused = true
        stopTimers(); cancelPairingTimeout(); cancelTwsTimeout()
        handshakeState = .idle
        canvasEncoder.invalidate(); canvas.disconnected(); failAllPendingAcks()
        // Stop the microphone through the same write queue before reserving it exclusively for OTA.
        if let micChar {
            writes.enqueue(peripheral, characteristic: micChar, frames: [Data([0x52, 0, 0, 0])])
            DeviceStore.shared.apply("glasses", "micEnabled", false)
        }
        otaPrepareCompletion = completion
        waitForOtaQueue(peripheral, rx: rx, generation: expected)
    }

    private func waitForOtaQueue(_ expectedPeripheral: CBPeripheral, rx: CBCharacteristic, generation: Int) {
        guard otaTrafficPaused, otaPrepareGeneration == generation, otaPrepareCompletion != nil,
              peripheral === expectedPeripheral else { return }
        guard writes.isIdle else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [weak self] in
                self?.waitForOtaQueue(expectedPeripheral, rx: rx, generation: generation)
            }
            return
        }
        if rx.isNotifying {
            let completion = otaPrepareCompletion; otaPrepareCompletion = nil; completion?(nil)
        } else { expectedPeripheral.setNotifyValue(true, for: rx) }
    }

    private func releaseOtaChannel() {
        otaPrepareGeneration += 1
        otaPrepareCompletion = nil
        pendingOtaWrite = nil
        otaTrafficPaused = false
        // The provider publishes safeToRelease in this turn. Restore normal policy on the following turn.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.firmwareOwnsDevice, self.peripheral?.state == .connected else { return }
            self.startHandshake()
        }
    }

    private func writeOta(_ data: Data, completion: @escaping (Error?) -> Void) {
        guard otaTrafficPaused, pendingOtaWrite == nil, otaConnection() != nil else {
            completion(FirmwareUpdaterError("transport", "The NIMO OTA write channel is unavailable or busy")); return
        }
        pendingOtaWrite = (data, completion)
        drainOtaWrite()
    }

    private func drainOtaWrite() {
        guard otaTrafficPaused else { return }
        guard let pending = pendingOtaWrite, let peripheral, let tx = otaTxChar, peripheral.state == .connected else { return }
        guard peripheral.canSendWriteWithoutResponse else { return }
        guard pending.0.count <= peripheral.maximumWriteValueLength(for: .withoutResponse) else {
            pendingOtaWrite = nil
            pending.1(FirmwareUpdaterError("transport", "OTA packet exceeds CoreBluetooth write capacity")); return
        }
        pendingOtaWrite = nil
        peripheral.writeValue(pending.0, for: tx, type: .withoutResponse)
        pending.1(nil)
    }

    private func readOtaInventory(_ completion: @escaping (Result<NimoOtaManager.Inventory, Error>) -> Void) {
        guard let peripheral, let txChar, peripheral.state == .connected, pendingFirmwareInventory == nil else {
            completion(.failure(FirmwareUpdaterError("transport", "NIMO firmware inventory is unavailable or busy"))); return
        }
        inventoryPackedReceived = false; inventoryDetailReceived = false
        inventoryQueryGeneration += 1
        let query = inventoryQueryGeneration
        pendingFirmwareInventory = completion
        let generation = firmwareConnectionGeneration
        let frames = [NimoProtocol.GET_VERSION, NimoProtocol.GET_VERSION_DETAIL].map {
            NimoFrameCodec.encodeFrame(cmd: NimoProtocol.CMD_GET_PARAMETER, key: $0)
        }
        if !writes.enqueue(peripheral, characteristic: txChar, frames: frames) {
            pendingFirmwareInventory = nil
            completion(.failure(FirmwareUpdaterError("transport", "NIMO version query could not be queued")))
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, self.firmwareConnectionGeneration == generation, self.inventoryQueryGeneration == query,
                  let pending = self.pendingFirmwareInventory else { return }
            self.pendingFirmwareInventory = nil
            pending(.failure(FirmwareUpdaterError("timeout", "NIMO firmware inventory timed out")))
        }
    }

    private func resolveFirmwareInventory() {
        guard inventoryPackedReceived, inventoryDetailReceived else { return }
        let inventory = NimoOtaManager.Inventory(firmwareDetail: firmwareVersionDetail, packedVersion: firmwareVersionPacked)
        nimoFirmwareUpdater?.inventoryChanged(inventory, connectionGeneration: firmwareConnectionGeneration)
        guard let completion = pendingFirmwareInventory else { return }
        pendingFirmwareInventory = nil
        completion(.success(inventory))
    }

    private func failOtaChannel(_ message: String) {
        otaPrepareGeneration += 1
        let prepare = otaPrepareCompletion; otaPrepareCompletion = nil
        let write = pendingOtaWrite; pendingOtaWrite = nil
        let inventory = pendingFirmwareInventory; pendingFirmwareInventory = nil
        let error = FirmwareUpdaterError("transport", message)
        prepare?(error); write?.1(error); inventory?(.failure(error))
    }

    // MARK: - Pending ACKs

    private func sendAwaitingAck(
        cmd: Int, key: Int, payload: Data, onResult: @escaping (Bool) -> Void
    ) {
        let ackKey = (cmd << 8) | key
        // Only one in-flight ack per (cmd,key); fail any previous waiter.
        if let previous = pendingAcks.removeValue(forKey: ackKey) {
            previous.timeoutItem.cancel()
            previous.onResult(false)
        }
        let timeoutItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingAcks.removeValue(forKey: ackKey)?.onResult(false)
        }
        pendingAcks[ackKey] = PendingAck(onResult: onResult, timeoutItem: timeoutItem)
        DispatchQueue.main.asyncAfter(deadline: .now() + Const.ackTimeoutSeconds, execute: timeoutItem)
        sendFrame(NimoFrameCodec.encodeFrame(cmd: cmd, key: key, payload: payload, needsAck: true))
    }

    private func resolvePendingAck(cmd: Int, key: Int, success: Bool) {
        let ackKey = (cmd << 8) | key
        if let ack = pendingAcks.removeValue(forKey: ackKey) {
            ack.timeoutItem.cancel()
            ack.onResult(success)
        }
    }

    private func failAllPendingAcks() {
        let acks = pendingAcks.values
        pendingAcks.removeAll()
        for ack in acks {
            ack.timeoutItem.cancel()
            ack.onResult(false)
        }
    }

    // MARK: - Handshake

    private func startHandshake() {
        if firmwareOwnsDevice {
            cancelPairingTimeout()
            Task { await reconnectionManager.stop() }
            DeviceStore.shared.apply("glasses", "connected", true)
            DeviceStore.shared.apply("glasses", "fullyBooted", true)
            DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTED)
            if let connection = otaConnection() { nimoFirmwareUpdater?.connected(connection) }
            return
        }
        Bridge.log("NIMO: starting handshake (awaiting TWS service-connection state)")
        handshakeState = .awaitingTws
        if twsConnected {
            proceedToTimeSync()
            return
        }
        cancelTwsTimeout()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.handshakeState == .awaitingTws {
                Bridge.log("NIMO: TWS state timeout — handshake failed, will reconnect")
                self.handshakeFailed()
            }
        }
        twsTimeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Const.twsTimeoutSeconds, execute: item)
        // Also actively query in case the glasses don't push the report unprompted.
        ping()
    }

    private func cancelTwsTimeout() {
        twsTimeoutItem?.cancel()
        twsTimeoutItem = nil
    }

    private func proceedToTimeSync() {
        guard handshakeState == .awaitingTws else { return }
        cancelTwsTimeout()
        handshakeState = .awaitingTimeAck
        Bridge.log("NIMO: TWS OK — sending setTime (awaiting ACK)")
        setTimeAttempts = 0
        attemptSetTime()
    }

    private func attemptSetTime() {
        guard handshakeState == .awaitingTimeAck, let expected = peripheral else { return }
        setTimeAttempts += 1
        sendAwaitingAck(cmd: NimoProtocol.CMD_SET_PARAMETER, key: NimoProtocol.SET_TIME,
                        payload: NimoFrameCodec.encodeDeviceTime())
        { [weak self] ok in
            guard let self, self.peripheral === expected, self.handshakeState == .awaitingTimeAck else { return }
            if ok { self.finishHandshake() }
            else if self.setTimeAttempts < 3 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self, self.peripheral === expected else { return }
                    self.attemptSetTime()
                }
            } else { self.handshakeFailed() }
        }
    }

    private func finishHandshake() {
        Bridge.log("NIMO: handshake complete — fully connected")
        handshakeState = .ready
        sendFrame(
            NimoFrameCodec.encodeFrame(
                cmd: NimoProtocol.CMD_SET_PARAMETER,
                key: NimoProtocol.SET_PHONE_TYPE,
                payload: Data([UInt8(NimoProtocol.PHONE_TYPE_IOS)]),
                needsAck: false
            )
        )
        getBatteryStatus()
        requestVersionInfo()

        cancelPairingTimeout()
        Task { await reconnectionManager.stop() }
        DeviceStore.shared.apply("glasses", "connected", true)
        DeviceStore.shared.apply("glasses", "fullyBooted", true)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        startTimers()
        canvas.readiness(twsConnected && peerCompanionReady == true)
        DeviceManager.shared.updateMicState()
    }

    private func handshakeFailed() {
        handshakeState = .idle
        if let peripheral {
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        // The didDisconnectPeripheral path handles cleanup + reconnection.
    }

    private func resetSessionState() {
        handshakeState = .idle
        cancelTwsTimeout()
        twsConnected = false
        peerCompanionReady = nil
        canvasEncoder.invalidate()
        canvas.disconnected()
        receiveAssembler.reset()
        writes.reset()
        failAllPendingAcks()
        stopTimers()
    }

    private func startReconnectionTimer() {
        Task {
            await reconnectionManager.start { [weak self] in
                guard let self else { return false }
                if await MainActor.run(body: {
                    DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
                }) {
                    return true
                }
                Bridge.log("NIMO: Attempting reconnection...")
                await MainActor.run {
                    self.isDisconnecting = false
                    self.startScan()
                }
                return false
            }
        }
    }

    // MARK: - Timers (battery poll keepalive)

    private func startTimers() {
        stopTimers()
        // The battery poll doubles as a keepalive so iOS bluetoothd never sees the link
        // as unused and reclaims it.
        batteryPollTimer = Timer.scheduledTimer(
            withTimeInterval: Const.batteryPollSeconds, repeats: true
        ) { [weak self] _ in
            Task { @MainActor in
                self?.getBatteryStatus()
            }
        }
    }

    private func stopTimers() {
        batteryPollTimer?.invalidate()
        batteryPollTimer = nil
    }

    // MARK: - Incoming Data

    private func handleRxPacket(_ packet: Data) {
        if packet.count >= 10, packet[8] == 7, [1, 3, 4].contains(packet[9]) {
            guard !firmwareOwnsDevice, !otaTrafficPaused else { return }
            if let response = NimoCanvasCodec.response(packet) {
                canvas.response(key: response.key, payload: response.payload)
            }
            return
        }
        receiveAssembler.cleanup()
        for frame in receiveAssembler.ingest(packet) {
            guard let decoded = NimoFrameCodec.decode(frame),
                  let cmd = decoded.cmd, let key = decoded.key
            else { continue }
            if firmwareOwnsDevice || otaTrafficPaused {
                guard cmd == NimoProtocol.CMD_GET_PARAMETER,
                      [NimoProtocol.GET_VERSION, NimoProtocol.GET_VERSION_DETAIL].contains(key) else { continue }
            }
            if cmd == NimoProtocol.CMD_INSTRUCTION_REPORT {
                if decoded.statusCode == 0 { handleReport(key: key, data: decoded.data ?? Data()) }
            } else {
                handleResponse(
                    cmd: cmd, key: key, statusCode: decoded.statusCode ?? 1,
                    data: decoded.data ?? Data()
                )
            }
        }
    }

    private func handleReport(key: Int, data: Data) {
        switch key {
        case NimoProtocol.REPORT_INPUT:
            if !data.isEmpty {
                handleInputEvent(Int(data[data.startIndex]))
            }
        case NimoProtocol.REPORT_APP:
            if data.count >= 2 {
                let appId = Int(data[data.startIndex])
                let phase = Int(data[data.startIndex + 1])
                Bridge.log("NIMO: app state report appId=\(appId) phase=\(phase)")
                switch phase {
                case NimoProtocol.STATE_ENTER:
                    if canvas.nativeApp(appId, entered: true) { canvasEncoder.invalidate() }
                case NimoProtocol.STATE_EXIT:
                    if canvas.nativeApp(appId, entered: false) { canvasEncoder.invalidate() }
                default:
                    break
                }
            }
        case NimoProtocol.REPORT_TWS:
            if !data.isEmpty {
                onTwsState(Int(data[data.startIndex]) >= 1)
            }
        case NimoProtocol.REPORT_BUSINESS:
            handleBusinessReport(data)
        case NimoProtocol.REPORT_GATT_STATE:
            break
        default:
            Bridge.log("NIMO: unknown report key=\(key)")
        }
    }

    private func handleBusinessReport(_ data: Data) {
        guard !data.isEmpty else { return }
        let bytes = [UInt8](data)
        let id = Int(bytes[0])
        let v = Array(bytes.dropFirst())
        switch id {
        case NimoProtocol.BUSINESS_HEARTBEAT:
            // [leftMv(2)][rightMv(2)][btSysStatus(4)][twsStatus(1)][slaveGatt(1)]
            if v.count >= 10 {
                peerCompanionReady = v[9] != 0
                onTwsState(Int(v[8]) >= 1)
                if handshakeState == .ready {
                    canvas.readiness(twsConnected && peerCompanionReady == true, confirmed: true)
                }
            }
        case NimoProtocol.BUSINESS_BATTERY:
            if v.count >= 4 {
                applyBattery(
                    left: Int(v[0]), right: Int(v[1]),
                    leftCharging: v[2] == 1, rightCharging: v[3] == 1
                )
            }
        default:
            break
        }
    }

    private func onTwsState(_ connected: Bool) {
        twsConnected = connected
        if connected, handshakeState == .awaitingTws {
            proceedToTimeSync()
        }
        if !connected, handshakeState == .ready {
            Bridge.log("NIMO: TWS service dropped mid-session (arm removed/off?)")
        }
        if handshakeState == .ready { canvas.readiness(connected && peerCompanionReady == true) }
    }

    private func handleInputEvent(_ code: Int) {
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        switch code {
        case NimoProtocol.INPUT_HEAD_UP:
            DeviceStore.shared.apply("glasses", "headUp", true)
            Bridge.sendHeadUp(true)
        case NimoProtocol.INPUT_HEAD_DOWN:
            DeviceStore.shared.apply("glasses", "headUp", false)
            Bridge.sendHeadUp(false)
        case NimoProtocol.INPUT_CLICK_RIGHT, NimoProtocol.INPUT_CLICK_LEFT:
            Bridge.sendTouchEvent(
                deviceModel: DeviceTypes.NIMO, gestureName: "single_tap", timestamp: timestamp
            )
        case NimoProtocol.INPUT_DOUBLE_CLICK_RIGHT, NimoProtocol.INPUT_DOUBLE_CLICK_LEFT:
            Bridge.sendTouchEvent(
                deviceModel: DeviceTypes.NIMO, gestureName: "double_tap", timestamp: timestamp
            )
        case NimoProtocol.INPUT_LONG_PRESS_RIGHT, NimoProtocol.INPUT_LONG_PRESS_LEFT:
            Bridge.sendTouchEvent(
                deviceModel: DeviceTypes.NIMO, gestureName: "long_press", timestamp: timestamp
            )
        case NimoProtocol.INPUT_TOUCH_PRESS_RIGHT,
             NimoProtocol.INPUT_TOUCH_RELEASE_RIGHT,
             NimoProtocol.INPUT_TOUCH_PRESS_LEFT,
             NimoProtocol.INPUT_TOUCH_RELEASE_LEFT:
            // Raw press/release transitions are too chatty to forward; taps cover the UX.
            break
        default:
            Bridge.log("NIMO: unknown input event code=\(code)")
        }
    }

    private func handleResponse(cmd: Int, key: Int, statusCode: Int, data: Data) {
        resolvePendingAck(cmd: cmd, key: key, success: statusCode == 0)

        guard cmd == NimoProtocol.CMD_GET_PARAMETER, statusCode == 0 else { return }
        let bytes = [UInt8](data)
        switch key {
        case NimoProtocol.GET_BATTERY:
            if bytes.count >= 4 {
                applyBattery(
                    left: Int(bytes[0]), right: Int(bytes[1]),
                    leftCharging: bytes[2] == 1, rightCharging: bytes[3] == 1
                )
            }
        case NimoProtocol.GET_VERSION:
            if bytes.count >= 4 {
                let v =
                    UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16)
                        | (UInt32(bytes[3]) << 24)
                let major = (v >> 28) & 0xF
                let minor = (v >> 21) & 0x7F
                let micro = (v >> 12) & 0x1FF
                let build = v & 0xFFF
                firmwareVersionPacked = "\(major).\(minor).\(micro).\(build)"
                inventoryPackedReceived = true
                resolveFirmwareInventory()
                emitVersionInfo()
            }
        case NimoProtocol.GET_VERSION_DETAIL:
            var end = bytes.count
            while end > 0, bytes[end - 1] == 0 {
                end -= 1
            }
            firmwareVersionDetail =
                String(bytes: bytes[0 ..< end], encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            inventoryDetailReceived = !firmwareVersionDetail.isEmpty
            resolveFirmwareInventory()
            emitVersionInfo()
        case NimoProtocol.GET_TWS_STATUS:
            if !bytes.isEmpty {
                onTwsState(Int(bytes[0]) >= 1)
            }
        default:
            break
        }
    }

    private func applyBattery(left: Int, right: Int, leftCharging: Bool, rightCharging: Bool) {
        // Two independent arms → report the conservative (lower) level.
        let level = min(left, right)
        let charging = leftCharging || rightCharging
        if level != lastBatteryLevel || charging != lastCharging {
            lastBatteryLevel = level
            lastCharging = charging
            DeviceStore.shared.apply("glasses", "batteryLevel", level)
            DeviceStore.shared.apply("glasses", "charging", charging)
            Bridge.sendBatteryStatus(level: level, charging: charging)
        }
    }

    private func emitVersionInfo() {
        let version = firmwareVersionDetail.isEmpty ? firmwareVersionPacked : firmwareVersionDetail
        guard !version.isEmpty else { return }
        DeviceStore.shared.apply("glasses", "firmwareVersion", version)
        Bridge.sendVersionInfo(["firmwareVersion": version])
    }

    // MARK: - Mic Audio

    private func handleMicPacket(_ data: Data) {
        guard let packet = NimoAudioParser.parse(data) else { return }
        let now = Date()
        switch packet.type {
        case NimoAudioParser.TYPE_OPUS_RIGHT:
            lastRightPacketTime = now
            preferRightMic = true
        case NimoAudioParser.TYPE_OPUS_LEFT:
            // Only fall back to the left ear when the right has gone quiet —
            // forwarding both would duplicate the audio.
            if preferRightMic,
               now.timeIntervalSince(lastRightPacketTime) < Const.micSideFallbackSeconds
            {
                return
            }
            preferRightMic = false
        default:
            return
        }

        guard let opusDecoder else { return }
        for opusFrame in packet.opusFrames {
            if let pcm = opusDecoder.decode(opusFrame), !pcm.isEmpty {
                DeviceManager.shared.handlePcm(pcm)
            }
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension Nimo: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("NIMO: Bluetooth state: \(state.rawValue)")
            if state == .poweredOn {
                self.startScan()
            }
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi: NSNumber
    ) {
        guard
            let name = peripheral.name
            ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
        else { return }
        let rssiValue = rssi.intValue

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.isNimoMainDevice(name) else { return }

            Bridge.sendDiscoveredDevice(DeviceTypes.NIMO, name, rssi: rssiValue)

            guard self.DEVICE_SEARCH_ID != "NOT_SET" else { return }
            guard name == self.DEVICE_SEARCH_ID else { return }
            guard self.peripheral == nil else { return }

            Bridge.log("NIMO: Connecting to \(name)")
            self.stopScan()
            self.lastDeviceName = name
            self.lastDeviceUUID = peripheral.identifier.uuidString
            self.peripheral = peripheral
            peripheral.delegate = self
            central.connect(peripheral, options: nil)
        }
    }

    nonisolated func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("NIMO: Connected to \(peripheral.name ?? "unknown")")
            guard self.peripheral === peripheral else { return }
            self.writes.connected(peripheral)
            self.firmwareConnectionGeneration = FirmwareConnectionGeneration.next()
            self.lastDeviceUUID = peripheral.identifier.uuidString
            _ = self.firmwareUpdater
            peripheral.discoverServices([NimoBLE.SERVICE_UUID])
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log(
                "NIMO: Failed to connect \(peripheral.name ?? "unknown"): \(error?.localizedDescription ?? "unknown")"
            )
            guard self.peripheral === peripheral else { return }
            self.peripheral = nil
            self.startReconnectionTimer()
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("NIMO: Disconnected: \(error?.localizedDescription ?? "clean")")
            if self.isDisconnecting || self.peripheral !== peripheral { return }

            self.nimoFirmwareUpdater?.disconnected(connectionGeneration: self.firmwareConnectionGeneration)
            self.failOtaChannel("NIMO connection lost")

            self.peripheral = nil
            self.txChar = nil
            self.rxChar = nil
            self.micChar = nil
            self.otaTxChar = nil
            self.otaRxChar = nil
            self.resetSessionState()

            DeviceStore.shared.apply("glasses", "connected", false)
            DeviceStore.shared.apply("glasses", "fullyBooted", false)
            DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
            self.startReconnectionTimer()
        }
    }
}

// MARK: - CBPeripheralDelegate

extension Nimo: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.peripheral === peripheral else { return }
            guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == NimoBLE.SERVICE_UUID }) else {
                self.abortTransport("NIMO service discovery failed")
                return
            }
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        guard service.uuid == NimoBLE.SERVICE_UUID,
              let characteristics = service.characteristics
        else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.peripheral === peripheral else { return }
            guard error == nil else { self.abortTransport("NIMO characteristic discovery failed"); return }
            for char in characteristics {
                switch char.uuid {
                case NimoBLE.CHAR_TX:
                    self.txChar = char
                case NimoBLE.CHAR_RX:
                    self.rxChar = char
                    peripheral.setNotifyValue(true, for: char)
                case NimoBLE.CHAR_MIC:
                    self.micChar = char
                    peripheral.setNotifyValue(true, for: char)
                case NimoBLE.CHAR_OTA_TX:
                    self.otaTxChar = char
                case NimoBLE.CHAR_OTA_RX:
                    self.otaRxChar = char
                default:
                    break
                }
            }
            guard self.txChar?.properties.contains(.write) == true, self.rxChar != nil, self.micChar != nil else {
                self.abortTransport("Required NIMO characteristics unavailable")
                return
            }
            Bridge.log(
                "NIMO: chars tx=\(self.txChar != nil) rx=\(self.rxChar != nil) mic=\(self.micChar != nil)"
            )
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.peripheral === peripheral else { return }
            if characteristic === self.otaRxChar {
                let completion = self.otaPrepareCompletion
                self.otaPrepareCompletion = nil
                completion?(error ?? (characteristic.isNotifying ? nil : FirmwareUpdaterError("transport", "NIMO OTA notifications are unavailable")))
                return
            }
            if let error {
                self.abortTransport("Notification subscription failed")
                Bridge.log("NIMO: notify enable failed: \(error.localizedDescription)")
                return
            }
            guard characteristic === self.rxChar || characteristic === self.micChar else { return }
            guard characteristic.isNotifying else { self.abortTransport("NIMO notifications disabled"); return }
            if self.rxChar?.isNotifying == true, self.micChar?.isNotifying == true,
               self.txChar?.properties.contains(.write) == true, self.handshakeState == .idle
            {
                self.startHandshake()
            }
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        guard let data = characteristic.value, error == nil else { return }
        let uuid = characteristic.uuid
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.peripheral === peripheral else { return }
            if uuid == NimoBLE.CHAR_RX, characteristic === self.rxChar {
                self.handleRxPacket(data)
            } else if uuid == NimoBLE.CHAR_MIC, characteristic === self.micChar {
                if !self.otaTrafficPaused, !self.firmwareOwnsDevice { self.handleMicPacket(data) }
            } else if uuid == NimoBLE.CHAR_OTA_RX, characteristic === self.otaRxChar {
                self.nimoFirmwareUpdater?.receive(data, connectionGeneration: self.firmwareConnectionGeneration)
            }
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.writes.written(peripheral, characteristic: characteristic, success: error == nil)
        }
    }

    nonisolated func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.peripheral === peripheral else { return }
            self.drainOtaWrite()
        }
    }
}
