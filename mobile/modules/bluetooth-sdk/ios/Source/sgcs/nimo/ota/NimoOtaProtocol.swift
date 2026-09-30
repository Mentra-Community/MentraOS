import Foundation

/// NIMO's OTA channel (7033/2001/2002), distinct from the normal 0xBF command channel.
enum NimoOtaProtocol {
    static let info: UInt8 = 0x02
    static let reset: UInt8 = 0x03
    static let fileOffsetCommand: UInt8 = 0xE1
    static let canUpdate: UInt8 = 0xE2
    static let enter: UInt8 = 0xE3
    static let block: UInt8 = 0xE5
    static let validate: UInt8 = 0xE6
    static let sync: UInt8 = 0xE8
    private static let header: [UInt8] = [0x70, 0x07, 0x6E]

    struct ProtocolError: Error, LocalizedError {
        let message: String
        var errorDescription: String? {
            message
        }
    }

    struct Response {
        let command: UInt8
        let sequence: UInt8
        let status: UInt8
        let body: Data
    }

    struct Slice: Equatable {
        let offset: UInt64
        let length: Int
    }

    struct EnterResult {
        let slice: Slice
        let crc: Bool
    }

    struct BlockResult {
        let slice: Slice
        let delayMs: Int
    }

    static func request(_ command: UInt8, sequence: UInt8, params: Data = Data()) throws -> Data {
        try require(params.count <= 65534, "Invalid OTA request")
        let length = params.count + 1
        return Data(header + [0xC0, command, UInt8(length >> 8), UInt8(truncatingIfNeeded: length), sequence]) + params + Data([0x33])
    }

    /// Bounded incremental decoder. Malformed input invalidates the exchange; it is never silently skipped.
    final class Decoder {
        private var buffer: [UInt8] = []
        func reset() {
            buffer.removeAll(keepingCapacity: true)
        }

        func feed(_ bytes: Data) throws -> [Response] {
            var result: [Response] = []
            do {
                for byte in bytes {
                    buffer.append(byte)
                    if buffer.count <= 3 { try require(byte == header[buffer.count - 1], "Invalid OTA header") }
                    if buffer.count == 4 { try require(buffer[3] == 0, "Invalid OTA direction") }
                    if buffer.count >= 7 {
                        let length = u16(buffer, 5)
                        try require((2 ... 4096).contains(length), "Invalid OTA response length")
                        if buffer.count == length + 8 {
                            try require(byte == 0x33, "Invalid OTA footer")
                            result.append(Response(command: buffer[4], sequence: buffer[8], status: buffer[7], body: Data(buffer[9 ..< buffer.count - 1])))
                            reset()
                        }
                    }
                }
            } catch { reset(); throw error }
            return result
        }
    }

    static func deviceInfo(_ body: Data) throws -> [UInt8: Data] {
        let bytes = [UInt8](body)
        var fields: [UInt8: Data] = [:]
        var index = 0
        while index < bytes.count {
            let length = Int(bytes[index])
            try require(length >= 1 && length <= bytes.count - index - 1, "Truncated OTA device info")
            let type = bytes[index + 1]
            try require(fields[type] == nil, "Duplicate OTA device info")
            fields[type] = Data(bytes[index + 2 ..< index + 1 + length])
            index += 1 + length
        }
        return fields
    }

    static func fileOffset(_ body: Data) throws -> Slice {
        let bytes = [UInt8](body)
        try require(bytes.count == 6, "Invalid OTA file offset")
        return Slice(offset: u32(bytes, 0), length: u16(bytes, 4))
    }

    static func enterResult(_ body: Data) throws -> EnterResult {
        let bytes = [UInt8](body)
        try require(bytes.count == 8 && bytes[0] == 0 && bytes[7] <= 1, "OTA upgrade entry refused")
        return EnterResult(slice: Slice(offset: u32(bytes, 1), length: u16(bytes, 5)), crc: bytes[7] == 1)
    }

    static func blockResult(_ body: Data) throws -> BlockResult {
        let bytes = [UInt8](body)
        try require(bytes.count == 9 && bytes[0] == 0, "OTA block refused")
        let delay = u16(bytes, 7)
        try require(delay <= 30000, "Invalid OTA block delay")
        return BlockResult(slice: Slice(offset: u32(bytes, 1), length: u16(bytes, 5)), delayMs: delay)
    }

    static func firmwareSlice(_ firmware: Data, _ slice: Slice) throws -> Data {
        try require(slice.offset <= UInt64(firmware.count) && slice.length > 0 &&
            UInt64(slice.length) <= UInt64(firmware.count) - slice.offset, "OTA slice exceeds firmware")
        let start = firmware.startIndex + Int(slice.offset)
        return firmware.subdata(in: start ..< start + slice.length)
    }

    /// Each chunk gets its own CRC and sequence; only the final chunk gets a block response.
    static func blockParts(_ firmware: Data, slice: Slice, crc: Bool, writeCapacity: Int) throws -> [Data] {
        let data = try firmwareSlice(firmware, slice)
        try require((20 ... 512).contains(writeCapacity), "Unsupported OTA write capacity")
        let chunkSize = min(496, writeCapacity - 16) - (crc ? 4 : 0)
        try require(chunkSize > 0, "OTA write capacity too small for CRC")
        return stride(from: 0, to: data.count, by: chunkSize).map { start in
            let piece = data.subdata(in: start ..< min(start + chunkSize, data.count))
            return u32Bytes(slice.offset + UInt64(start)) + piece + (crc ? u32Bytes(UInt64(crc32(piece))) : Data())
        }
    }

    static func crc32(_ data: Data) -> UInt32 {
        var value: UInt32 = 0xFFFF_FFFF
        for byte in data {
            value ^= UInt32(byte)
            for _ in 0 ..< 8 {
                value = (value >> 1) ^ (value & 1 == 1 ? 0xEDB8_8320 : 0)
            }
        }
        return value ^ 0xFFFF_FFFF
    }

    private static func require(_ valid: Bool, _ message: String) throws {
        if !valid { throw ProtocolError(message: message) }
    }

    private static func u16(_ bytes: [UInt8], _ offset: Int) -> Int {
        Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
    }

    private static func u32(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
        (0 ..< 4).reduce(UInt64(0)) { ($0 << 8) | UInt64(bytes[offset + $1]) }
    }

    private static func u32Bytes(_ value: UInt64) -> Data {
        Data([24, 16, 8, 0].map { UInt8(truncatingIfNeeded: value >> $0) })
    }
}
