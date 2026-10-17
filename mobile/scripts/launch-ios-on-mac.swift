import AppKit
import CryptoKit
import Darwin

struct NimoBootstrapBirth: Codable, Equatable {
    let seconds: UInt64
    let microseconds: UInt64
}
struct NimoLaunchBootstrap: Codable {
    let version: Int
    let ownerAuditToken: String
    let ownerPid: Int32
    let ownerBirth: NimoBootstrapBirth
    let planSha256: String
    let grantSha256: String
    let bootstrapNonce: String
    let appExecutableSha256: String
    let appBundleId: String
}

/// Validates the one fixed fixture environment value, never arbitrary env pairs.
/// Runs before stopping or launching any application.
func validatedNimoBootstrap(_ text: String, bundleId: String, executableSha256: String,
                            parentPid: Int32, parentBirth: NimoBootstrapBirth) throws -> String {
    func invalid() -> Error { NSError(domain: "MentraLauncher", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid NIMO fixture bootstrap"] ) }
    guard text.utf8.count <= 4096, let bytes = text.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          Set(object.keys) == Set(["version","ownerPid","ownerAuditToken","ownerBirth","planSha256","grantSha256","bootstrapNonce","appExecutableSha256","appBundleId"]),
          let birth = object["ownerBirth"] as? [String: Any], Set(birth.keys) == Set(["seconds","microseconds"]) else { throw invalid() }
    let value = try JSONDecoder().decode(NimoLaunchBootstrap.self, from: bytes)
    guard value.version == 1, value.ownerPid > 1, value.ownerPid == parentPid, value.ownerBirth == parentBirth,
          value.appBundleId == bundleId, value.appExecutableSha256 == executableSha256,
          UUID(uuidString: value.bootstrapNonce)?.uuidString.lowercased() == value.bootstrapNonce,
          [value.planSha256,value.grantSha256,value.appExecutableSha256,value.ownerAuditToken].allSatisfy({ $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }) else { throw invalid() }
    return String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
}

#if !MENTRA_LAUNCHER_UNIT_TEST

@main
struct LaunchIOSOnMac {
    @MainActor
    static func main() async {
        do {
            try await launch()
        } catch {
            FileHandle.standardError.write(Data("Launch failed: \(error)\n".utf8))
            exit(1)
        }
    }

    @MainActor
    static func launch() async throws {
        let quitOnly = CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--quit"
        let passive = CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--permission-status"
        let nimo = CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--nimo-resource-bootstrap"
        guard CommandLine.arguments.count == 2 || quitOnly || passive || nimo else {
            throw NSError(domain: "MentraLauncher", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected a built .app path"])
        }
        let nonce = passive ? CommandLine.arguments[2] : nil
        if let nonce, nonce.range(of: "^[A-Za-z0-9_-]{1,120}$", options: .regularExpression) == nil {
            throw NSError(domain: "MentraLauncher", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid passive permission nonce"])
        }
        let url = URL(fileURLWithPath: CommandLine.arguments[passive || nimo ? 3 : quitOnly ? 2 : 1]).standardizedFileURL
        let innerURL = url.appendingPathComponent("WrappedBundle").resolvingSymlinksInPath()
        guard let bundle = Bundle(url: innerURL), let id = bundle.bundleIdentifier else {
            throw NSError(domain: "MentraLauncher", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot read app identity"])
        }
        var nimoBootstrap: String?
        if nimo {
            guard let executable = bundle.executableURL else { throw NSError(domain: "MentraLauncher", code: 5) }
            let bytes = try Data(contentsOf: executable, options: [.mappedIfSafe])
            guard bytes.count <= 256 * 1024 * 1024 else { throw NSError(domain: "MentraLauncher", code: 5) }
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let parent = getppid()
            var info = proc_bsdinfo()
            guard proc_pidinfo(parent, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout.size(ofValue: info))) == MemoryLayout<proc_bsdinfo>.size else { throw NSError(domain: "MentraLauncher", code: 5) }
            nimoBootstrap = try validatedNimoBootstrap(CommandLine.arguments[2], bundleId: id, executableSha256: digest,
                parentPid: parent, parentBirth: NimoBootstrapBirth(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec))
        }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let existing = NSRunningApplication.runningApplications(withBundleIdentifier: id)
        if nimo && !existing.isEmpty {
            throw NSError(domain: "MentraLauncher", code: 6, userInfo: [NSLocalizedDescriptionKey: "NIMO fixture launch requires an absent app; no existing process was stopped"])
        }
        for app in existing {
            guard app.terminate() else {
                throw NSError(domain: "MentraLauncher", code: 3, userInfo: [NSLocalizedDescriptionKey: "App refused normal termination"])
            }
        }
        let deadline = Date().addingTimeInterval(10)
        while existing.contains(where: { !$0.isTerminated }), Date() < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard existing.allSatisfy(\.isTerminated) else {
            throw NSError(domain: "MentraLauncher", code: 4, userInfo: [NSLocalizedDescriptionKey: "App did not terminate; no forced kill performed"])
        }
        if quitOnly {
            print("Stopped \(id) through normal application termination.")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        if let nimoBootstrap { configuration.environment = ["MENTRA_NIMO_RESOURCE_BOOTSTRAP": nimoBootstrap] }
        let timeout = Task { @MainActor in
            try await Task.sleep(for: .seconds(30))
            FileHandle.standardError.write(Data("Launch did not finish within 30 seconds. Inspect macOS setup permissions; no unrelated dialog was accepted.\n".utf8))
            exit(1)
        }
        defer { timeout.cancel() }
        let app: NSRunningApplication
        if let nonce {
            let request = URL(string: "com.mentra://test/permissions?request_id=\(nonce)")!
            app = try await NSWorkspace.shared.open([request], withApplicationAt: url, configuration: configuration)
        } else {
            app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        }
        print("Launched \(id) pid=\(app.processIdentifier) without requesting foreground activation.")
    }
}

#endif
