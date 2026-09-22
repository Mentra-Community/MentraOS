import AppKit

struct InstallerOptions {
    var package: URL?
    var verifyOnly = false
    var launch = true

    static func parse(_ arguments: [String]) throws -> Self {
        var options = Self()
        var arguments = arguments.makeIterator()
        while let argument = arguments.next() {
            switch argument {
            case "--package":
                guard options.package == nil, let path = arguments.next(), path.hasPrefix("/") else {
                    throw InstallerError.invalid("--package requires an absolute directory path.")
                }
                options.package = URL(fileURLWithPath: path, isDirectory: true)
            case "--verify-only": options.verifyOnly = true
            case "--no-launch": options.launch = false
            default:
                guard argument.hasPrefix("-psn_") else { throw InstallerError.invalid("Unknown option: \(argument)") }
            }
        }
        guard options.package != nil || (!options.verifyOnly && options.launch) else {
            throw InstallerError.invalid("Use --package DIRECTORY with --verify-only or --no-launch.")
        }
        return options
    }
}

@MainActor
func quitMentraNormally() async throws {
    let existing = NSRunningApplication.runningApplications(withBundleIdentifier: BuildManifest.bundleID)
    for application in existing where !application.isTerminated {
        guard application.terminate() else {
            throw InstallerError.invalid("Mentra did not accept a normal quit request. Close Mentra yourself and try Install again. No app was force-quit.")
        }
    }
    let deadline = Date().addingTimeInterval(10)
    while existing.contains(where: { !$0.isTerminated }), Date() < deadline {
        try await Task.sleep(for: .milliseconds(100))
    }
    guard existing.allSatisfy(\.isTerminated) else {
        throw InstallerError.invalid("Mentra is still closing. Close it yourself and try Install again. Your current installation has not been replaced.")
    }
}

@MainActor
func openMentra(_ url: URL) async throws {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
}

@MainActor
final class InstallerDelegate: NSObject, NSApplicationDelegate {
    let options: InstallerOptions
    private var expected = Data()
    private var verified: VerifiedBuild?
    private var installed: URL?
    private var replacing = false
    private var window: NSWindow?
    private let titleLabel = NSTextField(labelWithString: "Install Mentra")
    private let buildLabel = NSTextField(wrappingLabelWithString: "")
    private let statusLabel = NSTextField(wrappingLabelWithString: "Checking the downloaded build…")
    private let chooseButton = NSButton(title: "Choose Folder…", target: nil, action: nil)
    private let installButton = NSButton(title: "Install & Open", target: nil, action: nil)

    init(options: InstallerOptions) {
        self.options = options
    }

    func applicationDidFinishLaunching(_: Notification) {
        Task {
            do {
                guard let resource = Bundle.main.resourceURL?.appendingPathComponent("build.json") else {
                    throw InstallerError.invalid("The installer is missing its signed build manifest. Download a fresh Mac ZIP.")
                }
                // The installer may be translocated by Gatekeeper. Read its own
                // signed resource normally; never try to disable translocation.
                expected = try Data(contentsOf: resource)
                let manifest = try BuildManifest(data: expected)
                if let directory = options.package {
                    let expected = expected
                    let candidate = try await Task.detached { try verifyPackage(directory, expected: expected) }.value
                    if options.verifyOnly {
                        print("Verified \(candidate.manifest.summary.replacingOccurrences(of: "\n", with: "; "))")
                    } else {
                        let destination = try await Task.detached {
                            try await install(candidate) { try await quitMentraNormally() }
                        }.value
                        print("Installed app: \(destination.path)")
                        if options.launch { try await openMentra(destination) }
                    }
                    NSApp.terminate(nil)
                    return
                }
                makeWindow(manifest: manifest)
                let sibling = Bundle.main.bundleURL.deletingLastPathComponent()
                if InstallerFiles.exists(sibling.appendingPathComponent("build.json")) {
                    await validate(sibling)
                } else {
                    statusLabel.stringValue = "Choose the extracted Mentra PR folder to verify this build. macOS can open this installer separately from the other files in your download."
                    chooseFolder()
                }
            } catch {
                if options.package != nil {
                    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
                    exit(1)
                }
                let alert = NSAlert()
                alert.messageText = "Cannot open the Mentra installer"
                alert.informativeText = error.localizedDescription
                alert.alertStyle = .warning
                alert.runModal()
                NSApp.terminate(nil)
            }
        }
    }

