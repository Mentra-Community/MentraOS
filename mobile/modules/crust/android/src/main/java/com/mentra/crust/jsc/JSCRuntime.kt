package com.mentra.crust.jsc

import android.content.Context
import android.util.Log
import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/**
 * Thrown from the `__dispatch` binding to propagate a structured MentraJS
 * dispatch failure (PERMISSION_NOT_DECLARED / INVALID_ARGS / etc.) back to
 * the calling JS frame. Dokar3 surfaces Kotlin throwables from bindings as
 * JS-side `throw new Error(message)`, so the SDK's send-request Promise
 * correctly rejects with a real Error.
 */
class MentraJSDispatchError(val code: String, message: String) : RuntimeException("$code: $message")

/**
 * MentraJS — per-miniapp QuickJS runtime host on Android.
 *
 * Owns N QuickJs instances (via dokar3/quickjs-kt) keyed by packageName.
 * Each context gets:
 *   - its own QuickJs (heap isolation; QuickJS is single-threaded so we hop
 *     every operation onto the context's dedicated SingleThreadExecutor).
 *   - six host-callable globals installed at spawn time
 *     (`__dispatch`, `__hostLog`, `__hostError`, `__hostUnhandledRejection`,
 *     `__nativeSetTimeout`, `__nativeClearTimer`) via dokar3's
 *     `QuickJs.function(name) { args -> ... }` extension. This maps directly
 *     to `JS_SetPropertyStr(JS_NewCFunction(...))` on the QuickJS C API and
 *     mirrors iOS Apple JSC's `ctx.setObject(closure, forKeyedSubscript:)`
 *     pattern point-for-point.
 *   - the polyfill bundle pre-evaluated before any miniapp code runs.
 *
 * Symmetric with iOS [JSCRuntime.swift]. The class name keeps the "JSC"
 * prefix on Android even though the engine is QuickJS — cross-platform
 * parity for log filters, Sentry tags, and developer mental model.
 *
 * Dokar3 drains pending Promise jobs after every `evaluate(...)` and after
 * every async-binding completion via QuickJS's `JS_ExecutePendingJob` loop,
 * so we don't need to manually pump microtasks.
 *
 * Threading rule: every QuickJs operation must run on its context's
 * dedicated executor thread. We `executor.submit { runBlocking { qjs.evaluate(...) } }`
 * to satisfy both dokar3's coroutine entry point and the thread-affinity
 * invariant. We pass `Dispatchers.Unconfined` to `QuickJs.create()` so
 * async-job callbacks resume on whatever thread completes them (the
 * executor thread, since we hop there via `executor.submit`); passing
 * `executor.asCoroutineDispatcher()` instead would deadlock because
 * `runBlocking(dispatcher)` parks the executor thread inside its own event
 * loop and the dispatcher would try to schedule continuations back through
 * the same executor's task queue, which is no longer being drained.
 *
 * Re-entrancy rule: bindings must NOT call `qjs.evaluate(...)` on the same
 * instance — dokar3 holds an internal mutex across evaluate, and a binding
 * that re-enters would deadlock. Our `__dispatch` returns a string and may
 * throw, but never re-evaluates JS, so this rule is satisfied by
 * construction. Future bindings must observe it.
 */
class JSCRuntime private constructor(private val appContext: Context) {
    companion object {
        private const val TAG = "MentraJS"

        // NACK cold-start timeout (15s — covers polyfill + init on slow devices).
        const val COLD_START_NACK_TIMEOUT_MS: Long = 15_000
        // Steady-state NACK — wedged-JSContext detection.
        const val STEADY_STATE_NACK_TIMEOUT_MS: Long = 3_000
        // Soft watchdog warn / kill thresholds (matches iOS).
        const val WATCHDOG_WARN_MS: Long = 5_000
        const val WATCHDOG_KILL_MS: Long = 30_000

        @Volatile
        private var instance: JSCRuntime? = null

        fun shared(appContext: Context): JSCRuntime {
            return instance ?: synchronized(this) {
                instance ?: JSCRuntime(appContext.applicationContext).also { instance = it }
            }
        }
    }

