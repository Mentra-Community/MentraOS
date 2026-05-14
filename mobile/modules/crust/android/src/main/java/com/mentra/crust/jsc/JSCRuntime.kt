package com.mentra.crust.jsc

import android.content.Context
import android.util.Log
import app.cash.zipline.QuickJs
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * MentraJS — per-miniapp QuickJS (via Cash App's Zipline) runtime host on Android.
 *
 * Owns N QuickJs instances keyed by packageName. Each context gets:
 *   - its own QuickJs (heap isolation; Zipline's runtime is single-threaded so
 *     we hop every operation onto the context's dedicated SingleThreadExecutor).
 *   - the polyfill bundle pre-evaluated before any miniapp code runs
 *   - a single `__dispatch(iface, method, argsJson)` global routed through
 *     [JSCDispatcher].
 *
 * Symmetric with iOS [JSCRuntime.swift]. The class name keeps the "JSC"
 * prefix on Android even though the engine is QuickJS — cross-platform parity
 * for log filters, Sentry tags, and developer mental model.
 *
 * QuickJS does not drain Promise reactions on its own; Zipline drains them
 * during bridge re-entry. Every native callback that needs to resolve a JS
 * Promise routes back through `evaluate(...)` (the polyfill's __deliver),
 * which is a fresh bridge entry — so the drain happens naturally without
 * exposing `JS_ExecutePendingJob`. See the spec's "Mandatory microtask
 * discipline (Android only)" section.
 */
class JSCRuntime private constructor(private val appContext: Context) {
    companion object {
        private const val TAG = "MentraJS"

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
     * during `OnCreate`; the runtime fires this for every __dispatch call
     * that has no matching local route in [JSCDispatcher].
     */
    @Volatile
    var onOutbound: ((OutboundMessage) -> Unit)? = null

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
        val quickJs: QuickJs,
        val executor: java.util.concurrent.ExecutorService,
        val pendingTimers: MutableMap<Int, ScheduledFuture<*>> = ConcurrentHashMap(),
    )

    fun isAlive(packageName: String): Boolean = contexts.containsKey(packageName)

    fun alivePackages(): List<String> = contexts.keys.toList()

    /**
     * Read the bundled MentraJS polyfill (`assets/mentrajs_startup.js`)
     * shipped inside the host APK. Cached after first read.
     */
    fun loadPolyfillBundle(): String {
        try {
            appContext.assets.open("mentrajs_startup.js").use { stream ->
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
        val quickJs = try {
            executor.submit<QuickJs> { QuickJs.create() }.get()
        } catch (e: Throwable) {
            Log.e(TAG, "QuickJs.create() failed for $packageName", e)
            executor.shutdownNow()
            return false
        }
        val record = ContextRecord(packageName, quickJs, executor)
        contexts[packageName] = record

        val bundle = polyfillBundleOverride ?: polyfillBundle

        // Bind the native interface BEFORE evaluating any JS. Zipline / QuickJs
        // bound objects show up as JS globals with the same name as the
        // proxy interface; we declare a NativeBridge interface and set an
        // instance of [JSCBridgeImpl] under the name `__mentraNativeBridge`.
        return try {
            executor.submit<Boolean> {
                val bridge = JSCBridgeImpl(packageName)
                quickJs.set("__mentraNativeBridge", NativeBridge::class.java, bridge)
                // Glue layer: forward globalThis.__dispatch / __hostLog / etc
                // onto the bound object. Done in JS rather than via individual
                // bindings to keep the surface symmetric with iOS-JSC and avoid
                // multiple Kotlin proxy types.
                quickJs.evaluate(GLUE_SCRIPT, "mentrajs:glue.js")
                if (bundle.isNotEmpty()) {
                    quickJs.evaluate(bundle, "mentrajs:startup.js")
                }
                if (miniappJs.isNotEmpty()) {
                    quickJs.evaluate(miniappJs, "mentrajs:miniapp.js")
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
     * Run arbitrary JS in the named context. Returns the JS return value
     * coerced to a JSON-friendly type (string for objects, primitives
     * passthrough). Returns null if the context is dead or eval threw.
     */
    fun evaluate(packageName: String, source: String): Any? {
        val record = contexts[packageName] ?: return null
        return try {
            record.executor.submit<Any?> {
                record.quickJs.evaluate(source, "mentrajs:eval-${System.nanoTime()}.js")
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
        record.executor.submit {
            try {
                val source = "globalThis.__deliver(${jsStringLiteral(envelopeJson)});"
                record.quickJs.evaluate(source, "mentrajs:deliver.js")
            } catch (e: Throwable) {
                Log.w(TAG, "dispatchToJs threw in $packageName: ${e.message}")
            }
        }
    }

    fun kill(packageName: String) {
        val record = contexts.remove(packageName) ?: return
        // Cancel timers first so no scheduled fire-callback grabs the
        // QuickJs after it's closed.
        for ((_, future) in record.pendingTimers) {
            future.cancel(false)
        }
        record.pendingTimers.clear()
        try {
            record.executor.submit {
                try {
                    record.quickJs.close()
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
    // Bridge implementation — bound to JS via `__mentraNativeBridge`.
    // ------------------------------------------------------------------

    /**
     * The JS-facing surface. QuickJs binds Kotlin interfaces by reflection;
     * methods are visible on the JS side as properties on the bound object.
     */
    interface NativeBridge {
        /** Synchronous dispatch — return value is a JSON string (or null). */
        fun dispatch(iface: String, method: String, argsJson: String): String?
        /** Console.* sink — `level` ∈ "log"|"info"|"warn"|"error"|... */
        fun hostLog(level: String, messageJson: String)
        /** window.onerror trampoline. */
        fun hostError(payloadJson: String)
        /** Promise unhandledrejection trampoline. */
        fun hostUnhandledRejection(payloadJson: String)
        /** Schedule a wall-clock callback. JS fires __deliverTimer(token). */
        fun setTimerNative(token: Int, delayMs: Int)
        /** Cancel a previously-scheduled timer. */
        fun clearTimerNative(token: Int)
    }

    private inner class JSCBridgeImpl(private val packageName: String) : NativeBridge {
        override fun dispatch(iface: String, method: String, argsJson: String): String? {
            val record = contexts[packageName] ?: return null
            val argsAndReqId = parseArgsEnvelope(argsJson)
            val outcome = dispatcher.handle(
                packageName = packageName,
                iface = iface,
                method = method,
                args = argsAndReqId.first,
                reqId = argsAndReqId.second,
            )
            return when (outcome) {
                is JSCDispatchOutcome.Sync -> outcome.json
                is JSCDispatchOutcome.Async -> null
                is JSCDispatchOutcome.Error -> {
                    // Inject a JS throw so the polyfill's send-request path
                    // rejects with a proper Error object.
                    val msg = (outcome.message ?: outcome.code).replace("\"", "\\\"")
                    val throwScript = "(function(){ var e = new Error(\"$msg\"); e.code = \"${outcome.code}\"; throw e; })()"
                    try {
                        record.executor.submit {
                            record.quickJs.evaluate(throwScript, "mentrajs:dispatch-error.js")
                        }
                    } catch (_: Throwable) {
                        /* ignore — error already surfaced via return */
                    }
                    null
                }
                is JSCDispatchOutcome.ForwardToRn -> {
                    val payload = HashMap<String, Any?>(outcome.payload)
                    payload["packageName"] = packageName
                    payload["iface"] = iface
                    payload["method"] = method
                    argsAndReqId.second?.let { payload["reqId"] = it }
                    onOutbound?.invoke(OutboundMessage(packageName, payload))
                    null
                }
            }
        }

        override fun hostLog(level: String, messageJson: String) {
            onOutbound?.invoke(
                OutboundMessage(
                    packageName,
                    mapOf(
                        "packageName" to packageName,
                        "iface" to "__log",
                        "method" to level,
                        "argsJson" to messageJson,
                    ),
                )
            )
        }

        override fun hostError(payloadJson: String) {
            onOutbound?.invoke(
                OutboundMessage(
                    packageName,
                    mapOf(
                        "packageName" to packageName,
                        "iface" to "__error",
                        "method" to "uncaught",
                        "argsJson" to payloadJson,
                    ),
                )
            )
        }

        override fun hostUnhandledRejection(payloadJson: String) {
            onOutbound?.invoke(
                OutboundMessage(
                    packageName,
                    mapOf(
                        "packageName" to packageName,
                        "iface" to "__error",
                        "method" to "unhandledRejection",
                        "argsJson" to payloadJson,
                    ),
                )
            )
        }

        override fun setTimerNative(token: Int, delayMs: Int) {
            val record = contexts[packageName] ?: return
            val future = timerScheduler.schedule({
                record.pendingTimers.remove(token)
                record.executor.submit {
                    try {
                        record.quickJs.evaluate(
                            "globalThis.__deliverTimer && globalThis.__deliverTimer($token);",
                            "mentrajs:timer-$token.js",
                        )
                    } catch (e: Throwable) {
                        Log.w(TAG, "timer fire threw in $packageName: ${e.message}")
                    }
                }
            }, delayMs.toLong().coerceAtLeast(0), TimeUnit.MILLISECONDS)
            record.pendingTimers[token] = future
        }

        override fun clearTimerNative(token: Int) {
            val record = contexts[packageName] ?: return
            record.pendingTimers.remove(token)?.cancel(false)
        }
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
        // Re-encode via JSONObject so quotes / backslashes / control chars
        // are escaped correctly for embedding in a JS source string.
        return org.json.JSONArray().put(s).toString().let { arr ->
            arr.substring(1, arr.length - 1)
        }
    }

    private val GLUE_SCRIPT: String = """
        (function () {
          var bridge = globalThis.__mentraNativeBridge;
          if (!bridge) return;
          globalThis.__dispatch = function (iface, method, argsJson) {
            return bridge.dispatch(iface, method, argsJson);
          };
          globalThis.__hostLog = function (level, messageJson) {
            bridge.hostLog(level, messageJson);
          };
          globalThis.__hostError = function (payloadJson) {
            bridge.hostError(payloadJson);
          };
          globalThis.__hostUnhandledRejection = function (payloadJson) {
            bridge.hostUnhandledRejection(payloadJson);
          };
          globalThis.__nativeSetTimeout = function (token, delayMs) {
            bridge.setTimerNative(token | 0, delayMs | 0);
          };
          globalThis.__nativeClearTimer = function (token) {
            bridge.clearTimerNative(token | 0);
          };
        })();
    """.trimIndent()
}
