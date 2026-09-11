//
//  JSCRuntime.swift
//  MentraJS — per-miniapp JavaScriptCore runtime host (iOS).
//
//  Owns N JSContexts keyed by `packageName`. Each context gets:
//    - its own JSVirtualMachine (heap isolation)
//    - its own serial dispatch queue (JSC is thread-affine)
//    - the polyfill bundle pre-evaluated before any miniapp code runs
//    - a single `__dispatch(iface, method, argsJson)` block exposing the
//      whole SDK surface (Pebble's CrashReproducer warning: never bind
//      individual native callbacks as JSValue properties — JSC's GC
//      crashes when the host runtime's GC races with it).
//
//  The Expo Function surface on `CrustModule`:
//    mentraJsSpawn(packageName, polyfillBundle, miniappJs) → Bool
//    mentraJsEvaluate(packageName, src) → Any?
//    mentraJsKill(packageName) → Void
//    mentraJsDispatchToJs(packageName, channel, payloadJson) → Void
//    Event "mentrajs_message" — fired when JS calls __dispatch back.
//

import Foundation
@preconcurrency import JavaScriptCore
import os.log

/// Per-miniapp JSContext owner. Threadsafe: every per-context operation
/// hops onto that context's dedicated serial queue, and the registry map
/// is guarded by `lock`. The runtime is a process-singleton — there is
/// exactly one `JSCRuntime.shared` per host process.
public final class JSCRuntime: NSObject {
    public static let shared = JSCRuntime()

    /// Tag for os_log lines; visible via Console.app under
    /// `subsystem == "com.mentra.mentra" && category == "MentraJS"`.
    static let log = OSLog(subsystem: "com.mentra.mentra", category: "MentraJS")

    /// Message emitted back to RN via `Crust.addListener("mentrajs_message", …)`.
    /// `payload` is JSON-friendly so the bridge can ship it verbatim.
    public struct OutboundMessage {
        public let packageName: String
        public let payload: [String: Any]
    }

    /// Set by `CrustModule.swift` so the runtime can route `__dispatch`
    /// calls back to RN. Replacing this closure is idempotent and threadsafe.
    public var onOutbound: ((OutboundMessage) -> Void)? {
        get { lock.withLock { _onOutbound } }
        set { lock.withLock { _onOutbound = newValue } }
    }

    // MARK: - Per-context state

    /// Internal record per running miniapp.
    private final class Context {
        let packageName: String
        let virtualMachine: JSVirtualMachine
        let context: JSContext
        let queue: DispatchQueue
        /// Pending request resolvers (reqId → completion). Used when the SDK
        /// awaits a Promise for a request/response dispatch. Modify only on
        /// `queue`.
        var pendingTimers: [Int: DispatchSourceTimer] = [:]
        /// Monotonic per-context counter for native-issued reqIds.
        var nextTimerToken: Int = 1
        /// signalReady NACK timer. Armed at spawn (15s cold-start) and
        /// on every dispatchToJs (3s steady-state). Disarmed when the
        /// polyfill calls __runtime.ready or when the call completes.
        var readyNackTimer: DispatchSourceTimer?
        /// True once the polyfill has signalled ready. Cleared on respawn.
        var readyAcked: Bool = false
        /// Soft watchdog — fires if a single evaluateScript blocks the
        /// queue for >5s warn / >30s kill.
        var watchdogTimer: DispatchSourceTimer?

        init(packageName: String, virtualMachine: JSVirtualMachine, context: JSContext, queue: DispatchQueue) {
            self.packageName = packageName
            self.virtualMachine = virtualMachine
            self.context = context
            self.queue = queue
        }
    }

    /// NACK timeout constants — cold-start vs steady-state.
    /// 15s on first message after spawn (covers polyfill + init
    /// evaluating on slow Android devices), 3s for steady-state delivery.
    public static let coldStartNackTimeoutSeconds: TimeInterval = 15
    public static let steadyStateNackTimeoutSeconds: TimeInterval = 3
    public static let watchdogWarnSeconds: TimeInterval = 5
    public static let watchdogKillSeconds: TimeInterval = 30

