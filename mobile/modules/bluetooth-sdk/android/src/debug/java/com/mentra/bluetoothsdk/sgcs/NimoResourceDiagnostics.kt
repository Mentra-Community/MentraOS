package com.mentra.bluetoothsdk.sgcs

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import com.mentra.bluetoothsdk.BuildConfig
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
    private data class Capture(val nonce: String, val name: String, val address: String,
        var instance: Nimo? = null, var cancelled: Boolean = false, var connectStarted: Boolean = false,
        var transportStarted: Boolean = false)
    // One diagnostic attempt per app process. Cancellation is a process-lifetime fence.
    @Volatile private var capture: Capture? = null
    internal fun preArmCaptureRequired(buildType: String = BuildConfig.BUILD_TYPE): Boolean = buildType == "nimoDiagnostic"
    internal fun allowUnarmedWearable(buildType: String, wearable: String): Boolean =
        !preArmCaptureRequired(buildType) || !wearable.contains("NIMO", ignoreCase = true)


    /** Debug entries share the main admission queue even before arm, so a call that
     * starts just before arm cannot resume effects past it. Release builds are no-op.
     * Queued calls re-enter current capture guards before any connection effect. */
    fun dispatchCapturedEntry(entry: () -> Unit): Boolean {
        if (!preArmCaptureRequired() && capture == null) return false
        if (Looper.myLooper() == main.looper) return false
        val task = java.util.concurrent.FutureTask<Unit> { entry() }
        main.post(task)
        try {
            task.get()
        } catch (error: java.util.concurrent.ExecutionException) {
            throw (error.cause ?: error)
        } catch (error: InterruptedException) {
            // A queued entry must not run later after its original caller abandoned it.
            task.cancel(false)
            Thread.currentThread().interrupt()
            throw error
        }
        return true
    }

    @Synchronized
    fun allowManagerConnect(wearable: String, name: String? = null): Boolean {
        val owned = capture ?: return allowUnarmedWearable(BuildConfig.BUILD_TYPE, wearable)
        if (Looper.myLooper() != main.looper) return false
        if (!wearable.contains("NIMO", ignoreCase = true)) return true
        val current = DeviceManager.getInstance().sgc
        return !owned.cancelled && (name == null || !owned.connectStarted && name == owned.name) &&
            (current == null || current is Nimo && (owned.instance === current ||
                owned.instance == null && current.resourceCaptureEligible()))
    }

    /** Scan-to-connect is one captured attempt: never destroy or transfer its instance. */
    @Synchronized
    fun preserveCapturedScan(wearable: String, name: String): Boolean {
        val owned = capture ?: return false
        if (Looper.myLooper() != main.looper || !wearable.contains("NIMO", ignoreCase = true) ||
            owned.cancelled || owned.connectStarted || name != owned.name) return false
        val original = owned.instance ?: return false
        return DeviceManager.getInstance().sgc === original &&
            original.resourceSnapshot().getLong("sessionGeneration") == 0L
    }

    @Synchronized
    fun admit(instance: Nimo, name: String?, connect: Boolean): Boolean {
        val owned = capture ?: return !preArmCaptureRequired()
        if (Looper.myLooper() != main.looper) return false
        if (!allowManagerConnect("NIMO", name) || DeviceManager.getInstance().sgc !== instance ||
            owned.instance != null && owned.instance !== instance || owned.connectStarted) return false
        if (owned.instance == null) {
            if (!instance.resourceCaptureEligible()) return false
            owned.instance = instance
            // Immutable admission survives a setup timeout before any GATT session exists.
            val app = application ?: return false
            val root = File(app.filesDir, "nimo-lifecycle")
            val target = File(root, "${owned.nonce}.admission.json")
            if (target.exists()) { owned.cancelled = true; return false }
            val pending = File(root, "${owned.nonce}.admission.tmp")
            try {
                pending.outputStream().use { it.write(captureSnapshot(owned).toString().toByteArray(Charsets.UTF_8)); it.flush() }
                check(pending.renameTo(target))
            } catch (_: Exception) {
                owned.cancelled = true
                return false
            } finally { pending.delete() }
        }
        if (connect) owned.connectStarted = true
        return true
    }

    @Synchronized
    fun allowPeer(instance: Nimo, address: String, bonded: Boolean): Boolean {
        val owned = capture ?: return !preArmCaptureRequired()
        if (Looper.myLooper() != main.looper) return false
        return !owned.cancelled && owned.instance === instance && address == owned.address && bonded &&
            DeviceManager.getInstance().sgc === instance
    }

    @Synchronized
    fun beginTransport(instance: Nimo, address: String, bonded: Boolean): Boolean {
        val owned = capture ?: return !preArmCaptureRequired()
        if (Looper.myLooper() != main.looper) return false
        if (!allowPeer(instance, address, bonded) || owned.transportStarted) return false
        owned.transportStarted = true
        return true
    }

    @Synchronized
    private fun captureSnapshot(owned: Capture): JSONObject = JSONObject()
        .put("version", "nimo-preconnect-capture-v1").put("nonce", owned.nonce)
        .put("captureRequiredBeforeArm", preArmCaptureRequired())
        .put("expectedPair", JSONObject().put("name", owned.name).put("bluetoothAddress", owned.address))
        .put("instanceId", owned.instance?.resourceInstanceId ?: JSONObject.NULL)
        .put("sessionGeneration", owned.instance?.resourceSnapshot()?.getLong("sessionGeneration") ?: JSONObject.NULL)
        .put("observedPair", if (owned.transportStarted) owned.instance?.resourceSnapshot()?.getJSONObject("pair") ?: JSONObject.NULL else JSONObject.NULL)
        .put("cancelled", owned.cancelled).put("connectStarted", owned.connectStarted)
        .put("transportStarted", owned.transportStarted)
        .put("appPid", Process.myPid()).put("processInstanceId", processInstanceId)
        .put("observedAtEpochMs", System.currentTimeMillis())


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
    @Synchronized
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
        fun save(session: JSONObject?, error: String? = null): Boolean {
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
                return true
            } catch (_: Exception) { return false /* Absent receipt is unknown. */ } finally { pending.delete() }
        }
        if (mode in listOf("arm-capture", "capture-status", "cancel-capture")) {
            val expectedName = intent.getStringExtra("expectedName")
            val captureNonce = intent.getStringExtra("captureNonce")
            request.remove("instanceId"); request.remove("sessionGeneration")
            request.put("expectedName", expectedName ?: JSONObject.NULL).put("captureNonce", captureNonce ?: JSONObject.NULL)
            if (!Regex("^[0-9A-F]{2}(:[0-9A-F]{2}){5}$").matches(address) ||
                intent.extras?.keySet()?.any { it !in setOf("nonce", "mode", "expectedAddress", "expectedName", "captureNonce") } == true ||
                expectedName == null || !Regex("^Nimo-[A-Za-z0-9]{1,32}$").matches(expectedName) ||
                captureNonce == null || !uuid(captureNonce)) { save(null, "invalid-fixed-capture-request"); return }
            if (mode == "arm-capture") {
                val manager = DeviceManager.getInstance().sgc
                if (capture != null || captureNonce != nonce || manager != null) {
                    save(null, "capture-arm-refused-existing-owner"); return
                }
                capture = Capture(captureNonce, expectedName, address)
            }
            val owned = capture
            if (owned == null || owned.nonce != captureNonce || owned.name != expectedName || owned.address != address) {
                save(null, "capture-not-original"); return
            }
            fun captureReceipt(session: JSONObject? = null, error: String? = null): Boolean {
                return save(JSONObject().put("capture", captureSnapshot(owned)).put("originalSession", session ?: JSONObject.NULL), error)
            }
            if (mode != "cancel-capture") {
                if (!captureReceipt(owned.instance?.resourceSnapshot()) && mode == "arm-capture") owned.cancelled = true
                return
            }
            owned.cancelled = true // fence before draining or emitting a no-admission receipt
            val original = owned.instance
            if (original == null) { captureReceipt(); return }
            if (DeviceManager.getInstance().sgc !== original) { captureReceipt(original.resourceSnapshot(), "capture-cancel-refused-replacement"); return }
            original.releaseCapturedResource({ DeviceManager.getInstance().sgc === original }) { result -> captureReceipt(result) }
            return
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
            if (result.has("error")) save(instance.resourceSnapshot(), result.getString("error")) else save(result)
        }
    }

    private fun uuid(value: String): Boolean = try { UUID.fromString(value).toString() == value } catch (_: IllegalArgumentException) { false }
}
