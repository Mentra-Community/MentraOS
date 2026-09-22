import AppKit

/// Launch only the signed Mentra test build. Does not activate windows, synthesize
/// input or interact with system permission dialogs. The parent owns network proof.
@main
struct LaunchWithNetworkLease {
    @MainActor
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else { fatalError("Expected app wrapper and lease JSON file") }
        let url = URL(fileURLWithPath: CommandLine.arguments[1])
        let inner = url.appendingPathComponent("WrappedBundle").resolvingSymlinksInPath()
        guard Bundle(url: inner)?.bundleIdentifier == "com.mentra.mentra" else { fatalError("Wrong app") }
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        guard let lease = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              lease["ssid"] is String, lease["address"] is String, lease["gateway"] is String,
              let issuedAt = lease["issuedAt"] as? Double,
              (0 ... 300).contains(Date().timeIntervalSince1970 - issuedAt),
              let payload = String(data: data, encoding: .utf8) else { fatalError("Invalid or expired lease") }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let old = NSRunningApplication.runningApplications(withBundleIdentifier: "com.mentra.mentra")
        for app in old { guard app.terminate() else { fatalError("App refused termination") } }
        let deadline = Date().addingTimeInterval(10)
        while old.contains(where: { !$0.isTerminated }), Date() < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard old.allSatisfy({ $0.isTerminated }) else { fatalError("App did not terminate") }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.environment = ["MENTRA_E2E_PREJOINED_HOTSPOT": payload]
        let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        print("Launched Mentra test build pid=\(app.processIdentifier); activation disabled; native association untested")
    }
}
