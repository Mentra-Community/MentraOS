import Foundation

@MainActor
protocol Ar99OtaGattTransport: AnyObject {
    func enableOtaNotification() -> Bool
    func sendOtaData(_ data: Data)
    func requestMtu(_ mtu: Int)
    func isBleConnected() -> Bool
}

@MainActor
struct Ar99OtaCallbacks {
    var onProgress: (_ offset: Int, _ total: Int, _ progress: Int) -> Void
    var onCompleted: (_ needReboot: Bool) -> Void
    var onError: (_ errorCode: Int, _ message: String) -> Void
    var onCancelled: () -> Void
    var onPausedWaitingReconnect: () -> Void = {}
}

private enum Ar99OtaCommand {
    static let serviceId: UInt8 = 0x09
    static let requestUpgrade: UInt8 = 0x01
    static let connectNegotiation: UInt8 = 0x02
    static let requireImageData: UInt8 = 0x03
    static let validateImage: UInt8 = 0x06
    static let negotiationResult: UInt8 = 0x09
    static let sendImageData: UInt8 = 0x0B
}

private enum Ar99OtaErrorCode {
    static let protocolError = 0x04
    static let packageSizeError = 0x06
    static let firmwareValidationFailed = 0x0A
    static let unknownError = 0xFF
}

private enum Ar99OtaState {
    static let idle = 0
    static let requesting = 1
    static let negotiating = 2
    static let waitingReady = 3
    static let transferring = 4
    static let completed = 6
    static let failed = 7
    static let pausedDisconnected = 8
}

private struct Ar99OtaFrameHeader {
    let serviceId: UInt8
    let command: UInt8
    let parameterLength: Int
    let payloadOffset: Int
}

private enum Ar99OtaByteUtils {
    static func readUInt16LE(_ data: Data, offset: Int) -> Int {
        guard offset >= 0, offset + 1 < data.count else { return 0 }
        let bytes = Array(data)
        return Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
    }

    static func readInt32LE(_ data: Data, offset: Int) -> Int {
        guard offset >= 0, offset + 3 < data.count else { return 0 }
        let bytes = Array(data)
        let value = UInt32(bytes[offset])
            | (UInt32(bytes[offset + 1]) << 8)
            | (UInt32(bytes[offset + 2]) << 16)
            | (UInt32(bytes[offset + 3]) << 24)
        return Int(Int32(bitPattern: value))
    }
}

private enum Ar99OtaCrc32 {
    private static let table: [UInt32] = {
        (0 ..< 256).map { index in
            var crc = UInt32(index)
            for _ in 0 ..< 8 {
                crc = (crc & 1) == 1 ? (0xEDB88320 ^ (crc >> 1)) : (crc >> 1)
            }
            return crc
        }
    }()

    static func calculate(_ data: Data?) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data ?? Data() {
            let index = Int((crc ^ UInt32(byte)) & 0xFF)
            crc = table[index] ^ (crc >> 8)
        }
        return crc ^ 0xFFFF_FFFF
    }
}

private enum Ar99OtaProtocol {
    static func buildFrame(command: UInt8, parameterType: UInt8, payload: Data?) -> Data {
        var frame = Data()
        frame.append(Ar99OtaCommand.serviceId)
        frame.append(command)
        frame.append(parameterType)
        let length = payload?.count ?? 0
        frame.append(UInt8(length & 0xFF))
        frame.append(UInt8((length >> 8) & 0xFF))
        if let payload, !payload.isEmpty {
            frame.append(payload)
        }
        return frame
    }

    static func buildRequestUpgrade(packageSize: Int, blockSize _: Int, crc32 _: UInt32) -> Data {
        // Wire layout matches the vendor bring-up frame: type marker, then TLV
        // 0x0A/len4 = package size (LE). CRC is validated per-block in sendImageData;
        // blockSize is negotiated separately in connectNegotiation.
        var payload = Data([0x09, 0x01, 0x00, 0x01, 0x0A, 0x04])
        payload.append(UInt8(packageSize & 0xFF))
        payload.append(UInt8((packageSize >> 8) & 0xFF))
        payload.append(UInt8((packageSize >> 16) & 0xFF))
        payload.append(UInt8((packageSize >> 24) & 0xFF))
        payload.append(0x00)
        return buildFrame(command: Ar99OtaCommand.requestUpgrade, parameterType: 0x80, payload: payload)
    }