    /**
     * Subscribe to outbound `mentrajs_message` events. Set by [CrustModule]
     * during `OnCreate` (or lazily on `mentraJsSpawn` if reactContext was
     * null at OnCreate time). The runtime fires this for every __dispatch
     * call that has no matching local route in [JSCDispatcher]. If this is
     * still null when a __dispatch arrives, the frame is silently dropped
     * — we log a one-time warning at the first drop and count subsequent
     * ones, since otherwise a miniapp will just look dead with no error
     * trail.
     */
    @Volatile
    private var _onOutbound: ((OutboundMessage) -> Unit)? = null
    var onOutbound: ((OutboundMessage) -> Unit)?
        get() = _onOutbound
        set(value) {
            val prev = _onOutbound
            _onOutbound = value
            if (value != null && prev == null) {
                Log.i(TAG, "onOutbound sink installed (dropped frames before this: $droppedOutboundCount)")
            } else if (value == null) {
                Log.w(TAG, "onOutbound sink cleared")
            }
        }

    @Volatile private var droppedOutboundCount: Int = 0
    private fun deliverOrDrop(message: OutboundMessage) {
        val sink = _onOutbound
        if (sink != null) {
            sink.invoke(message)
            return
        }
        val n = ++droppedOutboundCount
        if (n == 1 || n % 50 == 0) {
            val iface = message.payload["iface"]
            val method = message.payload["method"]
            Log.w(TAG, "outbound dropped (no sink): ${message.packageName} $iface.$method [drop #$n]")
        }
    }

    data class OutboundMessage(
        val packageName: String,
        val payload: Map<String, Any?>,
    )

    val dispatcher: JSCDispatcher = JSCDispatcher(appContext)

    private val contexts = ConcurrentHashMap<String, ContextRecord>()
    private val polyfillBundle: String by lazy { loadPolyfillBundle() }

    // Schedule pool for timers; per-context the executor is the same as the
    // QuickJs single-thread executor, so timer fires happen on the JS thread.
    private val timerScheduler: ScheduledExecutorService =
        Executors.newScheduledThreadPool(1) { r ->
            Thread(r, "MentraJS-timer-scheduler").apply { isDaemon = true }
        }

    private inner class ContextRecord(
        val packageName: String,
        val qjs: QuickJs,
        val executor: ExecutorService,
        val pendingTimers: MutableMap<Int, ScheduledFuture<*>> = ConcurrentHashMap(),
        @Volatile var readyAcked: Boolean = false,
        @Volatile var readyNackTimer: ScheduledFuture<*>? = null,
        @Volatile var watchdogTimer: ScheduledFuture<*>? = null,
    )

    /**
     * Called from the dispatcher's __runtime.ready route when the polyfill
     * finishes installing. Clears the cold-start NACK timer.
     */
    fun markReady(packageName: String) {
        val record = contexts[packageName] ?: return
        record.readyAcked = true
        record.readyNackTimer?.cancel(false)
        record.readyNackTimer = null
    }

    private fun armReadyNackTimer(record: ContextRecord, timeoutMs: Long, cold: Boolean) {
        record.readyNackTimer?.cancel(false)
        val future = timerScheduler.schedule({
            val phase = if (cold) "cold-start" else "steady-state"
            Log.e(
                TAG,
                "NACK: ${record.packageName} $phase ready signal not received in ${timeoutMs}ms",
            )
            deliverOrDrop(
                OutboundMessage(
                    record.packageName,
                    mapOf(
                        "packageName" to record.packageName,
                        "iface" to "__error",
                        "method" to "ready_nack",
                        "argsJson" to org.json.JSONObject(
                            mapOf("phase" to phase, "timeoutMs" to timeoutMs) as Map<*, *>,
                        ).toString(),
                    ),
                )
            )
            record.readyNackTimer = null
        }, timeoutMs, TimeUnit.MILLISECONDS)
        record.readyNackTimer = future
    }