    /// packageName → Context. Reads and writes go through `lock`.
    private var contexts: [String: Context] = [:]
    private let lock = NSLock()
    private var _onOutbound: ((OutboundMessage) -> Void)?

    /// Dispatcher registry — `(iface, method)` → native handler. Set up by
    /// `JSCDispatcher.register(...)` during host startup. The runtime
    /// consults this for every `__dispatch` call.
    fileprivate let dispatcher = JSCDispatcher()

    /// Public accessor so RN-side adapters can install handler tables.
    public var dispatcherTable: JSCDispatcher { dispatcher }

    /// Returns true if the named package has a live JSContext.
    public func isAlive(packageName: String) -> Bool {
        lock.withLock { contexts[packageName] != nil }
    }

    /// Locate the polyfill bundle inside the iOS pod's resource bundle
    /// and return its contents. Returns an empty string if the resource
    /// is missing (host RN code should treat that as a fatal misconfig
    /// — every JSContext spawn depends on this bundle).
    public static func loadPolyfillBundle() -> String {
        // Cocoapods generates `MentraJSRuntime.bundle` next to the pod
        // binary. The runtime resolves it via Bundle(for:).
        let main = Bundle.main
        // The resource_bundles directive on the podspec emits a bundle
        // named "MentraJSRuntime" inside the main app bundle's path.
        // We look it up by name; fall back to scanning Bundle.main for
        // a startup.js anywhere if cocoapods placed it differently
        // (e.g. inside the Crust framework bundle in static linkage).
        let candidates: [URL?] = [
            main.url(forResource: "MentraJSRuntime", withExtension: "bundle"),
            Bundle(for: JSCRuntime.self).url(forResource: "MentraJSRuntime", withExtension: "bundle"),
        ]
        for case let bundleUrl? in candidates {
            let startupUrl = bundleUrl.appendingPathComponent("startup.js")
            if let data = try? Data(contentsOf: startupUrl), let str = String(data: data, encoding: .utf8) {
                return str
            }
        }
        // Last-resort scan — find any startup.js in the main bundle.
        if let path = main.path(forResource: "startup", ofType: "js"),
           let str = try? String(contentsOfFile: path, encoding: .utf8) {
            return str
        }
        os_log("MentraJS: polyfill bundle not found in resources", log: Self.log, type: .error)
        return ""
    }

    /// Returns the packageNames of every live context — used for diagnostics
    /// and the soft watchdog ping loop.
    public func alivePackages() -> [String] {
        lock.withLock { Array(contexts.keys) }
    }

    // MARK: - Spawn

    /// Spawn a per-miniapp JS context.
    ///
    /// - Parameters:
    ///   - packageName: stable id (e.g. "com.alex.notes"). Must be unique
    ///     within the host process. Re-spawning a live id kills the old
    ///     context first.
    ///   - polyfillBundle: the contents of `mentrajs-runtime/dist/startup.js`.
    ///     Evaluated first, before `miniappJs`.
    ///   - miniappJs: the miniapp's `background/index.js` source. Evaluated
    ///     immediately after the polyfill installs.
    /// - Returns: true on success, false if either eval threw.
    @discardableResult
    public func spawn(packageName: String, polyfillBundle: String, miniappJs: String) -> Bool {
        // Kill any prior context for the same package — re-spawn is allowed
        // (hot-reload, sideload of new version, crash recovery).
        if isAlive(packageName: packageName) {
            kill(packageName: packageName)
        }

        let vm = JSVirtualMachine()!
        let queue = DispatchQueue(label: "com.mentra.mentrajs.\(packageName)", qos: .userInitiated)
        let ctx = JSContext(virtualMachine: vm)!
        ctx.name = "MentraJS: \(packageName)"
        #if DEBUG
        if #available(iOS 16.4, *) {
            ctx.isInspectable = true
        }
        #endif

