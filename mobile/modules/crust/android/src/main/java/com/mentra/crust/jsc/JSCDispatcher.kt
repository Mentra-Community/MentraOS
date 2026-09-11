package com.mentra.crust.jsc

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.security.SecureRandom
import org.json.JSONArray

/**
 * MentraJS dispatch table + permission gate for the per-miniapp
 * `__dispatch(iface, method, args)` bridge. Symmetric with iOS
 * [JSCDispatcher.swift].
 *
 * Built-in local routes (handled inline, no RN round-trip):
 *  - `__runtime.ready`              — polyfill signals install complete
 *  - `localStorage.{get,set,remove,clear,key,length}` — SharedPreferences
 *  - `crypto.getRandomBytes`        — SecureRandom
 *
 * Everything else returns [JSCDispatchOutcome.ForwardToRn]; the RN-side
 * [MentraJSRouter] is the actual handler.
 */
sealed class JSCDispatchOutcome {
    /** Local sync handler returns a JSON string (or null for void). */
    data class Sync(val json: String?) : JSCDispatchOutcome()
    /** Handler accepted; response will arrive later via dispatchToJs. */
    object Async : JSCDispatchOutcome()
    /** Refused. JS sees a thrown Error with `code` + `message`. */
    data class Error(val code: String, val message: String?) : JSCDispatchOutcome()
    /** Forward to RN via the `mentrajs_message` Expo event. */
    data class ForwardToRn(val payload: Map<String, Any?>) : JSCDispatchOutcome()
}

data class InstalledMiniappManifest(val permissions: Set<String>)

class JSCDispatcher(private val appContext: Context) {
    companion object {
        private const val TAG = "MentraJS.Dispatcher"
    }

    private val routes = mutableMapOf<String, Handler>()
    private val manifests = mutableMapOf<String, InstalledMiniappManifest>()
    private val implicitGrants = setOf("STORAGE", "DISPLAY", "BUTTONS")
    private val random = SecureRandom()

    var permissionRequirements: Map<String, String> = mapOf(
        "mic" to "MICROPHONE",
        "transcription" to "MICROPHONE",
        "translation" to "MICROPHONE",
        "camera" to "CAMERA",
        "location" to "LOCATION",
        "navigation" to "LOCATION",
        "heading" to "LOCATION",
        "calendar" to "CALENDAR",
    )

    /** Handler runs on the JSContext's queue. */
    fun interface Handler {
        fun handle(packageName: String, args: List<Any?>, reqId: String?): JSCDispatchOutcome
    }

    init {
        installBuiltinRoutes()
    }

    fun register(iface: String, method: String, handler: Handler) {
        synchronized(routes) {
            routes["$iface.$method"] = handler
        }
    }

    fun unregister(iface: String, method: String) {
        synchronized(routes) {
            routes.remove("$iface.$method")
        }
    }

    fun setManifest(packageName: String, manifest: InstalledMiniappManifest) {
        synchronized(manifests) {
            manifests[packageName] = manifest
        }
    }

    fun clearManifest(packageName: String) {
        synchronized(manifests) {
            manifests.remove(packageName)
        }
    }

    fun manifest(packageName: String): InstalledMiniappManifest? {
        synchronized(manifests) {
            return manifests[packageName]
        }
    }

    /**
     * Main entry. Called from the `__dispatch` JS global installed on each
     * QuickJs context by [JSCRuntime.installGlobals]. The JS side invokes
     * `__dispatch(iface, method, argsJson)` and gets back a JSON string, null,
     * or a thrown Error.
     *
     * Permission gate: bridge-internal calls (`__runtime`, `__log`, crypto,
     * localStorage) are exempt — they don't touch OS sensors. For everything
     * else, only the manifest declaration matters. There is no JIT prompt;
     * install is the consent step (matches the cloud-WebView lifecycle).
     */
    fun handle(packageName: String, iface: String, method: String, args: List<Any?>, reqId: String?): JSCDispatchOutcome {
        val required = permissionRequirements[iface]
        if (required != null && required !in implicitGrants) {
            val declared = manifest(packageName)?.permissions ?: emptySet()
            if (required !in declared) {
                return JSCDispatchOutcome.Error("PERMISSION_NOT_DECLARED", required)
            }
        }
        val handler = synchronized(routes) { routes["$iface.$method"] }
        if (handler != null) {
            return handler.handle(packageName, args, reqId)
        }
        return JSCDispatchOutcome.ForwardToRn(mapOf("args" to args))
    }

