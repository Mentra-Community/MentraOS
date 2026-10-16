package com.mentra.bluetoothsdk

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.mentra.bluetoothsdk.utils.DeviceTypes
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

class BluetoothSdkAnalyticsConfig private constructor(
    val enabled: Boolean,
    internal val surface: String,
) {
    @JvmOverloads
    constructor(enabled: Boolean = true) : this(enabled, "android")

    internal fun withSurface(surface: String): BluetoothSdkAnalyticsConfig =
        BluetoothSdkAnalyticsConfig(enabled, surface)

    companion object {
        @JvmStatic
        fun disabled(): BluetoothSdkAnalyticsConfig = BluetoothSdkAnalyticsConfig(enabled = false)
    }
}

private data class BluetoothSdkAnalyticsRuntimeConfig(
    val enabled: Boolean = true,
    val surface: String = "android",
) {
    val isReady: Boolean
        get() = enabled
}

internal class BluetoothSdkAnalytics(
    private val context: Context,
    initialConfig: BluetoothSdkAnalyticsConfig,
) {
    private val appContext = context.applicationContext
    private val config = initialConfig.toRuntimeConfig().resolvedForApp(appContext)
    // The tracker is touched from store listeners and SDK entry points, hence
    // @Synchronized on the methods that read or write it.
    private val tracker = BluetoothSdkAnalyticsTracker(DeviceTypes.SIMULATED)
    private val usage = BluetoothSdkUsageTracker()
    private var startedCaptured = false
    private var lastGlasses: AnalyticsGlassesSnapshot? = null
    // Set by an SDK disconnect/forget/cancel call and consumed by the next
    // connected -> disconnected transition, so that transition can say why.
    private var pendingDisconnectReason: String? = null
    // Resolved once, lazily, on the transport executor: PackageManager lookups
    // must not run on the caller (often main or the Bluetooth status) thread.
    private val hostProperties: Map<String, Any> by lazy { BluetoothSdkAnalyticsHost.resolve(appContext).toMap() }
    // The retry queue and its executor are process-wide (see BluetoothSdkAnalyticsTransport).
    private val queue: BluetoothSdkAnalyticsQueue get() = BluetoothSdkAnalyticsTransport.queue(appContext)
    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    /** False when the host disabled analytics; callers skip building usage facts entirely. */
    val isEnabled: Boolean
        get() = config.isReady

    @Synchronized
    fun initializeGlassesStatus(status: GlassesStatus) {
        val snapshot = status.toAnalyticsSnapshot()
        lastGlasses = snapshot
        tracker.initialize(snapshot, BluetoothSdkAnalyticsTracker.reportingDay(System.currentTimeMillis()))
    }

    @Synchronized
    fun captureStarted() {
        if (startedCaptured || !config.isReady) return
        startedCaptured = true
        capture("bluetooth_sdk_started", mapOf("event_kind" to "sdk_started"))
        // A fresh runtime is the natural moment to retry what an earlier one could not deliver.
        runOnExecutor { queue.drain(System.currentTimeMillis()) { payload -> send(payload) } }
    }

    @Synchronized
    fun observeGlassesStatus(status: GlassesStatus, phoneBluetoothOff: () -> Boolean) {
        val snapshot = status.toAnalyticsSnapshot()
        lastGlasses = snapshot
        val now = System.currentTimeMillis()
        val events =
            tracker.observe(snapshot, BluetoothSdkAnalyticsTracker.reportingDay(now), now) {
                pendingDisconnectReason
                    ?: if (phoneBluetoothOff()) {
                        BluetoothSdkAnalyticsTracker.DISCONNECT_BLUETOOTH_OFF
                    } else {
                        BluetoothSdkAnalyticsTracker.DISCONNECT_LINK_LOST
                    }
            }
        if (!snapshot.connected || events.any { it.name == "bluetooth_sdk_glasses_connected" }) {
            pendingDisconnectReason = null
        }
        if (!config.isReady) return
        for (event in events) capture(event.name, event.properties)
    }

    @Synchronized
    fun noteDisconnectRequested(reason: String) {
        if (lastGlasses?.connected == true) pendingDisconnectReason = reason
    }

    @Synchronized
    fun recordUsage(build: BluetoothSdkUsageTracker.() -> AnalyticsEvent?) {
        if (!config.isReady) return
        val event = usage.build() ?: return
        capture(event.name, glassesContext() + event.properties)
    }

    /** Usage-tracker state changes that emit nothing themselves (e.g. a stop request). */
    @Synchronized
    fun updateUsage(update: BluetoothSdkUsageTracker.() -> Unit) {
        if (!config.isReady) return
        usage.update()
    }

    private fun glassesContext(): Map<String, Any> {
        val glasses = lastGlasses?.takeIf { it.connected } ?: return emptyMap()
        return buildMap {
            glasses.model.takeIf { it.isNotBlank() }?.let { put("glasses_model", it) }
            glasses.serialNumber.validManufacturingSerial()?.let { put("glasses_device_id", it) }
            glasses.buildNumber.takeIf { it.isNotBlank() }?.let { put("glasses_build_number", it) }
        }
    }

    /**
     * Delivery is owned by the process-wide transport, so nothing is torn down
     * here: a retry in flight when this instance closes still completes, and a
     * replacement instance cannot race it on the retry file.
     */
    fun shutdown() {}

    private fun capture(
        eventName: String,
        eventProperties: Map<String, Any>,
    ) {
        val activeConfig = config
        if (!activeConfig.isReady) return
        // Identity and time are fixed at capture, not at (re)send, so a retried
        // event neither double counts nor drifts into a later week.
        val uuid = UUID.randomUUID().toString()
        val capturedAt = System.currentTimeMillis()
        runOnExecutor {
            val payload =
                JSONObject(
                    mapOf(
                        "api_key" to DEFAULT_POSTHOG_API_KEY,
                        "uuid" to uuid,
                        "event" to eventName,
                        "distinct_id" to BluetoothSdkInstallId.get(appContext),
                        "timestamp" to isoFormat.format(Date(capturedAt)),
                        "properties" to baseProperties(activeConfig) + hostProperties + eventProperties,
                    )
                )
            when (send(payload)) {
                SendOutcome.DELIVERED -> queue.drain(capturedAt) { queued -> send(queued) }
                SendOutcome.RETRY -> queue.enqueue(payload, capturedAt)
                SendOutcome.DISCARD -> Unit
            }
        }
    }

    private fun runOnExecutor(block: () -> Unit) {
        BluetoothSdkAnalyticsTransport.submit(block)
    }

    /**
     * 2xx is delivered. A 4xx other than 408/429 means PostHog rejected this payload
     * for good (bad key, malformed body) and retrying it would only block the queue.
     * Everything else (network errors, 5xx, 408, 429) is worth retrying later.
     */
    private fun send(payload: JSONObject): SendOutcome =
        try {
            val connection = URL(captureUrl()).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 4_000
                connection.readTimeout = 4_000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { output ->
                    output.write(payload.toString().toByteArray(Charsets.UTF_8))
                }
                val code = connection.responseCode
                if (code in 200..299) connection.inputStream.close() else connection.errorStream?.close()
                SendOutcome.fromHttpStatus(code)
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            SendOutcome.RETRY
        }

    private fun baseProperties(activeConfig: BluetoothSdkAnalyticsRuntimeConfig): Map<String, Any> =
        buildMap {
            put("\$process_person_profile", false)
            put("event_source", "mentra_bluetooth_sdk")
            put("sdk_platform", "android")
            put("sdk_surface", activeConfig.surface)
            put("sdk_version", BuildConfig.SDK_VERSION)
            put("app_identifier", appContext.packageName)
            put("app_package", appContext.packageName)
            put("os_platform", "android")
            put("os_version", Build.VERSION.SDK_INT)
            Build.MANUFACTURER?.takeIf { it.isNotBlank() }?.let { put("phone_manufacturer", it) }
            Build.MODEL?.takeIf { it.isNotBlank() }?.let { put("phone_model", it) }
            put("locale", Locale.getDefault().toLanguageTag())
            put("timezone", TimeZone.getDefault().id)
        }

    private fun captureUrl(): String {
        val normalized = DEFAULT_POSTHOG_HOST.trim().trimEnd('/')
        return "$normalized/i/v0/e/"
    }

    companion object {
        internal const val META_ANALYTICS_DISABLED = "com.mentra.bluetoothsdk.analytics.disabled"
        private const val DEFAULT_POSTHOG_API_KEY = "phc_FCweXVAxVgU7wZK4Fk3okOx4RmyNqVHJf62YpZSfJt5"
        private const val DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
    }
}

