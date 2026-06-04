import Foundation

final class MessageChunkReassembler {
    private static let chunkTimeoutMs: TimeInterval = 30_000
    private static let maxConcurrentSessions = 10

    private var activeSessions: [String: ChunkSession] = [:]

    func addChunk(_ info: MessageChunker.ChunkInfo) -> String? {
        cleanupTimedOutSessions()

        guard !info.chunkId.isEmpty,
              info.totalChunks > 0,
              info.chunkIndex >= 0,
              info.chunkIndex < info.totalChunks
        else {
            print("MessageChunkReassembler: Dropping invalid chunk metadata for \(info.chunkId)")
            return nil
        }

        if let existing = activeSessions[info.chunkId], existing.totalChunks != info.totalChunks {
            print(
                "MessageChunkReassembler: totalChunks mismatch for \(info.chunkId) (expected \(existing.totalChunks), got \(info.totalChunks)); resetting session"
            )
            activeSessions.removeValue(forKey: info.chunkId)
        }

        if activeSessions.count >= Self.maxConcurrentSessions,
           activeSessions[info.chunkId] == nil
        {
            removeOldestSession()
        }

        let isNewSession = activeSessions[info.chunkId] == nil
        let session = activeSessions[info.chunkId] ?? ChunkSession(
            chunkId: info.chunkId,
            totalChunks: info.totalChunks
        )

        guard session.addChunk(index: info.chunkIndex, data: info.data) else {
            print("MessageChunkReassembler: Failed to add chunk \(info.chunkIndex) for \(info.chunkId)")
            return nil
        }
        if isNewSession {
            activeSessions[info.chunkId] = session
        }

        guard session.isComplete else {
            return nil
        }

        let reassembled = session.reassemble()
        activeSessions.removeValue(forKey: info.chunkId)
        print("MessageChunkReassembler: Reassembled \(reassembled.count) bytes from \(info.totalChunks) chunks")
        return reassembled
    }

    func clear() {
        activeSessions.removeAll()
    }

    private func cleanupTimedOutSessions() {
        let now = Date().timeIntervalSince1970 * 1000
        activeSessions = activeSessions.filter { entry in
            now - entry.value.createdAtMs <= Self.chunkTimeoutMs
        }
    }

    private func removeOldestSession() {
        guard let oldest = activeSessions.min(by: { $0.value.createdAtMs < $1.value.createdAtMs }) else {
            return
        }
        activeSessions.removeValue(forKey: oldest.key)
    }

    private final class ChunkSession {
        let chunkId: String
        let totalChunks: Int
        let createdAtMs: TimeInterval
        private var chunks: [Int: String] = [:]

        init(chunkId: String, totalChunks: Int) {
            self.chunkId = chunkId
            self.totalChunks = totalChunks
            self.createdAtMs = Date().timeIntervalSince1970 * 1000
        }

        func addChunk(index: Int, data: String) -> Bool {
            guard index >= 0, index < totalChunks else {
                return false
            }
            chunks[index] = data
            return true
        }

        var isComplete: Bool {
            chunks.count == totalChunks
        }

        func reassemble() -> String {
            var result = ""
            for index in 0 ..< totalChunks {
                result += chunks[index] ?? ""
            }
            return result
        }
    }
}
