import Foundation
#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// Diagnostic observations only. These facts never authorize a network read or a join.
final class MacHotspotAuthorizationFacts {
    enum Getter: String { case instanceInitial = "instance-initial", instanceCallback = "instance-callback", staticSSID = "static-ssid" }
    enum Foreground: String { case active, inactive, background, unknown }
    private let lock = NSLock()
    private var instance: (raw: Int32, getter: Getter, foreground: Foreground)?
    private var initialCallbackObserved = false
    private let pid = ProcessInfo.processInfo.processIdentifier
    private let bundleID = Bundle.main.bundleIdentifier.flatMap { value in
        value.range(of: "^[A-Za-z0-9_.-]{1,128}$", options: .regularExpression) == nil ? nil : value
    } ?? "unknown"

    /// UIKit/AppKit state is sampled only on its owning thread. A worker read stays unknown.
    static func foreground() -> Foreground {
        guard Thread.isMainThread else { return .unknown }
        #if canImport(UIKit)
            switch UIApplication.shared.applicationState {
            case .active: return .active
            case .inactive: return .inactive
            case .background: return .background
            @unknown default: return .unknown
            }
        #elseif canImport(AppKit)
            return NSApplication.shared.isActive ? .active : .inactive
        #else
            return .unknown
        #endif
    }

    func observeInstance(raw: Int32, getter: Getter, foreground: Foreground) {
        lock.lock(); defer { lock.unlock() }
        instance = (raw, getter, foreground)
        if getter == .instanceCallback { initialCallbackObserved = true }
    }

    /// Only enums and this process's identity cross the existing bounded error bridge.
    func failure(_ message: String, raw: Int32, getter: Getter, foreground: Foreground) -> LocalMediaError {
        lock.lock(); defer { lock.unlock() }
        let instanceRaw = instance.map { String($0.raw) } ?? "unknown"
        let instanceGetter = instance?.getter.rawValue ?? "unknown"
        let instanceForeground = instance?.foreground.rawValue ?? "unknown"
        return LocalMediaError("\(message) [location raw=\(raw) getter=\(getter.rawValue) foreground=\(foreground.rawValue) instanceRaw=\(instanceRaw) instanceGetter=\(instanceGetter) instanceForeground=\(instanceForeground) initialCallbackObserved=\(initialCallbackObserved) pid=\(pid) bundle=\(bundleID)]")
    }
}
