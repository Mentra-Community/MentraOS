import Foundation

enum SendOutcome {
    case delivered
    case retry
    case discard

    /// 2xx is delivered. A 4xx other than 408/429 means PostHog rejected this payload
    /// for good (bad key, malformed body) and retrying it would only block the queue.
    /// Everything else (5xx, 408, 429) is worth retrying later.
    static func fromHTTPStatus(_ code: Int) -> SendOutcome {
        switch code {
        case 200 ..< 300: return .delivered
        case 408, 429: return .retry
        case 400 ..< 500: return .discard
        default: return .retry
        }
    }
}

/// Bounded on-disk retry queue for analytics payloads whose upload failed.
/// One JSON object per line. Oldest entries are dropped past `maxEntries`; entries
/// older than `maxAge` are discarded on drain. Every payload carries its own
/// `uuid` and `timestamp`, so a retried event neither double counts nor moves in time.
///
/// Not thread-safe by itself: callers serialize access on the analytics transport queue.
final class BluetoothSdkAnalyticsQueue {
    static let defaultMaxEntries = 100
    static let defaultMaxAge: TimeInterval = 7 * 24 * 60 * 60
    static let fileName = "mentra_bluetooth_sdk_analytics_queue.jsonl"

    static func defaultFileURL(fileManager: FileManager = .default) -> URL? {
        guard let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return base.appendingPathComponent("MentraBluetoothSdk", isDirectory: true).appendingPathComponent(fileName)
    }

    private let fileURL: URL
    private let maxEntries: Int
    private let maxAge: TimeInterval

    init(fileURL: URL, maxEntries: Int = BluetoothSdkAnalyticsQueue.defaultMaxEntries, maxAge: TimeInterval = BluetoothSdkAnalyticsQueue.defaultMaxAge) {
        self.fileURL = fileURL
        self.maxEntries = maxEntries
        self.maxAge = maxAge
    }

    func enqueue(_ payload: [String: Any], now: Date) {
        var entries = read()
        entries.append(["enqueued_at": now.timeIntervalSince1970, "payload": payload])
        while entries.count > maxEntries {
            entries.removeFirst()
        }
        write(entries)
    }

    var count: Int {
        read().count
    }

    /// Sends queued payloads oldest-first through `send`. Delivered and permanently
    /// rejected entries are dropped; the first retryable failure stops the drain so
    /// ordering is preserved and a dead network does not burn through every entry.
    func drain(now: Date, send: ([String: Any]) -> SendOutcome) {
        let entries = read()
        guard !entries.isEmpty else { return }
        var remaining: [[String: Any]] = []
        var blocked = false
        for entry in entries {
            let enqueuedAt = (entry["enqueued_at"] as? TimeInterval) ?? now.timeIntervalSince1970
            if now.timeIntervalSince1970 - enqueuedAt > maxAge { continue }
            guard let payload = entry["payload"] as? [String: Any] else { continue }
            if blocked {
                remaining.append(entry)
                continue
            }
            if send(payload) == .retry {
                blocked = true
                remaining.append(entry)
            }
        }
        write(remaining)
    }

    private func read() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: fileURL), let text = String(data: data, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { line in
            guard !line.trimmingCharacters(in: .whitespaces).isEmpty,
                  let lineData = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
            else { return nil }
            return object
        }
    }

    private func write(_ entries: [[String: Any]]) {
        let fileManager = FileManager.default
        if entries.isEmpty {
            try? fileManager.removeItem(at: fileURL)
            return
        }
        do {
            try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            var lines: [String] = []
            for entry in entries {
                guard JSONSerialization.isValidJSONObject(entry),
                      let data = try? JSONSerialization.data(withJSONObject: entry),
                      let line = String(data: data, encoding: .utf8)
                else { continue }
                lines.append(line)
            }
            let text = lines.joined(separator: "\n") + "\n"
            try text.data(using: .utf8)?.write(to: fileURL, options: .atomic)
        } catch {
            // A queue write failure only loses retries, never live behavior.
        }
    }
}
