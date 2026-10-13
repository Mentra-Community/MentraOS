import Foundation

enum MacHotspotJoinStage: String {
    case authorization = "location_authorization"
    case interface = "wifi_interface"
    case scan
    case association
    case membership = "network_membership"
    case address = "address_verification"
    case localAccess = "local_network_access"
}

/// One join's diagnostics, shared by its owner queue, main-thread authorization
/// and blocking CoreWLAN worker. Never accepts network identities or credentials.
final class MacHotspotJoinDiagnostics {
    private let lock = NSLock()
    private var stage = MacHotspotJoinStage.authorization
    private var authorization: Int?
    private var terminal = false
    private let generation: Int
    private let emit: (String) -> Void

    init(generation: Int, emit: @escaping (String) -> Void) {
        self.generation = generation
        self.emit = emit
    }

    func begin(_ stage: MacHotspotJoinStage) {
        record("start", stage: stage)
    }

    func authorizationStatus(_ value: Int, requested: Bool = false, initial: Bool = false) {
        let event = requested ? "authorization_request" : initial ? "authorization_initial" : "authorization_change"
        record(event, authorization: value)
    }

    func result(error: Error? = nil, interface: String? = nil) {
        record(error == nil ? "accepted" : "failed", error: error, interface: interface)
    }

    func finish(error: Error? = nil) {
        record(error == nil ? "complete" : "failed", error: error, finish: true)
    }

    func timeout() -> LocalMediaError {
        lock.lock()
        let pending = stage.rawValue
        let status = authorization.map(String.init) ?? "unknown"
        let late = terminal
        terminal = true
        var facts: [String: Any] = ["event": "timeout", "stage": pending,
                                    "generation": generation, "late": late]
        if let authorization { facts["authorization"] = authorization }
        lock.unlock()
        let failure = LocalMediaError("Mac hotspot join timed out (stage=\(pending), authorization=\(status))")
        write(facts, error: failure)
        return failure
    }

    private func record(_ event: String, stage next: MacHotspotJoinStage? = nil,
                        authorization value: Int? = nil, error: Error? = nil,
                        interface: String? = nil, finish: Bool = false) {
        lock.lock()
        // A late blocking result may supply native error facts, but cannot
        // replace the stage at which this join timed out or completed.
        let late = terminal
        if !terminal {
            if let next { stage = next }
            if let value { authorization = value }
            if finish { terminal = true }
        }
        var facts: [String: Any] = ["event": event, "stage": stage.rawValue,
                                    "generation": generation, "late": late]
        if let authorization { facts["authorization"] = authorization }
        lock.unlock()
        write(facts, error: error, interface: interface)
    }

    private func write(_ recorded: [String: Any], error: Error? = nil, interface: String? = nil) {
        var facts = recorded
        if let interface, interface.range(of: "^[A-Za-z][A-Za-z0-9_-]{0,15}$", options: .regularExpression) != nil {
            facts["interface"] = interface
        }
        if let error {
            if let owned = error as? LocalMediaError {
                facts["owned_error"] = HotspotJoinFailure(owned).message
            } else {
                let native = error as NSError
                facts["domain"] = Self.domain(native.domain)
                facts["code"] = native.code
                if let underlying = native.userInfo[NSUnderlyingErrorKey] as? NSError {
                    facts["underlying_domain"] = Self.domain(underlying.domain)
                    facts["underlying_code"] = underlying.code
                }
            }
        }
        if let data = try? JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys]),
           let message = String(data: data, encoding: .utf8) { emit(message) }
    }

    private static func domain(_ value: String) -> String {
        value.range(of: "^[A-Za-z0-9_.-]{1,128}$", options: .regularExpression) == nil ? "unavailable" : value
    }
}
