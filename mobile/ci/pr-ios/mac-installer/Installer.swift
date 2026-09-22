import AppKit

struct InstallerOptions {
    var package: URL?
    var verifyOnly = false
    var launch = true
    var retained = false
    var requests: [URL] = []

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
            case "--retained": options.retained = true
            case "--request":
                guard let value = arguments.next(), let url = URL(string: value) else {
                    throw InstallerError.invalid("--request requires a Mentra PR installation link.")
                }
                _ = try InstallRequest(url: url)
                options.requests.append(url)
            default:
                guard argument.hasPrefix("-psn_") else { throw InstallerError.invalid("Unknown option: \(argument)") }
            }
        }
        guard options.package != nil || (!options.verifyOnly && options.launch) else {
            throw InstallerError.invalid("Use --package DIRECTORY with --verify-only or --no-launch.")
        }
        guard options.package == nil || (!options.retained && options.requests.isEmpty) else {
            throw InstallerError.invalid("Do not combine local package verification with PR-link requests.")
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
    private var busy = false
    private var initialized = false
    private var handingOff = false
    private var pending: [URL] = []
    private var activeRequest: URL?
    private var persistentSession: Bool
    private var window: NSWindow?
    private let titleLabel = NSTextField(labelWithString: "Install Mentra")
    private let buildLabel = NSTextField(wrappingLabelWithString: "")
    private let statusLabel = NSTextField(wrappingLabelWithString: "Checking the downloaded build…")
    private let chooseButton = NSButton(title: "Choose Folder…", target: nil, action: nil)
    private let installButton = NSButton(title: "Install & Open", target: nil, action: nil)

    init(options: InstallerOptions) {
        self.options = options
        persistentSession = options.retained || Bundle.main.bundleURL.path == InstallerHost.application.path
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
                guard manifest.packageVersion == 2 else {
                    throw InstallerError.invalid("The bootstrap installer is not bound to a version 2 Mac package.")
                }
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
                makeWindow(manifest: persistentSession ? nil : manifest, show: !options.retained)
                initialized = true
                pending.append(contentsOf: options.requests)
                if !pending.isEmpty {
                    processNextRequest()
                    return
                }
                if persistentSession {
                    statusLabel.stringValue = "Ready. Click Install on Mac in #pr-builds to install and open that build. Downloads stay in a temporary installer cache."
                    return
                }
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

    private func makeWindow(manifest: BuildManifest?, show: Bool) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 550, height: 360),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Install Mentra"
        window.isReleasedWhenClosed = false
        titleLabel.font = .systemFont(ofSize: 24, weight: .semibold)
        buildLabel.stringValue = manifest?.summary ?? "Ready for #pr-builds links"
        buildLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.isSelectable = true
        let explanation = NSTextField(wrappingLabelWithString: "Keeps one Mentra App in ~/Applications/Mentra E2E and preserves its data. First-time setup also retains this installer in ~/Applications for future PR links. macOS may ask for developer trust or Bluetooth the first time.")
        explanation.textColor = .secondaryLabelColor
        chooseButton.target = self
        chooseButton.action = #selector(chooseFolder)
        chooseButton.isHidden = persistentSession
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
        self.window = window
        if show { showWindow() }
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
        self.busy = busy
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
        processNextRequest()
    }

    @objc private func installOrOpen() {
        guard !busy else { return }
        Task {
            setBusy(true)
            defer {
                replacing = false
                window?.standardWindowButton(.closeButton)?.isEnabled = true
                setBusy(false)
                processNextRequest()
            }
            do {
                var permanentHelper: URL?
                if !persistentSession {
                    setReplacing(true)
                    let source = Bundle.main.bundleURL
                    statusLabel.stringValue = "Setting up the permanent installer for future #pr-builds links…"
                    permanentHelper = try await Task.detached { try InstallerHost.retain(source) }.value
                }
                if installed == nil, let candidate = verified {
                    try await installCandidate(candidate)
                }
                await openInstalled()
                if let permanentHelper {
                    try await handoff(to: permanentHelper, requests: pending)
                }
            } catch {
                handingOff = false
                pending.removeAll()
                statusLabel.stringValue = error.localizedDescription
            }
        }
    }

    private func setReplacing(_ value: Bool) {
        replacing = value
        window?.standardWindowButton(.closeButton)?.isEnabled = !value
    }

    private func installCandidate(_ candidate: VerifiedBuild) async throws {
        setReplacing(true)
        defer { setReplacing(false) }
        statusLabel.stringValue = "Installing Mentra and preserving your app data…"
        installed = try await Task.detached {
            try await install(candidate) { try await quitMentraNormally() }
        }.value
    }

    private func openInstalled() async {
        guard let installed else { return }
        installButton.title = "Open Mentra"
        statusLabel.stringValue = "Mentra is installed. Approve any macOS developer trust or Bluetooth request to finish first-time setup."
        do { try await openMentra(installed) }
        catch { statusLabel.stringValue = "Mentra is installed, but macOS did not open it. \(error.localizedDescription) You can finish first-time setup and click Open Mentra again." }
    }

    private func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows _: Bool) -> Bool {
        showWindow()
        return true
    }

    func application(_: NSApplication, open urls: [URL]) {
        do {
            guard !handingOff else {
                throw InstallerError.invalid("The installer is finishing first-time setup. Click the PR link again in a moment.")
            }
            for url in urls {
                _ = try InstallRequest(url: url)
                if activeRequest == url || pending.contains(url) { continue }
                guard pending.count < 8 else { throw InstallerError.invalid("The installer already has several builds queued. Wait for them to finish before clicking another link.") }
                pending.append(url)
            }
            if initialized { processNextRequest() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Cannot open this Mentra PR link"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    private func processNextRequest() {
        guard initialized, !busy, !pending.isEmpty else { return }
        showWindow()
        if !persistentSession {
            // URL dispatch can target the downloaded copy during bootstrap.
            // Hand the exact request to the retained copy, then exit this one.
            setBusy(true)
            setReplacing(true)
            handingOff = true
            Task {
                do {
                    let source = Bundle.main.bundleURL
                    let helper = try await Task.detached { try InstallerHost.retain(source) }.value
                    try await handoff(to: helper, requests: pending)
                } catch {
                    handingOff = false
                    pending.removeAll()
                    statusLabel.stringValue = error.localizedDescription
                    setReplacing(false)
                    setBusy(false)
                }
            }
            return
        }
        let url = pending.removeFirst()
        activeRequest = url
        setBusy(true)
        verified = nil
        installed = nil
        installButton.title = "Install & Open"
        Task {
            var prepared: VerifiedBuild?
            var retainRecovery = false
            do {
                let request = try InstallRequest(url: url)
                buildLabel.stringValue = request.summary
                statusLabel.stringValue = "Downloading and verifying the selected PR build…"
                let candidate = try await preparePackage(request)
                prepared = candidate
                buildLabel.stringValue = candidate.manifest.summary
                try await installCandidate(candidate)
                await openInstalled()
            } catch {
                if case InstallerError.recovery = error { retainRecovery = true }
                statusLabel.stringValue = error.localizedDescription
            }
            if let prepared, !retainRecovery {
                do { try cleanupPackage(prepared) }
                catch { statusLabel.stringValue += " The owned download cache could not be removed: \(error.localizedDescription)" }
            }
            activeRequest = nil
            setBusy(false)
            processNextRequest()
        }
    }

    private func handoff(to helper: URL, requests: [URL]) async throws {
        handingOff = true
        let ownedHash = try InstallerHost.verify(helper)
        var matches: [NSRunningApplication] = []
        for application in NSRunningApplication.runningApplications(withBundleIdentifier: InstallerHost.bundleID)
            where application.processIdentifier != ProcessInfo.processInfo.processIdentifier && !application.isTerminated
        {
            // App Translocation changes bundleURL even for the retained copy.
            // Match the complete signed executable to the owned installation,
            // then target the running app's public URL instead of guessing its
            // physical location or starting another copy behind a macOS prompt.
            guard application.isFinishedLaunching, let bundle = application.bundleURL else {
                throw InstallerError.invalid("Another Mentra installer is still starting. Finish its macOS setup prompt, or quit it, before trying the link again.")
            }
            guard let resolved = realpath(bundle.path, nil) else {
                throw InstallerError.invalid("Cannot verify the running Mentra installer. Quit it before trying this link again.")
            }
            let canonical = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
            free(resolved)
            guard try InstallerHost.verify(canonical) == ownedHash else {
                throw InstallerError.invalid("A different Mentra installer is already running. Quit it before continuing.")
            }
            matches.append(application)
        }
        guard matches.count <= 1 else { throw InstallerError.invalid("More than one Mentra installer is running. Quit the extra copies before trying this link again.") }
        let existing = matches.first
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = !requests.isEmpty
        if let existing {
            if !requests.isEmpty { _ = try await NSWorkspace.shared.open(requests, withApplicationAt: existing.bundleURL!, configuration: configuration) }
        } else {
            configuration.createsNewApplicationInstance = true
            configuration.arguments = ["--retained"] + requests.flatMap { ["--request", $0.absoluteString] }
            _ = try await NSWorkspace.shared.openApplication(at: helper, configuration: configuration)
        }
        pending.removeAll()
        setReplacing(false)
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        // Finish the filesystem transaction before allowing Cmd-Q or logout to
        // exit the GUI. A crash still leaves its lock and recovery files intact.
        replacing ? .terminateCancel : .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        !persistentSession
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
