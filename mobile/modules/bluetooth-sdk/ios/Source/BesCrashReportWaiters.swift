import Foundation

/// Correlates `bes_crash_reported` commands with the glasses' `bes_crash_reported_ack`.
///
/// Each call owns one waiter keyed by (incidentKey, reportId), so concurrent reports for
/// different incidents, or a stale ack for an earlier reportId, never settle each other.
@MainActor
final class BesCrashReportWaiters {
    @MainActor
    private final class Waiter {
        let incidentKey: String
        let reportId: String
        let pending: PendingResponse<Void>

        init(incidentKey: String, reportId: String) {
            self.incidentKey = incidentKey
            self.reportId = reportId
            pending = PendingResponse<Void>(operation: "bes_crash_reported for \(incidentKey)")
        }
    }

    private var waiters: [Waiter] = []

    /// Registers before `send` so an immediate ack cannot be missed.
    func report(incidentKey: String, reportId: String, timeoutMs: Int, send: () throws -> Void) async throws {
        let waiter = Waiter(incidentKey: incidentKey, reportId: reportId)
        waiters.append(waiter)
        defer { waiters.removeAll { $0 === waiter } }
        try send()
        try await waiter.pending.wait(timeoutMs: timeoutMs)
    }

    /// Settles the waiters this ack answers. `ok:true` must echo the reportId; an `ok:false`
    /// without a reportId rejects every waiter for that incidentKey. Returns the number settled.
    @discardableResult
    func onAck(_ values: [String: Any]) -> Int {
        guard let incidentKey = values["incidentKey"] as? String else { return 0 }
        let reportId = (values["reportId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let ok = values["ok"] as? Bool == true
        let matched = waiters.filter {
            $0.incidentKey == incidentKey && ($0.reportId == reportId || (!ok && reportId == nil))
        }
        if ok {
            for waiter in matched {
                waiter.pending.resolve(())
            }
        } else {
            let error = (values["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "unknown_error"
            for waiter in matched {
                waiter.pending.reject(BluetoothSdkError(
                    code: "bes_crash_report_rejected",
                    message: "Glasses rejected bes_crash_reported for \(incidentKey): \(error)"
                ))
            }
        }
        return matched.count
    }

    func rejectAll(_ error: Error) {
        for waiter in waiters {
            waiter.pending.reject(error)
        }
    }
}
