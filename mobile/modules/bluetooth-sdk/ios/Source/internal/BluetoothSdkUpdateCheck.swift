import Foundation

struct BluetoothSdkUpdateCheckResult: Equatable {
    let status: String
    let channel: String
    let latestVersion: String?
    let minimumSupportedVersion: String?

    static func parse(_ body: Data) -> BluetoothSdkUpdateCheckResult? {
        guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return nil }
        return BluetoothSdkUpdateCheckResult(
            status: json["status"] as? String ?? "",
            channel: json["channel"] as? String ?? "",
            latestVersion: nonBlankString(json["latestVersion"]),
            minimumSupportedVersion: nonBlankString(json["minimumSupportedVersion"])
        )
    }

    static func parse(_ body: String) -> BluetoothSdkUpdateCheckResult? {
        parse(Data(body.utf8))
    }

    private static func nonBlankString(_ value: Any?) -> String? {
        guard let value = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

/// The developer-facing console banner for an out-of-date SDK. Never shown in app UI.
enum BluetoothSdkUpdateNotice {
    static let statusUpdateAvailable = "update_available"
    static let statusUnsupported = "unsupported"
    private static let rule = "=================================================================="

    /// Nil when the installed SDK is current or the server could not tell.
    static func banner(installedVersion: String, result: BluetoothSdkUpdateCheckResult, surface: String) -> String? {
        let latest = result.latestVersion
        let heading: String
        switch result.status {
        case statusUnsupported:
            heading = "MENTRA BLUETOOTH SDK \(installedVersion) IS NO LONGER SUPPORTED"
        case statusUpdateAvailable:
            guard latest != nil else { return nil }
            heading = "MENTRA BLUETOOTH SDK UPDATE AVAILABLE"
        default:
            return nil
        }
        var lines = [
            rule,
            "  \(heading)",
            "  Installed: \(installedVersion)    Latest: \(latest ?? "unknown")",
            "  Update:    \(updateLine(surface: surface, version: latest))",
        ]
        if result.status == statusUnsupported {
            lines.append("  This version has known issues that are fixed in newer releases.")
        }
        lines.append("  Running an old SDK is the most common cause of glasses issues.")
        lines.append(rule)
        return lines.joined(separator: "\n")
    }

    private static func updateLine(surface: String, version: String?) -> String {
        switch surface {
        case "react_native": return "bun add @mentra/bluetooth-sdk@\(version ?? "latest")"
        case "ios": return "the MentraBluetoothSDK Swift package at \(version ?? "its latest release")"
        default: return "com.mentraglass:bluetooth-sdk:\(version ?? "<latest release>")"
        }
    }
}

/// Checks Mentra Core for a newer SDK on every SDK start and, when this SDK is
/// behind, prints a console banner now and every `reprintInterval` while the SDK
/// instance lives. The check is one request with a short timeout and no retry;
/// any failure is silent and changes no SDK behavior. It runs regardless of the
/// analytics setting.
final class BluetoothSdkUpdateCheck {
    /// Posts the JSON body and completes with the 200 response body, or nil on any failure.
    typealias Transport = @Sendable (_ body: Data, _ completion: @escaping @Sendable (Data?) -> Void) -> Void
    typealias NoticeHandler = @Sendable (_ banner: String, _ result: BluetoothSdkUpdateCheckResult) -> Void

    static let updateCheckUrl = URL(string: "https://core.mentraglass.com/api/client/bluetooth-sdk/update-check")!
    static let reprintInterval: TimeInterval = 15 * 60
    private static let timeout: TimeInterval = 4
    private static let queue = DispatchQueue(label: "com.mentra.bluetoothsdk.update-check", qos: .utility)
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    private let surface: String
    private let sdkVersion: String?
    private let bundle: Bundle
    private let transport: Transport
    private let onNotice: NoticeHandler
    // Recursive so a notice handler that stops the check cannot deadlock it.
    private let lock = NSRecursiveLock()
    private var stopped = false
    private var reprintTimer: DispatchSourceTimer?

    init(
        surface: String,
        sdkVersion: String? = BluetoothSdkDefaults.sdkVersion,
        bundle: Bundle = .main,
        transport: @escaping Transport = { body, completion in BluetoothSdkUpdateCheck.post(body, completion: completion) },
        onNotice: @escaping NoticeHandler
    ) {
        self.surface = surface
        self.sdkVersion = sdkVersion
        self.bundle = bundle
        self.transport = transport
        self.onNotice = onNotice
    }

    deinit {
        reprintTimer?.cancel()
    }

    /// The update line follows the integration surface: React Native, or the Swift package.
    static func surface(forAnalyticsSurface analyticsSurface: String) -> String {
        analyticsSurface == "react_native" ? "react_native" : "ios"
    }

    static func isCheckable(_ version: String?) -> Bool {
        guard let version else { return false }
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != "unknown"
    }

    func start() {
        guard Self.isCheckable(sdkVersion) else { return }
        // Bundle and UserDefaults lookups stay off the caller (often main) thread.
        Self.queue.async { [weak self] in
            guard let self else { return }
            let requestBody = self.requestBody()
            guard JSONSerialization.isValidJSONObject(requestBody),
                  let body = try? JSONSerialization.data(withJSONObject: requestBody)
            else { return }
            self.transport(body) { [weak self] response in
                self?.handle(response)
            }
        }
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        stopped = true
        reprintTimer?.cancel()
        reprintTimer = nil
    }

    private func handle(_ response: Data?) {
        guard let response,
              let sdkVersion,
              let result = BluetoothSdkUpdateCheckResult.parse(response),
              let banner = BluetoothSdkUpdateNotice.banner(installedVersion: sdkVersion, result: result, surface: surface)
        else { return }
        lock.lock()
        defer { lock.unlock() }
        guard !stopped, reprintTimer == nil else { return }
        onNotice(banner, result)
        let timer = DispatchSource.makeTimerSource(queue: Self.queue)
        timer.schedule(deadline: .now() + Self.reprintInterval, repeating: Self.reprintInterval)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            if !self.stopped { self.onNotice(banner, result) }
        }
        reprintTimer = timer
        timer.resume()
    }

    func requestBody() -> [String: Any] {
        let host = BluetoothSdkAnalyticsHost.resolve(bundle: bundle)
        #if os(macOS)
            let osPlatform = "macos"
        #else
            let osPlatform = "ios"
        #endif
        var body: [String: Any] = [
            "install_id": BluetoothSdkInstallId.get(),
            "app_identifier": bundle.bundleIdentifier ?? "",
            "app_build_type": host.buildType,
            "app_install_source": host.installSource,
            "sdk_version": sdkVersion ?? "unknown",
            // Core accepts `android` or `ios`; the macOS build ships in the same Swift package.
            "sdk_platform": "ios",
            "sdk_surface": surface,
            "os_platform": osPlatform,
            "os_version": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        if let appVersion = host.appVersion { body["app_version"] = appVersion }
        if let appBuild = host.appBuild { body["app_build"] = appBuild }
        if let environment = host.environment { body["app_environment"] = environment }
        return body
    }

    static func post(_ body: Data, completion: @escaping @Sendable (Data?) -> Void) {
        var request = URLRequest(url: updateCheckUrl)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        session.dataTask(with: request) { data, response, error in
            guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200 else {
                completion(nil)
                return
            }
            completion(data)
        }.resume()
    }

    /// Test hook: waits until every task submitted to the check queue so far has run.
    static func awaitIdle() {
        queue.sync {}
    }
}