    /**
     * Diagnostic: ask QuickJS to GC. Returns false when the context is dead.
     */
    fun debugForceGC(packageName: String): Boolean {
        val record = contexts[packageName] ?: return false
        return try {
            record.executor.submit {
                try {
                    record.qjs.gc()
                } catch (_: Throwable) { /* ignore */ }
            }
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun isAlive(packageName: String): Boolean = contexts.containsKey(packageName)

    fun alivePackages(): List<String> = contexts.keys.toList()

    /**
     * Read the bundled MentraJS polyfill (`assets/startup.js`) shipped
     * inside the host APK. The file is sourced from the sibling
     * @mentra/jspolyfill module via `sourceSets.main.assets.srcDirs`
     * in this module's build.gradle. Cached after first read.
     */
    fun loadPolyfillBundle(): String {
        try {
            appContext.assets.open("startup.js").use { stream ->
                return stream.bufferedReader().readText()
            }
        } catch (e: IOException) {
            Log.e(TAG, "polyfill bundle missing from assets", e)
            return ""
        }
    }

    /**
     * Spawn a per-miniapp QuickJs context. Re-spawn is allowed — a live
     * context for the same package is killed first.
     *
     * Returns true on success. The polyfill + miniapp source are evaluated
     * synchronously on the new context's executor; this method waits for
     * both evals to complete before returning.
     */
    fun spawn(packageName: String, polyfillBundleOverride: String?, miniappJs: String): Boolean {
        if (isAlive(packageName)) {
            kill(packageName)
        }
        val executor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "MentraJS-$packageName").apply { isDaemon = true }
        }

        // Create the QuickJs context ON the executor thread. We pass
        // `Dispatchers.Unconfined` as the jobDispatcher: dokar3 only uses it
        // to schedule async-job callbacks via `coroutineScope.launch`. If we
        // passed `executor.asCoroutineDispatcher()` instead, then
        // `runBlocking(dispatcher) { evaluate(...) }` would deadlock —
        // runBlocking parks the executor thread inside its own event loop,
        // but the dispatcher tries to schedule the suspend body back through
        // the same executor's task queue, which is no longer being drained.
        // With Unconfined the suspend continuations resume on whatever thread
        // completes them — which, since every operation is hopped onto the
        // executor via `executor.submit { ... }`, is always the same thread T.
        // The dokar3 internal jsMutex serializes any cross-thread access
        // anyway, so this is safe.
        val qjs = try {
            executor.submit<QuickJs> {
                QuickJs.create(Dispatchers.Unconfined).apply {
                    memoryLimit = 32L * 1024 * 1024     // 32 MB heap per miniapp
                    maxStackSize = 512L * 1024          // 512 KB stack
                }
            }.get()
        } catch (e: Throwable) {
            Log.e(TAG, "QuickJs.create() failed for $packageName", e)
            executor.shutdownNow()
            return false
        }

        val record = ContextRecord(
            packageName = packageName,
            qjs = qjs,
            executor = executor,
        )
        contexts[packageName] = record

        // Arm cold-start NACK before the first eval — catches a wedged
        // polyfill or miniapp init. Cleared by markReady() when the
        // polyfill bundle's __dispatch("__runtime", "ready") lands.
        armReadyNackTimer(record, COLD_START_NACK_TIMEOUT_MS, cold = true)

        val bundle = polyfillBundleOverride ?: polyfillBundle

        return try {
            executor.submit<Boolean> {
                runBlocking {
                    installGlobals(qjs, packageName)
                    if (bundle.isNotEmpty()) {
                        qjs.evaluate<Any?>(bundle, filename = "mentrajs:startup.js")
                    }
                    if (miniappJs.isNotEmpty()) {
                        qjs.evaluate<Any?>(miniappJs, filename = "mentrajs:miniapp.js")
                    }
                }
                Log.i(TAG, "spawned $packageName")
                true
            }.get()
        } catch (e: Throwable) {
            Log.e(TAG, "spawn failed for $packageName: ${e.message}", e)
            kill(packageName)
            false
        }
    }

