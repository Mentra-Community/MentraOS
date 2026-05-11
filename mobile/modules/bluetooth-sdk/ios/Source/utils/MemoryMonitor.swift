//
//  MemoryMonitor.swift
//  MentraOS
//
//  Memory usage monitoring for leak detection
//

import Foundation

class MemoryMonitor {
    private static var timer: Timer?
    private static var startMemoryMB: Double = 0

    static func start(intervalSeconds: TimeInterval = 30) {
        stop()
        startMemoryMB = currentMemoryMB()
        Bridge.log("📊 Memory Monitor started - baseline: \(String(format: "%.1f", startMemoryMB)) MB")

        DispatchQueue.main.async {
            timer = Timer.scheduledTimer(withTimeInterval: intervalSeconds, repeats: true) { _ in
                let current = currentMemoryMB()
                let delta = current - startMemoryMB
                let trend = delta > 50 ? "🔴" : delta > 20 ? "🟡" : "⚪"
                Bridge.log("📊 Memory: \(String(format: "%.1f", current)) MB (Δ \(String(format: "%+.1f", delta)) MB) \(trend)")
            }
        }
    }

    static func stop() {
        timer?.invalidate()
        timer = nil
    }

    static func currentMemoryMB() -> Double {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Double(info.resident_size) / 1024 / 1024 : 0
    }
}