private fun BluetoothSdkAnalyticsConfig.toRuntimeConfig(): BluetoothSdkAnalyticsRuntimeConfig =
    BluetoothSdkAnalyticsRuntimeConfig(enabled = enabled, surface = surface)

private fun BluetoothSdkAnalyticsRuntimeConfig.resolvedForApp(context: Context): BluetoothSdkAnalyticsRuntimeConfig {
    val metadata =
        try {
            context.packageManager
                .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
                .metaData
        } catch (_: Exception) {
            null
        }

    val disabledByApp = metadata?.getBoolean(BluetoothSdkAnalytics.META_ANALYTICS_DISABLED, false) == true

    return copy(
        enabled = enabled && !disabledByApp,
    )
}

private fun GlassesStatus.toAnalyticsSnapshot(): AnalyticsGlassesSnapshot =
    AnalyticsGlassesSnapshot(
        connected = connectionState.isConnected || connected || fullyBooted,
        fullyBooted = fullyBooted,
        model = deviceModel,
        serialNumber = serialNumber,
        firmwareVersion = firmwareVersion,
        besFirmwareVersion = besFirmwareVersion,
        mtkFirmwareVersion = mtkFirmwareVersion,
        androidVersion = androidVersion,
        appVersion = appVersion,
        buildNumber = buildNumber,
        batteryLevel = batteryLevel,
        charging = charging,
    )
