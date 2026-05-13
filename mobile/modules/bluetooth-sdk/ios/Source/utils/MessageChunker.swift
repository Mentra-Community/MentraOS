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
 * 253-byte BLE write limit. With compact keys, 80 bytes of raw data produces
 * a final packed size of ~245 bytes worst-case (with heavy JSON escaping).
 */
class MessageChunker {
    // Threshold: if C-wrapped message exceeds this, chunking is triggered.
    // BES2700 limit is 253 bytes; anything over ~200 bytes packed needs chunking.
    private static let MESSAGE_SIZE_THRESHOLD = 200

    /// Maximum raw bytes per chunk. After double JSON escaping + compact envelope
    /// + C-wrapper + K900 framing, 80 bytes stays under the 253-byte BLE limit.
    private static let CHUNK_DATA_SIZE = 80

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
    static func createChunks(originalJson: String, messageId: Int64 = -1) -> [[String: Any]] {
        guard let messageData = originalJson.data(using: .utf8) else {
            print("MessageChunker: Failed to convert message to data")
            return []
        }

        var chunks: [[String: Any]] = []
        let totalBytes = messageData.count

        // Compact chunk session ID: messageId_timestamp (no "chunk_" prefix)
        let chunkId = "\(messageId)_\(Int(Date().timeIntervalSince1970 * 1000))"

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

            print("MessageChunker: Created chunk \(i)/\(totalChunks - 1) with \(chunkData.count) bytes")
        }

        return chunks
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