    static func buildConnectNegotiation(blockSize _: Int) -> Data {
        buildFrame(command: Ar99OtaCommand.connectNegotiation, parameterType: 0x80, payload: nil)
    }

    static func buildNegotiationResult() -> Data {
        buildFrame(command: Ar99OtaCommand.negotiationResult, parameterType: 0x80, payload: Data([0x01, 0x01, 0x00, 0x01]))
    }

    static func buildSendImageData(packetSequenceNumber: Int, block: Data) -> Data {
        var payload = Data()
        payload.append(UInt8(packetSequenceNumber & 0xFF))
        let crc32 = Ar99OtaCrc32.calculate(block)
        payload.append(UInt8(crc32 & 0xFF))
        payload.append(UInt8((crc32 >> 8) & 0xFF))
        payload.append(UInt8((crc32 >> 16) & 0xFF))
        payload.append(UInt8((crc32 >> 24) & 0xFF))
        payload.append(block)
        return buildFrame(command: Ar99OtaCommand.sendImageData, parameterType: 0x80, payload: payload)
    }

    static func parseFrameHeader(_ frame: Data) -> Ar99OtaFrameHeader? {
        guard frame.count >= 5 else { return nil }
        let bytes = Array(frame)
        return Ar99OtaFrameHeader(
            serviceId: bytes[0],
            command: bytes[1],
            parameterLength: Ar99OtaByteUtils.readUInt16LE(frame, offset: 3),
            payloadOffset: 5
        )
    }
}

@MainActor
final class Ar99OtaManager {
    static let shared = Ar99OtaManager()

    private static let defaultBlockSize = 200
    private static let timeoutMs = 5_000
    private static let reconnectTimeoutMs = 90_000

    private weak var transport: Ar99OtaGattTransport?
    private var callbacks: Ar99OtaCallbacks?
    private var timeoutItem: DispatchWorkItem?
    private var reconnectTimeoutItem: DispatchWorkItem?

    private var state = Ar99OtaState.idle
    private var firmwareData: Data?
    private var firmwareSize = 0
    private var firmwareCrc32: UInt32 = 0
    private var blockSize = defaultBlockSize
    private var currentOffset = 0
    private var otaNotifyEnabled = false

    private init() {}

    func setTransport(_ transport: Ar99OtaGattTransport?) {
        self.transport = transport
    }

    func setCallback(_ callbacks: Ar99OtaCallbacks?) {
        self.callbacks = callbacks
    }

    func isOTAInProgress() -> Bool {
        state != Ar99OtaState.idle && state != Ar99OtaState.completed && state != Ar99OtaState.failed
    }

    func isPausedWaitingReconnect() -> Bool {
        state == Ar99OtaState.pausedDisconnected
    }

    func getProgress() -> Int {
        guard firmwareSize > 0 else { return 0 }
        return (currentOffset * 100) / firmwareSize
    }

    func startOTA(filePath: String) -> Bool {
        let trimmed = filePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            notifyError(Ar99OtaErrorCode.unknownError, "Firmware file path is empty")
            return false
        }

        let url: URL
        if trimmed.hasPrefix("file://"), let fileUrl = URL(string: trimmed) {
            url = fileUrl
        } else {
            url = URL(fileURLWithPath: trimmed)
        }

