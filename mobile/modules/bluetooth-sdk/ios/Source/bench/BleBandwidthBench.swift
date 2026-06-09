import Foundation

/// Debug-only BLE photo bandwidth benchmark after fully connected (settings sync dispatched).
/// Filter logs: `BLE_BANDWIDTH_BENCH`
enum BleBandwidthBench {
    static let logPrefix = "BLE_BANDWIDTH_BENCH"

    static let defaultInitialDelayNanos: UInt64 = 10_000_000_000
    static let defaultRetryDelayNanos: UInt64 = 5_000_000_000
    static let defaultMaxAttempts = 8

    private static var succeededThisProcess = false
    private static var scheduledThisConnection = false
    private static var attemptCount = 0

    #if DEBUG
    static var isEnabled: Bool {
        if let flag = DeviceStore.shared.get("bluetooth", "ble_bandwidth_bench_enabled") as? Bool, !flag {
            return false
        }
        return true
    }
    #else
    static var isEnabled: Bool { false }
    #endif

    static var runEveryConnect: Bool {
        DeviceStore.shared.get("bluetooth", "ble_bandwidth_bench_every_connect") as? Bool ?? false
    }

    static func shouldSchedule() -> Bool {
        guard isEnabled else { return false }
        if runEveryConnect { return true }
        return !succeededThisProcess
    }

    static func markSucceeded() {
        succeededThisProcess = true
    }

    static func resetScheduleState() {
        scheduledThisConnection = false
        attemptCount = 0
    }

    static var attemptCountForLogging: Int { attemptCount }

    static func beginAttempt() -> Int {
        attemptCount += 1
        return attemptCount
    }

    static var maxAttempts: Int {
        if let value = DeviceStore.shared.get("bluetooth", "ble_bandwidth_bench_max_attempts") as? Int,
           value >= 1
        {
            return value
        }
        return defaultMaxAttempts
    }

    static var retryDelayNanos: UInt64 {
        if let value = DeviceStore.shared.get("bluetooth", "ble_bandwidth_bench_retry_delay_ms") as? Int,
           value >= 0
        {
            return UInt64(value) * 1_000_000
        }
        return defaultRetryDelayNanos
    }

    static var initialDelayNanos: UInt64 {
        if let value = DeviceStore.shared.get("bluetooth", "ble_bandwidth_bench_initial_delay_ms") as? Int,
           value >= 0
        {
            return UInt64(value) * 1_000_000
        }
        return defaultInitialDelayNanos
    }

    static func canRetryAfterFailure() -> Bool {
        attemptCount < maxAttempts
    }

    static func isRetryableError(errorCode: String?, errorMessage: String?) -> Bool {
        if let errorCode, !errorCode.isEmpty {
            if errorCode.uppercased() == "CAMERA_BUSY" {
                return true
            }
        }
        if let errorMessage, !errorMessage.isEmpty {
            let msg = errorMessage.lowercased()
            if msg.contains("camera restarting")
                || msg.contains("camera busy")
                || msg.contains("hal restart")
                || msg.contains("fov change")
            {
                return true
            }
        }
        return false
    }

    static var photoSize: String {
        if let size = DeviceStore.shared.get("bluetooth", "ble_bandwidth_bench_size") as? String,
           !size.isEmpty
        {
            return size
        }
        return "max"
    }

    static func isBenchRequestId(_ requestId: String?) -> Bool {
        guard let requestId else { return false }
        return requestId.hasPrefix("ble-bench-")
    }

    @discardableResult
    static func scheduleAfterFullyConnected(_ trigger: @escaping () -> Void) -> Bool {
        guard shouldSchedule(), !scheduledThisConnection else { return false }
        scheduledThisConnection = true
        attemptCount = 0
        let delaySec = Double(initialDelayNanos) / 1_000_000_000
        Bridge.log(
            "LIVE: 📊 \(logPrefix) scheduled in \(Int(delaySec))s after fully connected (maxAttempts=\(maxAttempts))"
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + delaySec) {
            trigger()
        }
        return true
    }
}
