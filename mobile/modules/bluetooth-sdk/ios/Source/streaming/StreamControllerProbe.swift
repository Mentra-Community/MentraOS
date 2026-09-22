import CoreFoundation
import Foundation

/// Process-scoped native ownership survives BLE reconnects, not app termination.
enum StreamControllerProbe {
    static let controllerId = UUID().uuidString

    static func response(_ values: [String: Any]) -> [String: Any]? {
        guard let version = values["protocolVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              values["controllerId"] as? String == controllerId,
              let streamId = values["streamId"] as? String, !streamId.isEmpty,
              let probeId = values["probeId"] as? String, !probeId.isEmpty
        else { return nil }
        return ["type": "stream_controller_response", "protocolVersion": 1,
                "controllerId": controllerId, "streamId": streamId, "probeId": probeId]
    }
}