    private fun installBuiltinRoutes() {
        register("__runtime", "ready") { packageName, _, _ ->
            JSCRuntime.shared(appContext).markReady(packageName)
            JSCDispatchOutcome.Sync("null")
        }

        // localStorage — SharedPreferences-backed, scoped per packageName.
        // String-only contract; the JS shim coerces non-strings via String(v).
        register("localStorage", "getItem") { pkg, args, _ ->
            val key = args.firstOrNull() as? String ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "localStorage.getItem(key)")
            val prefs = prefs(pkg)
            val v = prefs.getString(key, null)
            JSCDispatchOutcome.Sync(if (v == null) "null" else JSONArray().put(v).toString().let { arr -> arr.substring(1, arr.length - 1) })
        }
        register("localStorage", "setItem") { pkg, args, _ ->
            if (args.size < 2 || args[0] !is String || args[1] !is String) {
                return@register JSCDispatchOutcome.Error("INVALID_ARGS", "localStorage.setItem(key, value)")
            }
            prefs(pkg).edit().putString(args[0] as String, args[1] as String).apply()
            JSCDispatchOutcome.Sync("null")
        }
        register("localStorage", "removeItem") { pkg, args, _ ->
            val key = args.firstOrNull() as? String ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "localStorage.removeItem(key)")
            prefs(pkg).edit().remove(key).apply()
            JSCDispatchOutcome.Sync("null")
        }
        register("localStorage", "clear") { pkg, _, _ ->
            prefs(pkg).edit().clear().apply()
            JSCDispatchOutcome.Sync("null")
        }
        register("localStorage", "length") { pkg, _, _ ->
            JSCDispatchOutcome.Sync(prefs(pkg).all.size.toString())
        }
        register("localStorage", "key") { pkg, args, _ ->
            val idx = (args.firstOrNull() as? Number)?.toInt()
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "localStorage.key(index)")
            val keys = prefs(pkg).all.keys.sorted()
            if (idx < 0 || idx >= keys.size) {
                JSCDispatchOutcome.Sync("null")
            } else {
                val str = JSONArray().put(keys[idx]).toString()
                JSCDispatchOutcome.Sync(str.substring(1, str.length - 1))
            }
        }

        register("crypto", "getRandomBytes") { _, args, _ ->
            val n = (args.firstOrNull() as? Number)?.toInt()
                ?: return@register JSCDispatchOutcome.Error("INVALID_ARGS", "getRandomBytes(n)")
            if (n < 0 || n > (1 shl 20)) {
                return@register JSCDispatchOutcome.Error("INVALID_ARGS", "getRandomBytes max 1MB")
            }
            val bytes = ByteArray(n)
            try {
                random.nextBytes(bytes)
            } catch (e: Throwable) {
                Log.w(TAG, "SecureRandom failed: ${e.message}")
                return@register JSCDispatchOutcome.Error("NATIVE_THROW", "SecureRandom: ${e.message}")
            }
            // Return as JSON array of unsigned bytes.
            val arr = JSONArray()
            for (b in bytes) arr.put(b.toInt() and 0xff)
            JSCDispatchOutcome.Sync(arr.toString())
        }
    }

    private fun prefs(packageName: String): SharedPreferences {
        return appContext.getSharedPreferences("MentraJS-$packageName", Context.MODE_PRIVATE)
    }
}