    /**
     * Install the six host-callable JS globals on `qjs`'s `globalThis`,
     * mirroring iOS `JSCRuntime.swift:497–574`. Must run on the context's
     * executor thread; dokar3's `function` extension is sync.
     */
    private fun installGlobals(qjs: QuickJs, packageName: String) {
        // __dispatch: sync. Returns JSON or null. Throws on dispatcher Error.
        qjs.function("__dispatch") { args ->
            // Bail if the context was killed mid-dispatch. The JS frame won't
            // see this return because dokar3 will have already torn down the
            // engine — but it's defensive against the brief window where the
            // QuickJs is alive but the host has dropped the record.
            if (contexts[packageName] == null) return@function null
            val iface = args[0] as? String
                ?: throw MentraJSDispatchError("INVALID_ARGS", "iface")
            val method = args[1] as? String
                ?: throw MentraJSDispatchError("INVALID_ARGS", "method")
            val argsJson = args[2] as? String
                ?: throw MentraJSDispatchError("INVALID_ARGS", "argsJson")
            val parsed = parseArgsEnvelope(argsJson)
            val outcome = dispatcher.handle(
                packageName = packageName,
                iface = iface,
                method = method,
                args = parsed.first,
                reqId = parsed.second,
            )
            when (outcome) {
                is JSCDispatchOutcome.Sync -> outcome.json
                is JSCDispatchOutcome.Async -> null
                is JSCDispatchOutcome.Error ->
                    throw MentraJSDispatchError(outcome.code, outcome.message ?: outcome.code)
                is JSCDispatchOutcome.ForwardToRn -> {
                    val payload = HashMap<String, Any?>(outcome.payload)
                    payload["packageName"] = packageName
                    payload["iface"] = iface
                    payload["method"] = method
                    parsed.second?.let { payload["reqId"] = it }
                    deliverOrDrop(OutboundMessage(packageName, payload))
                    null
                }
            }
        }

        // __hostLog: fire-and-forget. Routes to __log outbound.
        qjs.function<Unit>("__hostLog") { args ->
            deliverOrDrop(
                OutboundMessage(
                    packageName,
                    mapOf(
                        "packageName" to packageName,
                        "iface" to "__log",
                        "method" to (args[0] as? String ?: "log"),
                        "argsJson" to (args[1] as? String ?: "[]"),
                    ),
                )
            )
        }

        // __hostError: window.onerror trampoline.
        qjs.function<Unit>("__hostError") { args ->
            deliverOrDrop(
                OutboundMessage(
                    packageName,
                    mapOf(
                        "packageName" to packageName,
                        "iface" to "__error",
                        "method" to "uncaught",
                        "argsJson" to (args[0] as? String ?: "{}"),
                    ),
                )
            )
        }

        // __hostUnhandledRejection: Promise unhandledrejection trampoline.
        qjs.function<Unit>("__hostUnhandledRejection") { args ->
            deliverOrDrop(
                OutboundMessage(
                    packageName,
                    mapOf(
                        "packageName" to packageName,
                        "iface" to "__error",
                        "method" to "unhandledRejection",
                        "argsJson" to (args[0] as? String ?: "{}"),
                    ),
                )
            )
        }

        // __nativeSetTimeout: schedule wallclock callback. Fires __deliverTimer.
        qjs.function<Unit>("__nativeSetTimeout") { args ->
            val token = (args[0] as? Number)?.toInt() ?: return@function
            val delayMs = (args[1] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L
            scheduleTimer(packageName, token, delayMs)
        }

        // __nativeClearTimer: cancel scheduled.
        qjs.function<Unit>("__nativeClearTimer") { args ->
            val token = (args[0] as? Number)?.toInt() ?: return@function
            contexts[packageName]?.pendingTimers?.remove(token)?.cancel(false)
        }
    }

    private fun scheduleTimer(packageName: String, token: Int, delayMs: Long) {
        val record = contexts[packageName] ?: return
        val future = timerScheduler.schedule({
            record.pendingTimers.remove(token)
            try {
                record.executor.submit {
                    runBlocking {
                        try {
                            record.qjs.evaluate<Any?>(
                                "globalThis.__deliverTimer && globalThis.__deliverTimer($token);",
                                filename = "mentrajs:timer-$token.js",
                            )
                        } catch (e: Throwable) {
                            Log.w(TAG, "timer fire threw in $packageName: ${e.message}")
                        }
                    }
                }
            } catch (_: java.util.concurrent.RejectedExecutionException) {
                // Context already killed — drop silently.
            }
        }, delayMs, TimeUnit.MILLISECONDS)
        record.pendingTimers[token] = future
    }

    /**
     * Run arbitrary JS in the named context. Returns the JS return value
     * coerced to a JSON-friendly type (string for objects, primitives
     * passthrough). Returns null if the context is dead or eval threw.
     */
    fun evaluate(packageName: String, source: String): Any? {
        val record = contexts[packageName] ?: return null
        return try {
            record.executor.submit<Any?> {
                runBlocking {
                    record.qjs.evaluate<Any?>(
                        source,
                        filename = "mentrajs:eval-${System.nanoTime()}.js",
                    )
                }
            }.get()
        } catch (e: Throwable) {
            Log.w(TAG, "evaluate threw in $packageName: ${e.message}")
            null
        }
    }

    /**
     * Push a `{kind: "event"|"response", …}` envelope into the named
     * context's globalThis.__deliver. Hops onto the per-context executor.
     */
    fun dispatchToJs(packageName: String, envelopeJson: String) {
        val record = contexts[packageName] ?: return
        try {
            record.executor.submit {
                // Arm only once evaluate is about to run. Queue wait during a
                // long previous turn (WHIP start, etc.) must not count — that
                // was firing ready_nack while the context was merely busy.
                if (record.readyAcked) {
                    armReadyNackTimer(record, STEADY_STATE_NACK_TIMEOUT_MS, cold = false)
                }
                // Soft watchdog around evaluate: warn at 5s, kill at 30s.
                val warn = timerScheduler.schedule({
                    Log.i(TAG, "watchdog: $packageName __deliver blocked >${WATCHDOG_WARN_MS}ms")
                }, WATCHDOG_WARN_MS, TimeUnit.MILLISECONDS)
                val killTimer = timerScheduler.schedule({
                    Log.e(TAG, "watchdog: $packageName blocked >${WATCHDOG_KILL_MS}ms, killing")
                    deliverOrDrop(
                        OutboundMessage(
                            packageName,
                            mapOf(
                                "packageName" to packageName,
                                "iface" to "__error",
                                "method" to "watchdog_kill",
                                "argsJson" to org.json.JSONObject(
                                    mapOf("thresholdMs" to WATCHDOG_KILL_MS) as Map<*, *>,
                                ).toString(),
                            ),
                        )
                    )
                    kill(packageName)
                }, WATCHDOG_KILL_MS, TimeUnit.MILLISECONDS)
                record.watchdogTimer = killTimer
                try {
                    val source = "globalThis.__deliver(${jsStringLiteral(envelopeJson)});"
                    runBlocking {
                        record.qjs.evaluate<Any?>(source, filename = "mentrajs:deliver.js")
                    }
                } catch (e: Throwable) {
                    Log.w(TAG, "dispatchToJs threw in $packageName: ${e.message}", e)
                } finally {
                    // Success or throw: the host observed the turn end.
                    record.readyNackTimer?.cancel(false)
                    record.readyNackTimer = null
                    warn.cancel(false)
                    killTimer.cancel(false)
                    if (record.watchdogTimer === killTimer) record.watchdogTimer = null
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // Context killed mid-flight — drop. dispatchToJs is best-effort.
        }
    }

    fun kill(packageName: String) {
        val record = contexts.remove(packageName) ?: return
        // Cancel timers first so no scheduled fire-callback grabs the
        // QuickJs after it's closed. Order matches the iOS teardown:
        // setTimeout/setInterval → NACK watchdog → soft watchdog →
        // close(qjs) → executor.shutdown.
        for ((_, future) in record.pendingTimers) {
            future.cancel(false)
        }
        record.pendingTimers.clear()
        record.readyNackTimer?.cancel(false)
        record.readyNackTimer = null
        record.watchdogTimer?.cancel(false)
        record.watchdogTimer = null
        try {
            record.executor.submit {
                try {
                    record.qjs.close()
                } catch (e: Throwable) {
                    Log.w(TAG, "QuickJs.close() threw for $packageName: ${e.message}")
                }
            }.get(2, TimeUnit.SECONDS)
        } catch (e: Throwable) {
            Log.w(TAG, "killed $packageName but cleanup hit ${e.javaClass.simpleName}")
        } finally {
            record.executor.shutdownNow()
        }
        Log.i(TAG, "killed $packageName")
    }

    // ------------------------------------------------------------------

    private fun parseArgsEnvelope(argsJson: String): Pair<List<Any?>, String?> {
        return try {
            if (argsJson.startsWith("{")) {
                val obj = org.json.JSONObject(argsJson)
                val args = obj.optJSONArray("args")?.let(::jsonArrayToList) ?: emptyList()
                val reqId = if (obj.has("reqId")) obj.optString("reqId").takeIf { it.isNotEmpty() } else null
                args to reqId
            } else {
                jsonArrayToList(org.json.JSONArray(argsJson)) to null
            }
        } catch (_: Throwable) {
            emptyList<Any?>() to null
        }
    }

    private fun jsonArrayToList(arr: org.json.JSONArray): List<Any?> {
        val out = ArrayList<Any?>(arr.length())
        for (i in 0 until arr.length()) {
            out += jsonValueToAny(arr.opt(i))
        }
        return out
    }

    private fun jsonValueToAny(v: Any?): Any? {
        return when (v) {
            null, org.json.JSONObject.NULL -> null
            is org.json.JSONArray -> jsonArrayToList(v)
            is org.json.JSONObject -> {
                val m = HashMap<String, Any?>(v.length())
                val it = v.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    m[k] = jsonValueToAny(v.opt(k))
                }
                m
            }
            else -> v
        }
    }

    private fun jsStringLiteral(s: String): String {
        // Re-encode via JSONArray so quotes / backslashes / control chars
        // are escaped correctly for embedding in a JS source string.
        return org.json.JSONArray().put(s).toString().let { arr ->
            arr.substring(1, arr.length - 1)
        }
    }
}
