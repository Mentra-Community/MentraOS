package com.mentra.bluetoothsdk.sgcs

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import com.mentra.bluetoothsdk.DeviceManager
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID

/** Fixed, DUMP-protected debug commands. Expected address is comparison-only, never a connection target.
 * No packet, device-command, caller path, reset, bond or radio inputs are accepted. */
internal object NimoResourceDiagnostics {
    const val ACTION = "com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE"
    private val main = Handler(Looper.getMainLooper())
    private val processInstanceId = UUID.randomUUID().toString()
    private data class Observed(val instance: WeakReference<Nimo>, var tombstone: JSONObject)
    private val sessions = linkedMapOf<String, Observed>()
    private var registered = false
    private var application: Context? = null
    private val requests = linkedSetOf<String>()

    fun start(context: Context) {
        if (Looper.myLooper() != main.looper) { main.post { start(context) }; return }
        if (registered) return
        val app = context.applicationContext
        val filter = IntentFilter(ACTION)
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, filter, "android.permission.DUMP", main, Context.RECEIVER_EXPORTED)
        else { @Suppress("DEPRECATION") app.registerReceiver(receiver, filter, "android.permission.DUMP", main) }
        application = app
        registered = true
    }

    fun track(instance: Nimo) {
        check(Looper.myLooper() == main.looper)
        val snapshot = instance.resourceSnapshot()
        sessions["${instance.resourceInstanceId}:${snapshot.getLong("sessionGeneration")}"] = Observed(WeakReference(instance), snapshot)
        while (sessions.size > 8) sessions.remove(sessions.keys.first())
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION) return
            try { execute(intent) } catch (_: Exception) { /* No receipt means unknown; never crash the product app. */ }
        }
    }

    /** Separate from BroadcastReceiver for source tests; no exported unrestricted app API. */
    internal fun execute(intent: Intent) {
        check(Looper.myLooper() == main.looper)
        val nonce = intent.getStringExtra("nonce") ?: return
        if (!uuid(nonce) || nonce in requests) return
        val app = application ?: return
        val root = File(app.filesDir, "nimo-lifecycle")
        if ((!root.isDirectory && !root.mkdir()) || File(root, "$nonce.json").exists()) return
        requests.add(nonce)
        while (requests.size > 128) requests.remove(requests.first())
        val mode = intent.getStringExtra("mode") ?: "status"
        val address = intent.getStringExtra("expectedAddress") ?: ""
        val instanceId = intent.getStringExtra("instanceId")
        val generation = intent.getLongExtra("sessionGeneration", -1)
        val request = JSONObject().put("nonce", nonce).put("mode", mode).put("expectedAddress", address)
            .put("instanceId", instanceId ?: JSONObject.NULL).put("sessionGeneration", if (generation >= 0) generation else JSONObject.NULL)
        fun save(session: JSONObject?, error: String? = null) {
            val current = DeviceManager.getInstance().sgc
            val receipt = JSONObject().put("schemaVersion", 1).put("request", request).put("observedAtEpochMs", System.currentTimeMillis())
                .put("appPid", Process.myPid()).put("processInstanceId", processInstanceId)
                .put("currentManager", JSONObject().put("type", current?.type ?: JSONObject.NULL)
                    .put("instanceId", (current as? Nimo)?.resourceInstanceId ?: JSONObject.NULL))
                .put("session", session ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL)
            val pending = File(root, "$nonce.tmp")
            try {
                pending.outputStream().use { it.write(receipt.toString().toByteArray(Charsets.UTF_8)); it.flush() }
                check(pending.renameTo(File(root, "$nonce.json")))
            } catch (_: Exception) { /* Failure is an absent receipt, never a fabricated success. */ } finally { pending.delete() }
        }
        if (mode !in listOf("status", "release") || !Regex("^[0-9A-F]{2}(:[0-9A-F]{2}){5}$").matches(address) ||
            instanceId != null && !uuid(instanceId) || intent.extras?.keySet()?.any { it !in setOf("nonce", "mode", "expectedAddress", "instanceId", "sessionGeneration") } == true) {
            save(null, "invalid-fixed-request"); return
        }
        val current = DeviceManager.getInstance().sgc as? Nimo
        current?.let { track(it) }
        val selected = if (instanceId != null) sessions["$instanceId:$generation"] else sessions.values.lastOrNull {
            it.tombstone.getJSONObject("pair").optString("bluetoothAddress") == address
        }
        val candidate = selected?.instance?.get()
        val live = candidate?.resourceSnapshot()
        val instance = candidate?.takeIf { live?.optLong("sessionGeneration") == selected?.tombstone?.optLong("sessionGeneration") }
        val snapshot = if (instance != null) live else selected?.tombstone
        if (snapshot == null || snapshot.getJSONObject("pair").optString("bluetoothAddress") != address ||
            generation >= 0 && snapshot.optLong("sessionGeneration", -1) != generation) {
            save(null, "target-not-observed-or-generation-mismatch"); return
        }
        if (mode == "status") {
            save(JSONObject(snapshot.toString()).put("sessionObservationCurrent", instance != null).put("source", if (instance != null) "live-original-instance" else "retained-tombstone")); return
        }
        if (instanceId == null || generation < 1 || instance == null || instance !== current) {
            save(snapshot, "release-refused-replaced-or-unowned-target"); return
        }
        instance.releaseResource(generation, { DeviceManager.getInstance().sgc === instance }) { result ->
            track(instance)
            save(result)
        }
    }

    private fun uuid(value: String): Boolean = try { UUID.fromString(value).toString() == value } catch (_: IllegalArgumentException) { false }
}
