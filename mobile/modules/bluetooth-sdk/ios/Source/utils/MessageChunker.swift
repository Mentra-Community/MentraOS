import Foundation

/**
 * Handles chunking of large messages that exceed BLE transmission limits.
 * Messages are split at the JSON layer to work within MCU protocol constraints.
 *
 * Uses compact keys to minimize overhead per chunk:
 *   t  = "ck" (chunk type identifier)
 *   id = chunk session ID
 *   c  = chunk index (0-based)
 *   n  = total number of chunks
 *   d  = chunk data payload
 *
 * Each chunk after C-wrapping + K900 framing must fit within the BES2700's
 * 253-byte BLE write limit. Payload size is selected by measuring the final
 * packed chunk so JSON escaping cannot push a chunk over the BLE limit.
 */
class MessageChunker {
    // Threshold: if C-wrapped message exceeds this, chunking is triggered.
    // BES2700 limit is 253 bytes; anything over ~200 bytes packed needs chunking.
    private static let MESSAGE_SIZE_THRESHOLD = 200

    private static let INITIAL_CHUNK_DATA_SIZE = 80
    private static let MIN_CHUNK_DATA_SIZE = 4
    private static let MAX_PACKED_CHUNK_SIZE = 253
    private static let K900_FRAME_OVERHEAD = 7
    private static let MAX_BINARY_FRAGMENT_PAYLOAD = BleWireProtocol.maxFragmentPayload
    private static let MAX_BINARY_FRAME_SIZE = BleWireProtocol.mtuTarget

    /**
     * Check if a message needs to be chunked
     * @param message The complete message string (already C-wrapped)
     * @return true if message exceeds threshold and needs chunking
     */
    static func needsChunking(_ message: String?) -> Bool {
        guard let message = message else {
            return false
        }

        let messageBytes = message.data(using: .utf8)?.count ?? 0
        let needsChunking = messageBytes > MESSAGE_SIZE_THRESHOLD

        if needsChunking {
            print("MessageChunker: Message size \(messageBytes) exceeds threshold \(MESSAGE_SIZE_THRESHOLD), will chunk")
        }

        return needsChunking
    }

    /**
     * Create chunks from a message that's too large for single transmission.
     * Uses compact keys to minimize per-chunk overhead.
     * @param originalJson The original JSON string to be sent (before C-wrapping)
     * @param messageId The message ID for ACK tracking (if applicable)
     * @return Array of chunk dictionaries ready to be C-wrapped and sent
     */
    static func createChunks(originalJson: String, messageId: Int64 = -1, wakeUp: Bool = false) -> [[String: Any]] {
        guard let messageData = originalJson.data(using: .utf8) else {
            print("MessageChunker: Failed to convert message to data")
            return []
        }

        let totalBytes = messageData.count

        // Compact chunk session ID: messageId_timestamp (no "chunk_" prefix)
        let chunkId = "\(messageId)_\(Int(Date().timeIntervalSince1970 * 1000))"

        for chunkSize in stride(from: INITIAL_CHUNK_DATA_SIZE, through: MIN_CHUNK_DATA_SIZE, by: -1) {
            let chunks = buildChunks(messageData, chunkId: chunkId, messageId: messageId, chunkSize: chunkSize)
            if allChunksFit(chunks, wakeUp: wakeUp) {
                print("MessageChunker: Creating \(chunks.count) chunks for message of size \(totalBytes) bytes using \(chunkSize)-byte UTF-8 slices")
                return chunks
            }
        }

        print("MessageChunker: Unable to create K900 chunks within \(MAX_PACKED_CHUNK_SIZE) bytes")
        return []
    }

    private static func buildChunks(_ messageData: Data, chunkId: String, messageId: Int64, chunkSize: Int) -> [[String: Any]] {
        var chunks: [[String: Any]] = []
        let chunkStrings = splitUtf8(messageData, chunkSize: chunkSize)
        let totalChunks = chunkStrings.count

        for i in 0 ..< totalChunks {
            let chunkString = chunkStrings[i]

            // Create chunk dictionary with compact keys
            var chunk: [String: Any] = [
                "t": "ck",
                "id": chunkId,
                "c": i,
                "n": totalChunks,
                "d": chunkString,
            ]

            // Add message ID to final chunk only for ACK tracking
            if i == totalChunks - 1, messageId != -1 {
                chunk["mId"] = messageId
            }

            chunks.append(chunk)

            print("MessageChunker: Created chunk \(i)/\(totalChunks - 1) with \(chunkString.data(using: .utf8)?.count ?? 0) bytes")
        }

        return chunks
    }

    private static func allChunksFit(_ chunks: [[String: Any]], wakeUp: Bool) -> Bool {
        for (index, chunk) in chunks.enumerated() {
            let packedLength = packedK900Length(chunk, wakeUp: wakeUp && index == 0)
            if packedLength == nil || packedLength! > MAX_PACKED_CHUNK_SIZE {
                print("MessageChunker: Chunk \(index) packed to \(packedLength ?? 0) bytes, exceeding \(MAX_PACKED_CHUNK_SIZE)")
                return false
            }
        }
        return true
    }

    private static func packedK900Length(_ chunk: [String: Any], wakeUp: Bool) -> Int? {
        guard let chunkData = try? JSONSerialization.data(withJSONObject: chunk),
              let chunkString = String(data: chunkData, encoding: .utf8)
        else {
            return nil
        }

        var wrapper: [String: Any] = ["C": chunkString]
        if wakeUp {
            wrapper["W"] = 1
        }

        guard let wrappedData = try? JSONSerialization.data(withJSONObject: wrapper) else {
            return nil
        }

        return wrappedData.count + K900_FRAME_OVERHEAD
    }