    private func makeWindow(manifest: BuildManifest) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 550, height: 360),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Install Mentra"
        window.isReleasedWhenClosed = false
        titleLabel.font = .systemFont(ofSize: 24, weight: .semibold)
        buildLabel.stringValue = manifest.summary
        buildLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.isSelectable = true
        let explanation = NSTextField(wrappingLabelWithString: "Installs in ~/Applications/Mentra E2E and preserves your app data. Mentra will close normally before replacement. macOS may ask you to trust Mentra or allow Bluetooth the first time.")
        explanation.textColor = .secondaryLabelColor
        chooseButton.target = self
        chooseButton.action = #selector(chooseFolder)
        installButton.target = self
        installButton.action = #selector(installOrOpen)
        installButton.keyEquivalent = "\r"
        installButton.isEnabled = false
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [chooseButton, spacer, installButton])
        buttons.orientation = .horizontal
        let stack = NSStackView(views: [titleLabel, buildLabel, statusLabel, explanation, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            statusLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    @objc private func chooseFolder() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose the Mentra PR folder you downloaded"
        panel.message = "Select the extracted folder containing Install Mentra.app, Mentra.app and build.json."
        panel.prompt = "Choose"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let directory = panel.url else { return }
            Task { await self?.validate(directory) }
        }
    }

    private func setBusy(_ busy: Bool) {
        chooseButton.isEnabled = !busy
        installButton.isEnabled = !busy && (verified != nil || installed != nil)
    }

    private func validate(_ directory: URL) async {
        verified = nil
        installed = nil
        installButton.title = "Install & Open"
        setBusy(true)
        statusLabel.stringValue = "Verifying the app signature, build contents and this Mac's registration…"
        do {
            let expected = expected
            verified = try await Task.detached { try verifyPackage(directory, expected: expected) }.value
            statusLabel.stringValue = "Ready to install. The app matches this download and this Mac is registered for the build."
        } catch { statusLabel.stringValue = error.localizedDescription }
        setBusy(false)
    }

    @objc private func installOrOpen() {
        Task {
            setBusy(true)
            defer {
                replacing = false
                window?.standardWindowButton(.closeButton)?.isEnabled = true
                setBusy(false)
            }
            do {
                if installed == nil, let candidate = verified {
                    replacing = true
                    window?.standardWindowButton(.closeButton)?.isEnabled = false
                    statusLabel.stringValue = "Installing Mentra and preserving your app data…"
                    installed = try await Task.detached {
                        try await install(candidate) { try await quitMentraNormally() }
                    }.value
                    replacing = false
                    window?.standardWindowButton(.closeButton)?.isEnabled = true
                }
                if let installed {
                    installButton.title = "Open Mentra"
                    statusLabel.stringValue = "Mentra is installed. Approve any macOS developer trust or Bluetooth request to finish first-time setup."
                    do { try await openMentra(installed) }
                    catch { statusLabel.stringValue = "Mentra is installed, but macOS did not open it. \(error.localizedDescription) You can finish first-time setup and click Open Mentra again." }
                }
            } catch { statusLabel.stringValue = error.localizedDescription }
        }
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        // Finish the filesystem transaction before allowing Cmd-Q or logout to
        // exit the GUI. A crash still leaves its lock and recovery files intact.
        replacing ? .terminateCancel : .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        true
    }
}

@main
struct MentraInstaller {
    @MainActor
    static func main() {
        if CommandLine.arguments.dropFirst().contains("--help") {
            print("Open Install Mentra.app, or run its Contents/MacOS/Installer --package /absolute/directory [--verify-only | --no-launch].")
            return
        }
        do {
            let options = try InstallerOptions.parse(Array(CommandLine.arguments.dropFirst()))
            let app = NSApplication.shared
            app.setActivationPolicy(options.package == nil ? .regular : .prohibited)
            if options.package == nil {
                let menu = NSMenu()
                let applicationItem = NSMenuItem()
                let applicationMenu = NSMenu(title: "Install Mentra")
                let quitItem = NSMenuItem(title: "Quit Install Mentra", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
                quitItem.target = app
                applicationMenu.addItem(quitItem)
                applicationItem.submenu = applicationMenu
                menu.addItem(applicationItem)
                app.mainMenu = menu
            }
            let delegate = InstallerDelegate(options: options)
            app.delegate = delegate
            withExtendedLifetime(delegate) { app.run() }
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }
}
