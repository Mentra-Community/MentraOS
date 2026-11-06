import Foundation

/// The console plus the app's JavaScript console, which bug reports upload. glasses-media and
/// acs-meeting log through it, so the hotspot, relay, ingest and ACS traces reach a report.
public enum MediaLog {
    /// Set by `GlassesMediaRelayModule` while it exists.
    public static var sink: ((String) -> Void)?

    public static func log(_ message: String) {
        NSLog("%@", message)
        sink?(message)
    }
}
