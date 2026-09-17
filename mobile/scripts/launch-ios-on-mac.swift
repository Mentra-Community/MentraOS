import AppKit

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
        guard CommandLine.arguments.count == 2 || quitOnly else {
            throw NSError(domain: "MentraLauncher", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected a built .app path"])
        }
        let url = URL(fileURLWithPath: CommandLine.arguments[quitOnly ? 2 : 1]).standardizedFileURL
        let innerURL = url.appendingPathComponent("WrappedBundle").resolvingSymlinksInPath()
        guard let bundle = Bundle(url: innerURL), let id = bundle.bundleIdentifier else {
            throw NSError(domain: "MentraLauncher", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot read app identity"])
        }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let existing = NSRunningApplication.runningApplications(withBundleIdentifier: id)
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
        let timeout = Task { @MainActor in
            try await Task.sleep(for: .seconds(30))
            FileHandle.standardError.write(Data("Launch did not finish within 30 seconds. Inspect macOS setup permissions; no unrelated dialog was accepted.\n".utf8))
            exit(1)
        }
        defer { timeout.cancel() }
        let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        print("Launched \(id) pid=\(app.processIdentifier) without requesting foreground activation.")
    }
}
