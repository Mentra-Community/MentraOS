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
    private let otaStatus = NSTextField(wrappingLabelWithString: "")
    private let webhook = NSTextField(string: "")
    private let preview = NSImageView()
    private var devices: [Device] = []
    private var scanSession: ScanSession?
    private var busy = false
    private var actionTask: Task<Void, Never>?
    private var photoRequestId: String?
    private var connectedButtons: [NSButton] = []
    private var scanButton: NSButton!
    private var connectButton: NSButton!
    private var pairButton: NSButton!

    func applicationDidFinishLaunching(_: Notification) {
        sdk.delegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 660),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Mentra Bluetooth Example macOS"
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
        connectButton = button("Connect", action: #selector(connectOrDisconnect))
        pairButton = button("Pair", action: #selector(pairOrUnpair))
        picker.setContentHuggingPriority(.defaultLow, for: .horizontal)
        picker.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true
        let connection = NSStackView(views: [scanButton, picker, connectButton, pairButton])
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
        otaStatus.isSelectable = true
        stack.addArrangedSubview(action)
        stack.addArrangedSubview(otaStatus)
        preview.imageScaling = .scaleProportionallyUpOrDown
        preview.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        preview.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        preview.setContentHuggingPriority(.defaultLow, for: .horizontal)
        preview.setContentHuggingPriority(.defaultLow, for: .vertical)
        stack.addArrangedSubview(preview)
        for view in [connection, status, webhook, action, otaStatus, preview] {
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

    // Paired: glasses the SDK keeps as its default device, connected or not.
    private var paired: Bool {
        sdk.glasses.connection != .disconnected || sdk.defaultDevice != nil
    }

    // Pairing is scan and choose: Scan and the picker show until glasses are paired, then Connect/Disconnect takes their place.
    private func refreshButtons() {
        let disconnected = sdk.glasses.connection == .disconnected
        connectedButtons.forEach { $0.isEnabled = sdk.glasses.ready && !busy }
        scanButton.isHidden = paired
        picker.isHidden = paired
        scanButton.isEnabled = !busy
        connectButton.isHidden = !paired
        connectButton.title = disconnected ? "Connect" : "Disconnect"
        connectButton.isEnabled = !disconnected || !busy
        pairButton.title = paired ? "Unpair" : "Pair"
        pairButton.isEnabled = paired ? !busy : devices.indices.contains(picker.indexOfSelectedItem) && !busy
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
            } onComplete: { [weak self] _ in
                guard let self else { return }
                scanSession = nil
                if sdk.glasses.connection == .disconnected && !busy {
                    action.stringValue = "Scan complete"
                }
            }
            action.stringValue = "Scanning..."
        } catch { action.stringValue = error.localizedDescription }
    }

    @objc private func connectOrDisconnect() {
        if sdk.glasses.connection != .disconnected {
            cancelAction()
            sdk.disconnect()
            return
        }
        do { try sdk.connectDefault(); action.stringValue = "Connecting..." }
        catch { action.stringValue = error.localizedDescription }
    }

    @objc private func pairOrUnpair() {
        if paired {
            cancelAction()
            runAction("Unpairing...") {
                try await self.sdk.unpair()
                self.action.stringValue = "Unpaired"
            }
            return
        }
        guard devices.indices.contains(picker.indexOfSelectedItem) else { return }
        let device = devices[picker.indexOfSelectedItem]
        scanSession?.stop()
        scanSession = nil
        devices = []
        picker.removeAllItems()
        // Connecting to the chosen glasses saves them as the SDK's default device.
        do { try sdk.connect(to: device); action.stringValue = "Pairing..." }
        catch { action.stringValue = error.localizedDescription }
        refreshButtons()
    }

    @objc private func capture() {
        guard let url = URL(string: webhook.stringValue), ["http", "https"].contains(url.scheme), url.host != nil else {
            action.stringValue = "Enter a valid photo webhook URL."
            return
        }
        runAction("Capturing...") {
            self.preview.image = nil
            let request = PhotoRequest(size: .medium, webhookUrl: url.absoluteString, sound: true)
            self.photoRequestId = request.requestId
            defer {
                if self.photoRequestId == request.requestId { self.photoRequestId = nil }
            }
            let result = try await self.sdk.requestPhoto(request)
            try Task.checkCancellation()
            self.photoRequestId = nil
            self.action.stringValue = "Photo uploaded: \(result.requestId)"
            guard case let .success(_, _, photoUrl, _, _, _, _) = result.response,
                  let photoUrl, let url = URL(string: photoUrl) else { return }
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                try Task.checkCancellation()
                guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode),
                      let image = NSImage(data: data) else { throw URLError(.cannotDecodeContentData) }
                self.preview.image = image
            } catch {
                try Task.checkCancellation()
                self.action.stringValue = "Photo uploaded: \(result.requestId). Preview unavailable: \(error.localizedDescription)"
            }
        }
    }

    @objc private func checkOta() {
        runAction("Checking for updates...") {
            let available = try await self.sdk.checkForOtaUpdate()
            try Task.checkCancellation()
            self.action.stringValue = available ? "A glasses update is available" : "Up to date"
        }
    }

    private func runAction(_ message: String, operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        action.stringValue = message
        refreshButtons()
        actionTask = Task {
            defer {
                if !Task.isCancelled {
                    actionTask = nil
                    busy = false
                    refreshButtons()
                }
            }
            do {
                try Task.checkCancellation()
                try await operation()
            }
            catch {
                if !Task.isCancelled { action.stringValue = error.localizedDescription }
            }
        }
    }

    private func cancelAction() {
        // A sent glasses command may finish; cancellation prevents its late result from changing this UI.
        actionTask?.cancel()
        actionTask = nil
        photoRequestId = nil
        busy = false
        action.stringValue = "Disconnected"
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState) {
        if !glasses.connected {
            otaStatus.stringValue = ""
            if actionTask != nil { cancelAction() }
        }
        status.stringValue = glasses.connected
            ? "\(glasses.device?.bluetoothName ?? "Connected") | Battery: \(glasses.battery?.level.map(String.init) ?? "unknown")% | ASG: \(glasses.device?.appVersion ?? "unknown")"
            : glasses.connection.rawValue
        refreshButtons()
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice _: Device?) {
        refreshButtons()
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: BluetoothEvent) {
        switch event {
        case let .photoStatus(event):
            if sdk.glasses.connected && event.requestId == photoRequestId {
                action.stringValue = "Photo: \(event.status)"
            }
        case let .otaStatus(event):
            if sdk.glasses.connected {
                otaStatus.stringValue = "OTA: \(event.stepType) \(event.overallPercent)% - \(event.status)\n\(event.errorMessage ?? "")"
            }
        default: break
        }
    }

    func applicationWillTerminate(_: Notification) {
        cancelAction()
        sdk.invalidate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        true
    }
}