        do {
            return startOTA(data: try Data(contentsOf: url))
        } catch {
            notifyError(Ar99OtaErrorCode.unknownError, "Failed to read firmware file")
            return false
        }
    }

    func startOTA(data: Data) -> Bool {
        if isOTAInProgress() {
            Bridge.log("Ar99OtaManager: OTA is already in progress")
            return false
        }
        guard !data.isEmpty else {
            notifyError(Ar99OtaErrorCode.packageSizeError, "Firmware data is empty")
            return false
        }

        state = Ar99OtaState.idle
        otaNotifyEnabled = false
        cancelTimeout()
        cancelReconnectTimeout()
        firmwareData = data
        firmwareSize = data.count
        firmwareCrc32 = Ar99OtaCrc32.calculate(data)
        blockSize = Self.defaultBlockSize
        currentOffset = 0

        guard let transport else {
            notifyError(Ar99OtaErrorCode.unknownError, "OTA transport is not initialized")
            return false
        }
        guard transport.enableOtaNotification() else {
            notifyError(Ar99OtaErrorCode.unknownError, "OTA service was not found")
            return false
        }
        return true
    }

    func cancelOTA() {
        state = Ar99OtaState.idle
        otaNotifyEnabled = false
        firmwareData = nil
        firmwareSize = 0
        currentOffset = 0
        cancelTimeout()
        cancelReconnectTimeout()
        callbacks?.onCancelled()
        cleanupFirmware()
    }

    func onBleDisconnected() {
        guard isOTAInProgress(), firmwareData != nil, firmwareSize > 0 else { return }
        guard state != Ar99OtaState.pausedDisconnected else { return }
        state = Ar99OtaState.pausedDisconnected
        otaNotifyEnabled = false
        cancelTimeout()
        startReconnectTimeout()
        callbacks?.onPausedWaitingReconnect()
    }

    func tryResumeOtaAfterGattReady() {
        let shouldResume = state == Ar99OtaState.pausedDisconnected && firmwareData != nil && firmwareSize > 0
        if shouldResume {
            _ = transport?.enableOtaNotification()
        }
    }

    func onOtaNotifyEnabled() {
        otaNotifyEnabled = true
        guard firmwareData != nil, firmwareSize > 0 else { return }
        guard state == Ar99OtaState.idle || state == Ar99OtaState.pausedDisconnected else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(1_000)) { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                guard self.state == Ar99OtaState.idle || self.state == Ar99OtaState.pausedDisconnected else { return }
                _ = self.sendUpgradeRequest()
            }
        }
    }

    func handleMtuNegotiatedForOta(success: Bool) -> Bool {
        guard state == Ar99OtaState.requesting else { return false }
        guard success else {
            handleOTAFailure(Ar99OtaErrorCode.unknownError, "MTU negotiation failed")
            return true
        }
        onMtuNegotiated()
        return true
    }

    func handleOTAResponse(_ data: Data) {
        guard data.count >= 5 else { return }
        guard let header = Ar99OtaProtocol.parseFrameHeader(data),
              header.serviceId == Ar99OtaCommand.serviceId
        else {
            return
        }
        cancelTimeout()

        let payload: Data?
        if header.parameterLength > 0, data.count >= header.payloadOffset + header.parameterLength {
            payload = data.subdata(in: header.payloadOffset ..< header.payloadOffset + header.parameterLength)
        } else {
            payload = nil
        }

        switch header.command {
        case Ar99OtaCommand.requestUpgrade:
            handleUpgradeRequestResponse(payload)
        case Ar99OtaCommand.connectNegotiation:
            handleNegotiationResponse(payload)
        case Ar99OtaCommand.negotiationResult:
            handleNegotiationResultResponse()
        case Ar99OtaCommand.requireImageData:
            handleRequireImageData(payload)
        case Ar99OtaCommand.sendImageData:
            handleImageDataResponse(payload)
        case Ar99OtaCommand.validateImage:
            handleValidateImageResponse(payload)
        default:
            startTimeout()
            break
        }
    }

    private func sendUpgradeRequest() -> Bool {
        guard isBluetoothConnected() else {
            notifyError(Ar99OtaErrorCode.unknownError, "Bluetooth is not connected")
            return false
        }
        guard firmwareData != nil, firmwareSize > 0 else {
            state = Ar99OtaState.idle
            return false
        }
        cancelReconnectTimeout()
        state = Ar99OtaState.requesting
        guard let transport else {
            notifyError(Ar99OtaErrorCode.unknownError, "OTA transport is not initialized")
            return false
        }
        transport.requestMtu(247)
        startTimeout()
        return true
    }

    private func onMtuNegotiated() {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(500)) { [weak self] in
            Task { @MainActor in
                guard let self, self.state == Ar99OtaState.requesting else { return }
                self.sendOtaData(
                    Ar99OtaProtocol.buildRequestUpgrade(
                        packageSize: self.firmwareSize,
                        blockSize: self.blockSize,
                        crc32: self.firmwareCrc32
                    )
                )
            }
        }
    }

    private func handleUpgradeRequestResponse(_ payload: Data?) {
        guard let payload, payload.count >= 3 else {
            handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid upgrade response")
            return
        }

        var offset = 0
        var success = false
        while offset + 3 <= payload.count {
            let bytes = Array(payload)
            let type = bytes[offset]
            offset += 1
            let length = Ar99OtaByteUtils.readUInt16LE(payload, offset: offset)
            offset += 2
            guard offset + length <= payload.count else {
                handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid upgrade TLV")
                return
            }
            if type == 0x7F, length >= 4 {
                let errorCode = Ar99OtaByteUtils.readInt32LE(payload, offset: offset)
                if errorCode == 100_000 {
                    success = true
                } else {
                    handleOTAFailure(Ar99OtaErrorCode.protocolError, "Upgrade request failed: \(errorCode)")
                    return
                }
            }
            offset += length
        }

        guard success else {
            handleOTAFailure(Ar99OtaErrorCode.protocolError, "Upgrade request was rejected")
            return
        }
        state = Ar99OtaState.negotiating
        sendOtaData(Ar99OtaProtocol.buildConnectNegotiation(blockSize: blockSize))
        startTimeout()
    }

    private func handleNegotiationResponse(_ payload: Data?) {
        guard let payload, payload.count >= 3 else {
            handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid negotiation response")
            return
        }

        var offset = 0
        while offset + 3 <= payload.count {
            let bytes = Array(payload)
            let type = bytes[offset]
            offset += 1
            let length = Ar99OtaByteUtils.readUInt16LE(payload, offset: offset)
            offset += 2
            guard offset + length <= payload.count else {
                handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid negotiation TLV")
                return
            }
            if type == 0x03, length >= 2 {
                let suggestedBlockSize = Ar99OtaByteUtils.readUInt16LE(payload, offset: offset)
                if suggestedBlockSize > 0 {
                    blockSize = suggestedBlockSize
                }
            }
            offset += length
        }

        state = Ar99OtaState.waitingReady
        sendOtaData(Ar99OtaProtocol.buildNegotiationResult())
        startTimeout()
    }

    private func handleNegotiationResultResponse() {
        state = Ar99OtaState.transferring
        startTimeout()
    }

    private func handleRequireImageData(_ payload: Data?) {
        guard let payload, payload.count >= 3 else {
            handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid image data request")
            return
        }

        var offset = 0
        var fileOffset = 0
        var fileLength = 0
        while offset + 3 <= payload.count {
            let bytes = Array(payload)
            let type = bytes[offset]
            offset += 1
            let length = Ar99OtaByteUtils.readUInt16LE(payload, offset: offset)
            offset += 2
            guard offset + length <= payload.count else {
                handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid image data TLV")
                return
            }
            if type == 0x01, length >= 4 {
                fileOffset = Ar99OtaByteUtils.readInt32LE(payload, offset: offset)
            } else if type == 0x02, length >= 4 {
                fileLength = Ar99OtaByteUtils.readInt32LE(payload, offset: offset)
            }
            offset += length
        }

        guard let image = firmwareData,
              firmwareSize > 0,
              fileOffset >= 0,
              fileOffset <= firmwareSize
        else {
            handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid firmware offset")
            return
        }
        guard fileOffset < firmwareSize else {
            startTimeout()
            return
        }

        let remaining = firmwareSize - fileOffset
        let totalSendLength = fileLength > 0 ? min(remaining, fileLength) : remaining
        var sentLength = 0
        var packetSequenceNumber = 0
        while sentLength < totalSendLength {
            let size = min(totalSendLength - sentLength, blockSize)
            let current = fileOffset + sentLength
            let block = image.subdata(in: current ..< current + size)
            sendOtaData(Ar99OtaProtocol.buildSendImageData(packetSequenceNumber: packetSequenceNumber, block: block))
            sentLength += size
            packetSequenceNumber += 1
        }

        currentOffset = fileOffset + sentLength
        notifyProgress(offset: currentOffset, progress: getProgress())
        startTimeout()
    }

    private func handleValidateImageResponse(_ payload: Data?) {
        var validFlag: Int?
        if let payload, payload.count >= 4 {
            var offset = 0
            while offset + 3 <= payload.count {
                let bytes = Array(payload)
                let type = bytes[offset]
                offset += 1
                let length = Ar99OtaByteUtils.readUInt16LE(payload, offset: offset)
                offset += 2
                guard offset + length <= payload.count else { break }
                if type == 0x01, length >= 1 {
                    validFlag = Int(bytes[offset])
                    break
                }
                offset += length
            }
        }
        if validFlag == nil, let payload, let first = payload.first {
            validFlag = Int(first)
        }

        if validFlag == 1 {
            handleOTASuccess()
        } else {
            handleOTAFailure(Ar99OtaErrorCode.firmwareValidationFailed, "Firmware validation failed")
        }
    }

    private func handleImageDataResponse(_ payload: Data?) {
        guard let payload, payload.count >= 5 else {
            handleOTAFailure(Ar99OtaErrorCode.protocolError, "Invalid image data response")
            return
        }
        let receivedOffset = Ar99OtaByteUtils.readInt32LE(payload, offset: 0)
        let status = Int(Array(payload)[4])
        guard status == 0 else {
            handleOTAFailure(status, "Firmware data write failed")
            return
        }
        if receivedOffset != currentOffset {
            currentOffset = receivedOffset
        }
        startTimeout()
    }

    private func sendOtaData(_ frame: Data) {
        guard let transport else {
            handleOTAFailure(Ar99OtaErrorCode.unknownError, "OTA transport is not initialized")
            return
        }
        transport.sendOtaData(frame)
    }

    private func isBluetoothConnected() -> Bool {
        transport?.isBleConnected() == true && otaNotifyEnabled
    }

    private func handleOTASuccess() {
        state = Ar99OtaState.completed
        currentOffset = firmwareSize
        cancelTimeout()
        cancelReconnectTimeout()
        notifyProgress(offset: firmwareSize, progress: 100)
        callbacks?.onCompleted(false)
        cleanupFirmware()
    }

    private func handleOTAFailure(_ code: Int, _ message: String) {
        state = Ar99OtaState.failed
        cancelTimeout()
        cancelReconnectTimeout()
        notifyError(code, message)
        cleanupFirmware()
    }

    private func startTimeout() {
        cancelTimeout()
        let item = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                self?.handleOTAFailure(Ar99OtaErrorCode.unknownError, "OTA timed out")
            }
        }
        timeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Self.timeoutMs), execute: item)
    }

    private func cancelTimeout() {
        timeoutItem?.cancel()
        timeoutItem = nil
    }

    private func startReconnectTimeout() {
        cancelReconnectTimeout()
        let item = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, self.state == Ar99OtaState.pausedDisconnected else { return }
                self.handleOTAFailure(
                    Ar99OtaErrorCode.unknownError,
                    "Bluetooth disconnected during AR99 OTA. Reconnect timed out; please try the update again."
                )
            }
        }
        reconnectTimeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Self.reconnectTimeoutMs), execute: item)
    }

    private func cancelReconnectTimeout() {
        reconnectTimeoutItem?.cancel()
        reconnectTimeoutItem = nil
    }

    private func notifyProgress(offset: Int, progress: Int) {
        callbacks?.onProgress(offset, firmwareSize, progress)
    }

    private func notifyError(_ errorCode: Int, _ message: String) {
        callbacks?.onError(errorCode, message)
    }

    private func cleanupFirmware() {
        firmwareData = nil
        firmwareSize = 0
        firmwareCrc32 = 0
        currentOffset = 0
        blockSize = Self.defaultBlockSize
        otaNotifyEnabled = false
        cancelTimeout()
        cancelReconnectTimeout()
    }
}
