//
//  JSCDispatcher.swift
//  MentraJS — dispatch table + permission gate for the per-miniapp
//  __dispatch(iface, method, args) bridge.
//
//  Every JSContext spawned by JSCRuntime gets a single Swift block bound
//  to __dispatch. That block hands control to JSCDispatcher.handle(),
//  which:
//    1. Looks up the (iface, method) handler from `routes` — local
//       handlers serve dispatches synchronously, RN-forwarded ones return
//       .forwardToRn and the runtime emits an `mentrajs_message` event.
//    2. Consults the PermissionStore + InstalledManifest to gate
//       OS-sensitive calls. PERMISSION_NOT_DECLARED / PERMISSION_DENIED
//       errors propagate back to JS as thrown Error objects.
//
//  Most native heavy lifting (display, mic, camera, BLE) is owned by the
//  existing RN-side runtime, so the default route is .forwardToRn. Only
//  the bridge-internal calls (`__runtime.ready`, `localStorage.*`,
//  `crypto.getRandomBytes`, `__log`) get inline native handlers — those
//  are too hot to round-trip through RN on every call.
//

import Foundation
import os.log

/// Outcome of a `__dispatch` call as far as the JS side cares.
public enum JSCDispatchOutcome {
    /// Local synchronous handler completed; return value goes back to JS.
    case sync(Any?)
    /// Handler accepted the call and will resolve later via dispatchToJs.
    case async
    /// Handler refused; JS sees a thrown Error with `code` + `message`.
    case error(code: String, message: String?)
    /// Forward to RN as `mentrajs_message`; downstream RN code handles it
    /// and (for request/response calls) eventually calls dispatchToJs back.
    case forwardToRn([String: Any])
}

/// Per-package manifest declared in `miniapp.json`. Mirrors the structure
/// LocalMiniappRuntime owns today.
public struct InstalledMiniappManifest {
    public let permissions: Set<String>
    public init(permissions: Set<String>) {
        self.permissions = permissions
    }
}

/// In-memory permission grant store. Phase 1 ships an in-memory map so the
/// dispatcher can be exercised end-to-end without SQLite; a follow-up
/// task swaps in a SQLite-backed store that survives host restarts.
/// (Carrying the existing in-memory shape forward keeps the API the same.)
public final class PermissionStore {
    private var granted: [String: Set<String>] = [:]
    private let lock = NSLock()

    public init() {}

    public func grant(packageName: String, permission: String) {
        lock.withLock {
            granted[packageName, default: []].insert(permission)
        }
    }

    public func revoke(packageName: String, permission: String) {
        lock.withLock {
            granted[packageName]?.remove(permission)
        }
    }

    public func isGranted(packageName: String, permission: String) -> Bool {
        lock.withLock { granted[packageName]?.contains(permission) ?? false }
    }

    /// For tests / dev: bulk-set the grants for a package.
    public func setGrants(packageName: String, permissions: Set<String>) {
        lock.withLock {
            granted[packageName] = permissions
        }
    }
}

public final class JSCDispatcher {
    /// (iface, method) → handler closure.
    /// Closure runs ON the JSContext's queue (caller's responsibility to
    /// hand off if it needs the main thread).
    public typealias Handler = (_ packageName: String, _ args: [Any], _ reqId: String?) -> JSCDispatchOutcome

    private var routes: [String: Handler] = [:]
    private var manifests: [String: InstalledMiniappManifest] = [:]
    public let permissionStore = PermissionStore()
    /// Permissions whose presence is implicit at install (no JIT prompt).
    private let implicitGrants: Set<String> = ["STORAGE", "DISPLAY", "BUTTONS"]
    private let lock = NSLock()

    /// Required permission per iface. Missing entry = no permission gate.
    /// Mirrors the inline permission checks in LocalMiniappRuntime today.
    public var permissionRequirements: [String: String] = [
        "mic": "MICROPHONE",
        "transcription": "MICROPHONE",
        "translation": "MICROPHONE",
        "camera": "CAMERA",
        "location": "LOCATION",
        "navigation": "LOCATION",
        "heading": "LOCATION",
        "calendar": "CALENDAR",
    ]

    public init() {
        installBuiltinRoutes()
    }

    public func register(iface: String, method: String, handler: @escaping Handler) {
        let key = "\(iface).\(method)"
        lock.withLockVoid { routes[key] = handler }
    }

    /// Drop a previously-registered route. Useful for tests + hot-reload.
    public func unregister(iface: String, method: String) {
        let key = "\(iface).\(method)"
        lock.withLockVoid { routes.removeValue(forKey: key) }
    }

    /// Set the installed manifest for a package — usually called when the
    /// miniapp's bundle is registered by the host. The dispatcher reads
    /// `permissions` for the static "declared in manifest" gate.
    public func setManifest(packageName: String, manifest: InstalledMiniappManifest) {
        lock.withLockVoid { manifests[packageName] = manifest }
    }

    public func clearManifest(packageName: String) {
        lock.withLockVoid { manifests.removeValue(forKey: packageName) }
    }

