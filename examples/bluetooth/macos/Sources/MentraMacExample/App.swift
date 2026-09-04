import AppKit
import MentraBluetoothSDK

@main
@MainActor
struct MentraMacExample {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, MentraBluetoothSDKDelegate {
    private let sdk = MentraBluetoothSDK()
    private var window: NSWindow!
    private let picker = NSPopUpButton()
    private let status = NSTextField(wrappingLabelWithString: "Disconnected")
    private let action = NSTextField(wrappingLabelWithString: "")
    private let webhook = NSTextField(string: "")
    private let preview = NSImageView()
    private var devices: [Device] = []
    private var scanSession: ScanSession?
    private var busy = false
    private var connectedButtons: [NSButton] = []
    private var scanButton: NSButton!
    private var connectButton: NSButton!
    private var disconnectButton: NSButton!

    func applicationDidFinishLaunching(_: Notification) {
        sdk.delegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 660),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Mentra SDK Mac"
        window.minSize = NSSize(width: 600, height: 500)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
        ])
        scanButton = button("Scan", action: #selector(scan))
        connectButton = button("Connect", action: #selector(connect))
        disconnectButton = button("Disconnect", action: #selector(disconnect))
        picker.setContentHuggingPriority(.defaultLow, for: .horizontal)
        picker.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true
        let connection = NSStackView(views: [scanButton, picker, connectButton, disconnectButton])
        stack.addArrangedSubview(connection)
        stack.addArrangedSubview(status)
        webhook.placeholderString = "Photo webhook URL (HTTPS or local HTTP)"
        stack.addArrangedSubview(webhook)
        let capture = button("Capture photo", action: #selector(capture))
        let check = button("Check OTA", action: #selector(checkOta))
        connectedButtons = [capture, check]
        stack.addArrangedSubview(NSStackView(views: [capture, check]))
        status.isSelectable = true
        action.isSelectable = true
        stack.addArrangedSubview(action)
        preview.imageScaling = .scaleProportionallyUpOrDown
        stack.addArrangedSubview(preview)
        for view in [connection, status, webhook, action, preview] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
        }
        preview.heightAnchor.constraint(greaterThanOrEqualToConstant: 250).isActive = true
        refreshButtons()
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApplication.shared.mainMenu = menu
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func button(_ title: String, action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }

    private func refreshButtons() {
        connectedButtons.forEach { $0.isEnabled = sdk.glasses.ready && !busy }
        scanButton.isEnabled = sdk.glasses.connection == .disconnected && !busy
        connectButton.isEnabled = sdk.glasses.connection == .disconnected && !devices.isEmpty && !busy
        disconnectButton.isEnabled = sdk.glasses.connection != .disconnected
    }

    @objc private func scan() {
        do {
            scanSession?.stop()
            scanSession = try sdk.scan(model: .mentraLive, timeout: 10) { [weak self] devices in
                guard let self else { return }
                self.devices = devices
                picker.removeAllItems()
                picker.addItems(withTitles: devices.map(\.name))
                refreshButtons()
            }
            action.stringValue = "Scanning..."
        } catch { action.stringValue = error.localizedDescription }
    }

    @objc private func connect() {
        guard devices.indices.contains(picker.indexOfSelectedItem) else { return }
        do { try sdk.connect(to: devices[picker.indexOfSelectedItem]); action.stringValue = "Connecting..." }
        catch { action.stringValue = error.localizedDescription }
    }

    @objc private func disconnect() {
        sdk.disconnect()
    }

    @objc private func capture() {
        guard let url = URL(string: webhook.stringValue), ["http", "https"].contains(url.scheme), url.host != nil else {
            action.stringValue = "Enter a valid photo webhook URL."
            return
        }
        runAction("Capturing...") {
            let result = try await self.sdk.requestPhoto(PhotoRequest(size: .medium, webhookUrl: url.absoluteString, sound: true))
            if let photoUrl = result.values["photoUrl"] as? String, let url = URL(string: photoUrl) {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode),
                      let image = NSImage(data: data) else { throw URLError(.cannotDecodeContentData) }
                self.preview.image = image
            }
            self.action.stringValue = "Photo uploaded: \(result.requestId)"
        }
    }

    @objc private func checkOta() {
        runAction("Checking for updates...") {
            let available = try await self.sdk.checkForOtaUpdate()
            self.action.stringValue = available ? "A glasses update is available" : "Up to date"
        }
    }

    private func runAction(_ message: String, operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        action.stringValue = message
        refreshButtons()
        Task {
            defer { busy = false; refreshButtons() }
            do { try await operation() }
            catch { action.stringValue = error.localizedDescription }
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState) {
        status.stringValue = glasses.connected
            ? "\(glasses.device?.bluetoothName ?? "Connected") | Battery: \(glasses.battery?.level.map(String.init) ?? "unknown")% | ASG: \(glasses.device?.appVersion ?? "unknown")"
            : glasses.connection.rawValue
        refreshButtons()
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: BluetoothEvent) {
        switch event {
        case let .photoStatus(event): action.stringValue = "Photo: \(event.status)"
        case let .otaStatus(event):
            action.stringValue = "OTA: \(event.stepType) \(event.overallPercent)% - \(event.status)\n\(event.errorMessage ?? "")"
        default: break
        }
    }

    func applicationWillTerminate(_: Notification) {
        sdk.invalidate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        true
    }
}
