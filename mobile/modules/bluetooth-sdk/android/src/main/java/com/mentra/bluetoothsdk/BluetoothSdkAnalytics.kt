package com.mentra.bluetoothsdk

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.mentra.bluetoothsdk.utils.DeviceTypes
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

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
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "MentraBluetoothSdkAnalytics").apply { isDaemon = true }
    }
    private val config = initialConfig.toRuntimeConfig().resolvedForApp(appContext)
    // The tracker is touched from store listeners and SDK entry points, hence
    // @Synchronized on the methods that read or write it.
    private val tracker = BluetoothSdkAnalyticsTracker(DeviceTypes.SIMULATED)
    private var startedCaptured = false
    // Resolved once, lazily, on the executor: PackageManager lookups and file I/O
    // must not run on the caller (often main or the Bluetooth status) thread.
    private val hostProperties: Map<String, Any> by lazy { BluetoothSdkAnalyticsHost.resolve(appContext).toMap() }
    private val queue: BluetoothSdkAnalyticsQueue by lazy {
        BluetoothSdkAnalyticsQueue(File(appContext.filesDir, BluetoothSdkAnalyticsQueue.FILE_NAME))
    }
    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    @Synchronized
    fun initializeGlassesStatus(status: GlassesStatus) {
        tracker.initialize(status.toAnalyticsSnapshot(), BluetoothSdkAnalyticsTracker.reportingDay(System.currentTimeMillis()))
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
    fun observeGlassesStatus(status: GlassesStatus) {
        val events = tracker.observe(status.toAnalyticsSnapshot(), BluetoothSdkAnalyticsTracker.reportingDay(System.currentTimeMillis()))
        if (!config.isReady) return
        for (event in events) capture(event.name, event.properties)
    }

    fun shutdown() {
        executor.shutdown()
    }

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
                        "distinct_id" to distinctId(),
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
        try {
            executor.execute {
                try {
                    block()
                } catch (_: Exception) {
                    // Analytics must never affect Bluetooth SDK behavior.
                }
            }
        } catch (_: RejectedExecutionException) {
            // The executor was shut down (SDK closed); dropping the event is fine.
        }
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
        }

    private fun distinctId(): String {
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.getString(PREFS_DISTINCT_ID, null)?.let { return it }
        val generated = "mentra-bt-sdk-${UUID.randomUUID()}"
        prefs.edit().putString(PREFS_DISTINCT_ID, generated).apply()
        return generated
    }

    private fun captureUrl(): String {
        val normalized = DEFAULT_POSTHOG_HOST.trim().trimEnd('/')
        return "$normalized/i/v0/e/"
    }

    companion object {
        internal const val META_ANALYTICS_DISABLED = "com.mentra.bluetoothsdk.analytics.disabled"
        private const val PREFS_NAME = "mentra_bluetooth_sdk_analytics"
        private const val PREFS_DISTINCT_ID = "distinct_id"
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
    )
