import Foundation

/**
 * Handles chunking of large messages that exceed BLE transmission limits.
 * Messages are split at the JSON layer to work within MCU protocol constraints.
 */
class MessageChunker {
    // Threshold for chunking - accounts for MCU protocol overhead
    // MTU ~512 - BLE overhead (3) - MCU protocol (7) - C-wrapper (~50) - safety margin
    private static let MESSAGE_SIZE_THRESHOLD = 400

    // Maximum size for chunk data content
    // Account for chunk wrapper overhead (~100 bytes for type, chunkId, indices)
    private static let CHUNK_DATA_SIZE = 300

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
     * Create chunks from a message that's too large for single transmission
     * @param originalJson The original JSON string to be sent (before C-wrapping)
     * @param messageId The message ID for ACK tracking (if applicable)
     * @return Array of chunk dictionaries ready to be C-wrapped and sent
     */
    static func createChunks(originalJson: String, messageId: Int64 = -1) -> [[String: Any]] {
        guard let messageData = originalJson.data(using: .utf8) else {
            print("MessageChunker: Failed to convert message to data")
            return []
        }

        var chunks: [[String: Any]] = []
        let totalBytes = messageData.count

        // Generate unique chunk ID for this message set
        let chunkId = "chunk_\(messageId)_\(Int(Date().timeIntervalSince1970 * 1000))"

        // Calculate total chunks needed
        let totalChunks = Int(ceil(Double(totalBytes) / Double(CHUNK_DATA_SIZE)))

        print("MessageChunker: Creating \(totalChunks) chunks for message of size \(totalBytes) bytes")

        for i in 0 ..< totalChunks {
            let startIndex = i * CHUNK_DATA_SIZE
            let endIndex = min(startIndex + CHUNK_DATA_SIZE, totalBytes)
            let chunkRange = startIndex ..< endIndex

            // Extract chunk data as string
            let chunkData = messageData.subdata(in: chunkRange)
            guard let chunkString = String(data: chunkData, encoding: .utf8) else {
                print("MessageChunker: Failed to convert chunk \(i) to string")
                continue
            }

            // Create chunk dictionary
            var chunk: [String: Any] = [
                "type": "chunked_msg",
                "chunkId": chunkId,
                "chunk": i,
                "total": totalChunks,
                "data": chunkString,
            ]

            // Add message ID to final chunk only for ACK tracking
            if i == totalChunks - 1, messageId != -1 {
                chunk["mId"] = messageId
            }

            chunks.append(chunk)

            print("MessageChunker: Created chunk \(i)/\(totalChunks - 1) with \(chunkData.count) bytes")
        }

        return chunks
    }

    /**
     * Check if a received message is a chunked message
     * @param json The received dictionary (after C-unwrapping)
     * @return true if this is a chunked message
     */
    static func isChunkedMessage(_ json: [String: Any]?) -> Bool {
        guard let json = json else {
            return false
        }

        let type = json["type"] as? String ?? ""
        return type == "chunked_msg"
    }

    /**
     * Extract chunk information from a chunked message
     */
    static func getChunkInfo(_ json: [String: Any]) -> ChunkInfo? {
        guard isChunkedMessage(json) else {
            return nil
        }

        guard let chunkId = json["chunkId"] as? String,
              let chunkIndex = json["chunk"] as? Int,
              let totalChunks = json["total"] as? Int,
              let data = json["data"] as? String
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