    public func manifest(packageName: String) -> InstalledMiniappManifest? {
        lock.withLock { manifests[packageName] }
    }

    /// Main entry point — called from JSCRuntime's __dispatch block.
    public func handle(
        packageName: String,
        iface: String,
        method: String,
        args: [Any],
        reqId: String?,
    ) -> JSCDispatchOutcome {
        // Permission gate. Bridge-internal calls (`__runtime`, `__log`,
        // crypto, localStorage) are exempt — they don't touch OS sensors.
        if let required = permissionRequirement(for: iface), !implicitGrants.contains(required) {
            let manifestPermissions = manifest(packageName: packageName)?.permissions ?? []
            if !manifestPermissions.contains(required) {
                return .error(code: "PERMISSION_NOT_DECLARED", message: required)
            }
            if !permissionStore.isGranted(packageName: packageName, permission: required) {
                return .error(code: "PERMISSION_DENIED", message: required)
            }
        }

        let key = "\(iface).\(method)"
        if let handler = (lock.withLock { routes[key] }) {
            return handler(packageName, args, reqId)
        }

        // No local route → forward to RN. The RN-side MentraJSRouter
        // (Phase 2) is the destination.
        return .forwardToRn([
            "args": args,
        ])
    }

    private func permissionRequirement(for iface: String) -> String? {
        permissionRequirements[iface]
    }

    // MARK: - Built-in local routes

    private func installBuiltinRoutes() {
        // __runtime.ready — the polyfill bundle's signal-ready callback.
        // JSCRuntime watches for this to clear the cold-start NACK timer.
        register(iface: "__runtime", method: "ready") { _, _, _ in
            return .sync(NSNull())
        }

        // localStorage — bridged synchronously through Userdefaults. Each
        // miniapp gets its own UserDefaults suite scoped on packageName.
        register(iface: "localStorage", method: "getItem") { packageName, args, _ in
            guard let key = args.first as? String,
                  let defaults = UserDefaults(suiteName: "MentraJS-\(packageName)") else {
                return .sync(NSNull())
            }
            let v = defaults.string(forKey: key)
            return .sync(v ?? NSNull())
        }
        register(iface: "localStorage", method: "setItem") { packageName, args, _ in
            guard args.count >= 2,
                  let key = args[0] as? String,
                  let value = args[1] as? String,
                  let defaults = UserDefaults(suiteName: "MentraJS-\(packageName)") else {
                return .error(code: "INVALID_ARGS", message: "localStorage.setItem expects (key, value) strings")
            }
            defaults.set(value, forKey: key)
            return .sync(NSNull())
        }
        register(iface: "localStorage", method: "removeItem") { packageName, args, _ in
            guard let key = args.first as? String,
                  let defaults = UserDefaults(suiteName: "MentraJS-\(packageName)") else {
                return .error(code: "INVALID_ARGS", message: "localStorage.removeItem expects (key)")
            }
            defaults.removeObject(forKey: key)
            return .sync(NSNull())
        }
        register(iface: "localStorage", method: "clear") { packageName, _, _ in
            guard let defaults = UserDefaults(suiteName: "MentraJS-\(packageName)") else {
                return .sync(NSNull())
            }
            for (k, _) in defaults.dictionaryRepresentation() {
                defaults.removeObject(forKey: k)
            }
            return .sync(NSNull())
        }
        register(iface: "localStorage", method: "length") { packageName, _, _ in
            guard let defaults = UserDefaults(suiteName: "MentraJS-\(packageName)") else {
                return .sync(0)
            }
            return .sync(defaults.dictionaryRepresentation().count)
        }
        register(iface: "localStorage", method: "key") { packageName, args, _ in
            guard let idx = args.first as? Int,
                  let defaults = UserDefaults(suiteName: "MentraJS-\(packageName)") else {
                return .sync(NSNull())
            }
            let keys = Array(defaults.dictionaryRepresentation().keys).sorted()
            guard idx >= 0, idx < keys.count else { return .sync(NSNull()) }
            return .sync(keys[idx])
        }

        // crypto.getRandomBytes — single fast path used by the polyfill's
        // getRandomValues + randomUUID. Returns [byte] array.
        register(iface: "crypto", method: "getRandomBytes") { _, args, _ in
            let n: Int
            if let nn = args.first as? Int { n = nn }
            else if let nd = args.first as? Double { n = Int(nd) }
            else { return .error(code: "INVALID_ARGS", message: "getRandomBytes expects (n)") }
            guard n >= 0, n <= (1 << 20) else {
                return .error(code: "INVALID_ARGS", message: "getRandomBytes max 1MB")
            }
            var bytes = [UInt8](repeating: 0, count: n)
            let status = bytes.withUnsafeMutableBufferPointer { buf -> Int32 in
                guard let baseAddress = buf.baseAddress else { return errSecParam }
                return SecRandomCopyBytes(kSecRandomDefault, n, baseAddress)
            }
            if status != errSecSuccess {
                return .error(code: "NATIVE_THROW", message: "SecRandomCopyBytes failed (\(status))")
            }
            return .sync(bytes.map { Int($0) })
        }
    }
}