    private static func splitUtf8(_ messageData: Data, chunkSize: Int) -> [String] {
        var chunkStrings: [String] = []
        var offset = 0
        while offset < messageData.count {
            let endIndex = findUtf8ChunkEnd(messageData, startIndex: offset, chunkSize: chunkSize)
            let chunkData = messageData.subdata(in: offset ..< endIndex)
            chunkStrings.append(String(data: chunkData, encoding: .utf8)!)
            offset = endIndex
        }
        return chunkStrings
    }

    private static func findUtf8ChunkEnd(_ messageData: Data, startIndex: Int, chunkSize: Int) -> Int {
        var endIndex = min(startIndex + chunkSize, messageData.count)
        while endIndex > startIndex, endIndex < messageData.count, isUtf8ContinuationByte(messageData[endIndex]) {
            endIndex -= 1
        }
        return endIndex > startIndex ? endIndex : min(startIndex + chunkSize, messageData.count)
    }

    private static func isUtf8ContinuationByte(_ value: UInt8) -> Bool {
        (value & 0xC0) == 0x80
    }

    /**
     * Check if a received message is a chunked message.
     * Supports both verbose ("type":"chunked_msg") and compact ("t":"ck") formats.
     * @param json The received dictionary (after C-unwrapping)
     * @return true if this is a chunked message
     */
    static func isChunkedMessage(_ json: [String: Any]?) -> Bool {
        guard let json = json else {
            return false
        }

        let type = json["type"] as? String ?? json["t"] as? String ?? ""
        return type == "chunked_msg" || type == "ck"
    }

    /**
     * Extract chunk information from a chunked message.
     * Supports both verbose and compact key formats.
     */
    static func getChunkInfo(_ json: [String: Any]) -> ChunkInfo? {
        guard isChunkedMessage(json) else {
            return nil
        }

        // Support both verbose and compact keys
        guard let chunkId = (json["chunkId"] as? String) ?? (json["id"] as? String),
              let chunkIndex = (json["chunk"] as? Int) ?? (json["c"] as? Int),
              let totalChunks = (json["total"] as? Int) ?? (json["n"] as? Int),
              let data = (json["data"] as? String) ?? (json["d"] as? String)
        else {
            print("MessageChunker: Failed to extract chunk info from JSON")
            return nil
        }

        let messageId = json["mId"] as? Int64 ?? -1

        return ChunkInfo(
            chunkId: chunkId,
            chunkIndex: chunkIndex,
            totalChunks: totalChunks,
            data: data,
            messageId: messageId
        )
    }

    static func needsBinaryFragmenting(_ payload: Data) -> Bool {
        payload.count > MAX_BINARY_FRAGMENT_PAYLOAD
    }

    static func needsBinaryFragmenting(_ json: String) -> Bool {
        guard let data = json.data(using: .utf8) else { return false }
        return needsBinaryFragmenting(data)
    }

    struct BinaryFragment {
        let flags: UInt8
        let msgId: UInt16
        let fragIdx: UInt8
        let fragCount: UInt8
        let payload: Data
    }

    static func createBinaryFragments(
        payload: Data,
        msgId: UInt16 = 0,
        wakeUp: Bool = false,
        ackRequested: Bool = false
    ) -> [BinaryFragment] {
        let fragCount = max(1, (payload.count + MAX_BINARY_FRAGMENT_PAYLOAD - 1) / MAX_BINARY_FRAGMENT_PAYLOAD)
        guard fragCount <= 255 else { return [] }

        var fragments: [BinaryFragment] = []
        for i in 0 ..< fragCount {
            let offset = i * MAX_BINARY_FRAGMENT_PAYLOAD
            let end = min(offset + MAX_BINARY_FRAGMENT_PAYLOAD, payload.count)
            let fragPayload = payload.subdata(in: offset ..< end)

            var flags: UInt8 = 0
            if i == 0 { flags |= BleWireProtocol.flagFirstFrag }
            if i == fragCount - 1 { flags |= BleWireProtocol.flagLastFrag }
            if wakeUp, i == 0 { flags |= BleWireProtocol.flagWake }
            if ackRequested, i == fragCount - 1 { flags |= BleWireProtocol.flagAckRequested }

            fragments.append(
                BinaryFragment(
                    flags: flags,
                    msgId: msgId,
                    fragIdx: UInt8(i),
                    fragCount: UInt8(fragCount),
                    payload: fragPayload
                )
            )
        }

        print("MessageChunker: Created \(fragments.count) binary fragments for \(payload.count) bytes")
        return fragments
    }

    static func allBinaryFragmentsFit(_ fragments: [BinaryFragment]) -> Bool {
        for fragment in fragments {
            guard let packed = BleWireProtocol.packBinaryFragment(
                flags: fragment.flags,
                msgId: fragment.msgId,
                fragIdx: fragment.fragIdx,
                fragCount: fragment.fragCount,
                payload: fragment.payload
            ) else {
                return false
            }
            if packed.count > MAX_BINARY_FRAME_SIZE {
                return false
            }
        }
        return true
    }

    /**
     * Container for chunk information
     */
    struct ChunkInfo {
        let chunkId: String
        let chunkIndex: Int
        let totalChunks: Int
        let data: String
        let messageId: Int64

        var isFinalChunk: Bool {
            return chunkIndex == totalChunks - 1
        }
    }
}
