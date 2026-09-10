import Foundation

/// Desired notification-centre controls. Submission does not imply firmware acknowledgement.
public struct NativeNotificationConfig: Equatable, Sendable {
    public var enabled: Bool
    public var autoDisplay: Bool
    public var durationSeconds: Int
    public var doNotDisturb: Bool
    public var blockedApps: [String]

    public init(enabled: Bool = false, autoDisplay: Bool = true, durationSeconds: Int = 5, doNotDisturb: Bool = false, blockedApps: [String] = []) {
        self.enabled = enabled
        self.autoDisplay = autoDisplay
        self.durationSeconds = durationSeconds
        self.doNotDisturb = doNotDisturb
        self.blockedApps = blockedApps
    }

    func validate() throws {
        guard (1 ... 30).contains(durationSeconds) else { throw NativeNotificationError.invalidDuration }
    }

    func validateForAncs() throws {
        try validate()
        guard blockedApps.isEmpty else { throw NativeNotificationError.unsupported }
    }

    var dictionary: [String: Any] {
        ["enabled": enabled, "autoDisplay": autoDisplay, "durationSeconds": durationSeconds, "doNotDisturb": doNotDisturb, "blockedApps": blockedApps]
    }
}

public enum NativeNotificationError: Error {
    case unsupported
    case notConnected
    case invalidDuration
}

public struct NativeNotificationStatus: Sendable {
    public let supported: Bool
    public let source: String
    public let authorization: String
    public let state: String
    public let config: NativeNotificationConfig
    public let error: String

    static let unavailable = NativeNotificationStatus(supported: false, source: "unsupported", authorization: "unknown", state: "unavailable", config: .init(), error: "")

    var dictionary: [String: Any] {
        ["supported": supported, "source": source, "authorization": authorization, "state": state, "config": config.dictionary, "error": error]
    }
}
