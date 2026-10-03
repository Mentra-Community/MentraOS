import Foundation

/// Observes glasses-owned streaming; delivery gaps never imply publisher failure.
final class StreamSessionState {
    private(set) var processSessionId: String?
    private(set) var currentStreamId: String?
    private(set) var supported = false
    private var revision: Int = -1

    func ready(sessionId: String?, controlVersion: Int?) {
        supported = controlVersion == 1 && !(sessionId ?? "").isEmpty
        if processSessionId != sessionId {
            currentStreamId = nil
            revision = -1
        }
        processSessionId = sessionId
    }

    func accept(_ values: [String: Any]) -> Bool {
        guard supported,
              let sid = values["sid"] as? String, sid == processSessionId,
              let incomingRevision = values["revision"] as? Int,
              incomingRevision >= revision
        else { return false }
        revision = incomingRevision
        currentStreamId = values["terminal"] as? Bool == true ? nil : values["streamId"] as? String
        return true
    }
}
