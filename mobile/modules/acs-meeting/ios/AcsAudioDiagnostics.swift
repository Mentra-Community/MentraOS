import Foundation
import os

/// Per-call, bounded log output. Only counts and PCM peak magnitude are retained,
/// never microphone samples, tokens, meeting URLs or participant identities.
final class AcsAudioDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private let logger = Logger(subsystem: "com.mentra.acs", category: "audio-flow")
    private let id = String(UUID().uuidString.prefix(8))
    private var counts: [String: Int] = [:]
    private var peaks: [String: Int] = [:]
    private var finished = false

    func record(_ stage: String, pcm: Data? = nil) {
        var peak = 0
        if let pcm {
            pcm.withUnsafeBytes { raw in
                let bytes = raw.bindMemory(to: UInt8.self)
                for i in stride(from: 0, to: bytes.count - 1, by: 2) {
                    let bits = UInt16(bytes[i]) | (UInt16(bytes[i + 1]) << 8)
                    peak = max(peak, abs(Int(Int16(bitPattern: bits))))
                }
            }
        }
        lock.lock()
        guard !finished else { lock.unlock(); return }
        let first = counts[stage] == nil
        counts[stage, default: 0] += 1
        peaks[stage] = max(peaks[stage] ?? 0, peak)
        lock.unlock()
        if first {
            let callID = id
            logger.info("ACS_AUDIO id=\(callID, privacy: .public) first=\(stage, privacy: .public) bytes=\(pcm?.count ?? 0) peak=\(peak)")
        }
    }

    func finish() {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let snapshot: [String: Any] = ["counts": counts, "maxPeak": peaks]
        lock.unlock()
        let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
        let summary = data.flatMap { String(data: $0, encoding: .utf8) } ?? "unavailable"
        let callID = id
        // This is the leave request, not a claim that pending sends completed.
        logger.info("ACS_AUDIO id=\(callID, privacy: .public) leave_requested=\(summary, privacy: .public)")
    }
}