        let record = Context(packageName: packageName, virtualMachine: vm, context: ctx, queue: queue)
        lock.withLock { contexts[packageName] = record }

        // Cold-start NACK timer: armed BEFORE the first eval so it
        // catches a wedged polyfill. The polyfill's __dispatch("__runtime",
        // "ready", []) flips the record's readyAcked flag (see
        // markReady). If we never see the ack, the timer logs a hung
        // context warning so observability picks it up.
        armReadyNackTimer(record: record, timeoutSeconds: Self.coldStartNackTimeoutSeconds, cold: true)

        // All evaluation happens on `queue`. We `sync` for the bootstrap so
        // the caller knows whether spawn succeeded before returning.
        var success = true
        queue.sync {
            self.installNativeBridges(ctx: ctx, record: record)
            success = self.evaluateCatching(record: record, label: "polyfill", source: polyfillBundle)
            if success {
                success = self.evaluateCatching(record: record, label: "miniapp", source: miniappJs)
            }
        }

        if !success {
            kill(packageName: packageName)
        } else {
            os_log("MentraJS: spawned %{public}@", log: Self.log, type: .info, packageName)
        }
        return success
    }

    /// Called from the dispatcher's __runtime.ready route when the polyfill
    /// finishes installing. Clears the cold-start NACK timer.
    public func markReady(packageName: String) {
        guard let record = lock.withLock({ contexts[packageName] }) else { return }
        record.queue.async {
            record.readyAcked = true
            record.readyNackTimer?.cancel()
            record.readyNackTimer = nil
        }
    }

    /// Schedule (or re-schedule) a NACK timer for the next message
    /// delivery. Resets every time the host pushes to the JSContext.
    private func armReadyNackTimer(record: Context, timeoutSeconds: TimeInterval, cold: Bool) {
        record.queue.async {
            record.readyNackTimer?.cancel()
            let timer = DispatchSource.makeTimerSource(queue: record.queue)
            timer.schedule(deadline: .now() + timeoutSeconds)
            timer.setEventHandler { [weak self, weak record] in
                guard let self, let record else { return }
                let phase = cold ? "cold-start" : "steady-state"
                os_log("MentraJS NACK: %{public}@ %{public}@ ready signal not received in %.0fs",
                       log: Self.log, type: .error,
                       record.packageName, phase, timeoutSeconds)
                // Surface to RN as a recoverable error frame so the
                // crash controller (if wired) can decide whether to
                // respawn. We don't auto-kill — the spec says "host
                // dispatchToJs returns an error to its caller"; we
                // emit a structured event instead.
                self.lock.withLock { self._onOutbound }?(
                    OutboundMessage(
                        packageName: record.packageName,
                        payload: [
                            "packageName": record.packageName,
                            "iface": "__error",
                            "method": "ready_nack",
                            "argsJson": JSCRuntime.jsonString(
                                from: ["phase": phase, "timeoutSeconds": timeoutSeconds],
                            ) ?? "{}",
                        ],
                    )
                )
                record.readyNackTimer = nil
            }
            record.readyNackTimer = timer
            timer.resume()
        }
    }

    /// Diagnostic: force a JSC garbage-collection cycle on the named
    /// context. Used by the memory-leak hunt path and by tests.
    /// Returns false if the context is dead.
    @discardableResult
    public func debugForceGC(packageName: String) -> Bool {
        guard let record = lock.withLock({ contexts[packageName] }) else { return false }
        record.queue.async {
            JSGarbageCollect(record.context.jsGlobalContextRef)
        }
        return true
    }

    // MARK: - Evaluate

    /// Run arbitrary JS inside the named context. Returns the JS return
    /// value bridged to a Swift type (string / number / bool / array /
    /// dictionary / NSNull), or `nil` if the context is dead or eval threw.
    public func evaluate(packageName: String, source: String) -> Any? {
        guard let record = lock.withLock({ contexts[packageName] }) else { return nil }
        var result: Any?
        record.queue.sync {
            // evaluateCatching runs the script AND returns whether it
            // threw. We want both the result + the exception capture, so
            // inline the same dance here instead of re-evaluating
            // (which would run any side effects twice).
            record.context.exception = nil
            let raw = record.context.evaluateScript(source)
            if let exception = record.context.exception {
                os_log("MentraJS [%{public}@] evaluate threw: %{public}@",
                       log: Self.log, type: .error,
                       record.packageName, exception.toString() ?? "unknown")
                record.context.exception = nil
                result = nil
                return
            }
            result = raw?.toObject()
        }
        return result
    }

    // MARK: - Dispatch to JS

    /// Push a `{kind: "event"|"response", …}` envelope into the miniapp's
    /// JSContext via globalThis.__deliver. Threadsafe — hops onto the
    /// per-context queue. Drops silently if the context is dead.
    public func dispatchToJs(packageName: String, envelope: [String: Any]) {
        guard let record = lock.withLock({ contexts[packageName] }) else { return }
        guard let json = Self.jsonString(from: envelope) else {
            os_log("MentraJS: bad envelope, drop", log: Self.log, type: .error)
            return
        }
        // Steady-state NACK: re-arm the timer so a wedged JSContext
        // surfaces a __error/ready_nack frame after 3s instead of silently
        // swallowing the delivery. Only fires if a cold-start ack already
        // landed — otherwise the cold-start timer is still ticking.
        if record.readyAcked {
            armReadyNackTimer(record: record, timeoutSeconds: Self.steadyStateNackTimeoutSeconds, cold: false)
        }
        record.queue.async {
            let escaped = Self.jsStringLiteral(json)
            // Soft watchdog: every evaluateScript outside spawn gets a
            // wall-clock timer. If the eval is still running at the warn
            // threshold (5s), log it; at the kill threshold (30s), tear
            // the context down and emit __error/watchdog_kill so the
            // crash controller (if wired) can drive respawn.
            self.armSoftWatchdog(record: record, label: "__deliver")
            _ = self.evaluateCatching(
                record: record,
                label: "__deliver",
                source: "globalThis.__deliver(\(escaped));",
            )
            self.disarmSoftWatchdog(record: record)
            // On a successful delivery, clear the NACK — the host
            // observed the eval complete, so the context is responsive.
            record.readyNackTimer?.cancel()
            record.readyNackTimer = nil
        }
    }

    /// Arms a wall-clock timer that fires if a single evaluateScript
    /// blocks the per-context queue for > watchdogWarnSeconds. The
    /// timer runs on a dedicated dispatch queue (NOT the per-context
    /// one) so it can observe the queue being wedged.
    private static let watchdogScheduler = DispatchQueue(
        label: "com.mentra.mentrajs.watchdog",
        qos: .utility,
    )

    private func armSoftWatchdog(record: Context, label: String) {
        let timer = DispatchSource.makeTimerSource(queue: Self.watchdogScheduler)
        let warn = Self.watchdogWarnSeconds
        let kill = Self.watchdogKillSeconds
        timer.schedule(deadline: .now() + warn, repeating: .never)
        timer.setEventHandler { [weak self, weak record] in
            guard let self, let record else { return }
            os_log("MentraJS watchdog: %{public}@ %{public}@ blocked >%.0fs",
                   log: Self.log, type: .info,
                   record.packageName, label, warn)
            // Schedule the kill timer immediately.
            let killTimer = DispatchSource.makeTimerSource(queue: Self.watchdogScheduler)
            killTimer.schedule(deadline: .now() + (kill - warn))
            killTimer.setEventHandler { [weak self, weak record] in
                guard let self, let record else { return }
                os_log("MentraJS watchdog: %{public}@ blocked >%.0fs, killing",
                       log: Self.log, type: .error,
                       record.packageName, kill)
                self.lock.withLock { self._onOutbound }?(
                    OutboundMessage(
                        packageName: record.packageName,
                        payload: [
                            "packageName": record.packageName,
                            "iface": "__error",
                            "method": "watchdog_kill",
                            "argsJson": JSCRuntime.jsonString(
                                from: ["label": label, "thresholdSeconds": kill],
                            ) ?? "{}",
                        ],
                    )
                )
                self.kill(packageName: record.packageName)
            }
            record.watchdogTimer = killTimer
            killTimer.resume()
        }
        // Reuse the same field for the warn timer; it gets replaced by
        // the kill timer when the warn fires.
        record.watchdogTimer = timer
        timer.resume()
    }

    private func disarmSoftWatchdog(record: Context) {
        record.watchdogTimer?.cancel()
        record.watchdogTimer = nil
    }

    // MARK: - Kill

    /// Tear down a JS context. Order matters per the Pebble lesson
    /// (CrashReproducer.kt teardown race): cancel scheduled work first,
    /// drop references second, GC last. JSC's GC fires asynchronously
    /// after the JSContext is released — if we hadn't cancelled the
    /// timers and NACK watchdog, they'd fire against a freed context
    /// and crash with EXC_BAD_ACCESS.
    public func kill(packageName: String) {
        let record = lock.withLock { () -> Context? in
            let r = contexts[packageName]
            contexts[packageName] = nil
            return r
        }
        guard let record else { return }
        record.queue.sync {
            // 1) Cancel every scheduled timer (setTimeout/setInterval
            //    + NACK watchdog + soft watchdog) so no callback can
            //    fire against a freed JSContext.
            for (_, timer) in record.pendingTimers {
                timer.cancel()
            }
            record.pendingTimers.removeAll()
            record.readyNackTimer?.cancel()
            record.readyNackTimer = nil
            record.watchdogTimer?.cancel()
            record.watchdogTimer = nil
            // 2) Clear the exception handler so any in-flight throw on
            //    the same queue doesn't try to call back into a torn-down
            //    record. exceptionHandler captures `record` weakly so
            //    this isn't strictly required, but it makes the
            //    teardown order explicit.
            record.context.exceptionHandler = nil
            // 3) Force GC. The JSContext is freed by ARC when its
            //    last reference drops; this call ensures finalisers run
            //    on the per-context thread we own rather than on JSC's
            //    Heap Helper Thread.
            JSGarbageCollect(record.context.jsGlobalContextRef)
        }
        os_log("MentraJS: killed %{public}@", log: Self.log, type: .info, packageName)
    }

    // MARK: - Internals

    private func installNativeBridges(ctx: JSContext, record: Context) {
        // Critical: a SINGLE __dispatch block, per Pebble's CrashReproducer
        // warning. We MUST NOT bind individual native callbacks as JSValue
        // properties — JSC's GC races with ARC and crashes the host.
        let dispatchBlock: @convention(block) (String, String, String) -> JSValue? = { [weak self, weak record] iface, method, argsJson in
            guard let self, let record else { return nil }
            // Decode args envelope. Two shapes:
            //   1) one-shot: an array `[a1, a2, ...]`
            //   2) request:  `{args: [...], reqId: "1"}`
            var args: [Any] = []
            var reqId: String? = nil
            if argsJson.hasPrefix("{") {
                if let data = argsJson.data(using: .utf8),
                   let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let a = dict["args"] as? [Any] { args = a }
                    if let r = dict["reqId"] as? String { reqId = r }
                }
            } else if let data = argsJson.data(using: .utf8),
                      let a = try? JSONSerialization.jsonObject(with: data) as? [Any] {
                args = a
            }
            // Hand off to the dispatcher. The dispatcher returns either:
            //   - .sync result (sync handler) → returned to JS now
            //   - .async (request was dispatched, response will arrive via
            //     dispatchToJs at handler completion) → returns null to JS
            //   - .error → forwarded to JS as a thrown Error
            let outcome = self.dispatcher.handle(
                packageName: record.packageName,
                iface: iface,
                method: method,
                args: args,
                reqId: reqId
            )
            switch outcome {
            case .sync(let value):
                return JSCRuntime.jsValue(from: value, in: ctx)
            case .async:
                return JSValue(nullIn: ctx)
            case .error(let code, let message):
                let errPayload: [String: Any] = [
                    "code": code,
                    "message": message ?? "",
                ]
                let dictVal = JSValue(object: errPayload, in: ctx)
                let exception = ctx.evaluateScript("(function(p){var e = new Error(p.message||p.code); e.code = p.code; e.details = p.details; return e;})")?.call(withArguments: [dictVal as Any])
                ctx.exception = exception
                return nil
            case .forwardToRn(let payload):
                // For methods that we route through the RN adapter (display,
                // mic, etc.), we emit an outbound event and return null. The
                // RN side will eventually respond via dispatchToJs.
                var enveloped: [String: Any] = payload
                enveloped["packageName"] = record.packageName
                enveloped["iface"] = iface
                enveloped["method"] = method
                if let reqId { enveloped["reqId"] = reqId }
                self.lock.withLock { self._onOutbound }?(
                    OutboundMessage(packageName: record.packageName, payload: enveloped)
                )
                return JSValue(nullIn: ctx)
            }
        }
        ctx.setObject(dispatchBlock, forKeyedSubscript: "__dispatch" as NSString)

        // Host log sink — forwarded into Sentry breadcrumbs by RN.
        let hostLog: @convention(block) (String, String) -> Void = { [weak self, weak record] level, messageJson in
            guard let self, let record else { return }
            self.lock.withLock { self._onOutbound }?(
                OutboundMessage(
                    packageName: record.packageName,
                    payload: [
                        "packageName": record.packageName,
                        "iface": "__log",
                        "method": level,
                        "argsJson": messageJson,
                    ],
                )
            )
        }
        ctx.setObject(hostLog, forKeyedSubscript: "__hostLog" as NSString)

        let hostError: @convention(block) (String) -> Void = { [weak self, weak record] payloadJson in
            guard let self, let record else { return }
            self.lock.withLock { self._onOutbound }?(
                OutboundMessage(
                    packageName: record.packageName,
                    payload: [
                        "packageName": record.packageName,
                        "iface": "__error",
                        "method": "uncaught",
                        "argsJson": payloadJson,
                    ],
                )
            )
        }
        ctx.setObject(hostError, forKeyedSubscript: "__hostError" as NSString)

        let hostUnhandledRejection: @convention(block) (String) -> Void = { [weak self, weak record] payloadJson in
            guard let self, let record else { return }
            self.lock.withLock { self._onOutbound }?(
                OutboundMessage(
                    packageName: record.packageName,
                    payload: [
                        "packageName": record.packageName,
                        "iface": "__error",
                        "method": "unhandledRejection",
                        "argsJson": payloadJson,
                    ],
                )
            )
        }
        ctx.setObject(hostUnhandledRejection, forKeyedSubscript: "__hostUnhandledRejection" as NSString)

        // Timer plumbing — JS calls these to schedule wall-clock callbacks
        // and native fires globalThis.__deliverTimer(token) when each elapses.
        let nativeSetTimeout: @convention(block) (Int, Double) -> Void = { [weak self, weak record] token, delayMs in
            guard let self, let record else { return }
            let timer = DispatchSource.makeTimerSource(queue: record.queue)
            let interval = max(0, delayMs) / 1000.0
            timer.schedule(deadline: .now() + interval)
            timer.setEventHandler { [weak self, weak record] in
                guard let self, let record else { return }
                record.pendingTimers.removeValue(forKey: token)
                let src = "globalThis.__deliverTimer && globalThis.__deliverTimer(\(token));"
                _ = self.evaluateCatching(record: record, label: "timer:\(token)", source: src)
            }
            record.pendingTimers[token] = timer
            timer.resume()
        }
        ctx.setObject(nativeSetTimeout, forKeyedSubscript: "__nativeSetTimeout" as NSString)

        let nativeClearTimer: @convention(block) (Int) -> Void = { [weak record] token in
            guard let record else { return }
            record.queue.async {
                if let timer = record.pendingTimers.removeValue(forKey: token) {
                    timer.cancel()
                }
            }
        }
        ctx.setObject(nativeClearTimer, forKeyedSubscript: "__nativeClearTimer" as NSString)

        // Pebble's evalCatching pattern: install a global onerror trampoline
        // so syntax errors and synchronous throws are caught even when they
        // wouldn't otherwise fire window.onerror.
        ctx.exceptionHandler = { [weak self, weak record] _, exception in
            guard let self, let record, let exception else { return }
            let message = exception.toString() ?? "Unknown JS exception"
            let stack = exception.objectForKeyedSubscript("stack")?.toString() ?? ""
            self.lock.withLock { self._onOutbound }?(
                OutboundMessage(
                    packageName: record.packageName,
                    payload: [
                        "packageName": record.packageName,
                        "iface": "__error",
                        "method": "exception",
                        "argsJson": Self.jsonString(from: ["message": message, "stack": stack]) ?? "{}",
                    ],
                )
            )
            os_log("MentraJS exception in %{public}@: %{public}@",
                   log: Self.log, type: .error,
                   record.packageName, message)
        }
    }

    /// Run `source` inside `record.context` and report any thrown exception
    /// via the context's `exceptionHandler` (already wired). Returns true if
    /// no exception fired.
    @discardableResult
    private func evaluateCatching(record: Context, label: String, source: String) -> Bool {
        // The exception handler hook clears `context.exception` itself.
        record.context.exception = nil
        _ = record.context.evaluateScript(source)
        if let exception = record.context.exception {
            let msg = exception.toString() ?? "unknown"
            os_log("MentraJS [%{public}@] %{public}@ eval threw: %{public}@",
                   log: Self.log, type: .error,
                   record.packageName, label, msg)
            record.context.exception = nil
            return false
        }
        return true
    }

    // MARK: - Helpers

    fileprivate static func jsonString(from value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        return str
    }

    fileprivate static func jsStringLiteral(_ s: String) -> String {
        // Re-encode the JSON string into a JS string literal so the eval
        // path receives the same characters. JSONSerialization gives us the
        // safest path: dump as a single-element array and slice out the
        // quoted entry.
        if let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
           let arr = String(data: data, encoding: .utf8) {
            return String(arr.dropFirst().dropLast())
        }
        // Fallback: manual escape.
        return "\"" + s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            + "\""
    }

    fileprivate static func jsValue(from any: Any?, in ctx: JSContext) -> JSValue? {
        guard let any else { return JSValue(nullIn: ctx) }
        if let n = any as? NSNull { _ = n; return JSValue(nullIn: ctx) }
        return JSValue(object: any, in: ctx)
    }
}

/// Small Lock helper so we can use the trailing-closure `withLock` ergonomics
/// without importing the OSLock type. Plain NSLock; uncontended in practice
/// (the runtime only touches the map on spawn / kill / event delivery).
extension NSLock {
    @inlinable
    func withLock<T>(_ block: () -> T) -> T {
        lock()
        defer { unlock() }
        return block()
    }

    /// Void-returning overload so callers using the lock for state mutation
    /// don't get "result of call unused" warnings.
    @inlinable
    func withLockVoid(_ block: () -> Void) {
        lock()
        defer { unlock() }
        block()
    }
}
