import Foundation

/// BLE Wire Protocol v2 shared constants and binary frame helpers.
/// All multi-byte fields use little-endian byte order.
enum BleWireProtocol {
    static let cmdTypeBinaryMsg: UInt8 = 0x40

    static let flagFirstFrag: UInt8 = 0x01
    static let flagLastFrag: UInt8 = 0x02
    static let flagWake: UInt8 = 0x04
    static let flagHandshake: UInt8 = 0x08
    static let flagAckRequested: UInt8 = 0x10

    static let binaryHeaderSize = 7
    static let maxFragmentPayload = 480
    static let mtuTarget = 509

    static let handshakePayloadV2 = "v2"
    static let protocolV1 = 1
    static let protocolV2 = 2

    struct BinaryFragmentInfo {
        let flags: UInt8
        let msgId: UInt16
        let fragIdx: UInt8
        let fragCount: UInt8
        let payload: Data
    }

    static func isBinaryFrame(_ data: Data) -> Bool {
        guard data.count >= 7 else { return false }
        let bytes = [UInt8](data)
        return bytes[0] == 0x23 && bytes[1] == 0x23 && bytes[2] == cmdTypeBinaryMsg
    }

    static func packBinaryFragment(
        flags: UInt8,
        msgId: UInt16,
        fragIdx: UInt8,
        fragCount: UInt8,
        payload: Data
    ) -> Data? {
        var inner = Data(capacity: binaryHeaderSize + payload.count)
        inner.append(flags)
        inner.append(UInt8(msgId & 0xFF))
        inner.append(UInt8((msgId >> 8) & 0xFF))
        inner.append(fragIdx)
        inner.append(fragCount)
        let payloadLen = UInt16(payload.count)
        inner.append(UInt8(payloadLen & 0xFF))
        inner.append(UInt8((payloadLen >> 8) & 0xFF))
        inner.append(payload)
        return packDataToK900(inner, cmdType: cmdTypeBinaryMsg)
    }

    static func extractBinaryFragmentInfo(_ frame: Data) -> BinaryFragmentInfo? {
        guard isBinaryFrame(frame) else { return nil }
        let bytes = [UInt8](frame)
        let innerLen = Int(bytes[3]) | (Int(bytes[4]) << 8)
        guard innerLen >= binaryHeaderSize, frame.count >= 7 + innerLen else { return nil }

        let offset = 5
        let payloadLen = Int(bytes[offset + 5]) | (Int(bytes[offset + 6]) << 8)
        guard binaryHeaderSize + payloadLen <= innerLen else { return nil }

        let payload = frame.subdata(in: (offset + binaryHeaderSize) ..< (offset + binaryHeaderSize + payloadLen))
        return BinaryFragmentInfo(
            flags: bytes[offset],
            msgId: UInt16(bytes[offset + 1]) | (UInt16(bytes[offset + 2]) << 8),
            fragIdx: bytes[offset + 3],
            fragCount: bytes[offset + 4],
            payload: payload
        )
    }

    static func isHandshakeV2(_ info: BinaryFragmentInfo) -> Bool {
        guard (info.flags & flagHandshake) != 0 else { return false }
        return String(data: info.payload, encoding: .utf8) == handshakePayloadV2
    }

    private static func packDataToK900(_ data: Data, cmdType: UInt8) -> Data? {
        var result = Data(capacity: data.count + 7)
        result.append(contentsOf: [0x23, 0x23])
        result.append(cmdType)
        let dataLength = UInt16(data.count)
        result.append(UInt8(dataLength & 0xFF))
        result.append(UInt8((dataLength >> 8) & 0xFF))
        result.append(data)
        result.append(contentsOf: [0x24, 0x24])
        return result
    }
}
