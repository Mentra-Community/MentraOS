package com.mentra.bluetoothsdk

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
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
    // startedCaptured/lastConnected are touched from store listeners and SDK
    // entry points, hence @Synchronized on methods that read or write them.
    private val config = initialConfig.toRuntimeConfig().resolvedForApp(appContext)
    private var startedCaptured = false
    private var lastConnected = false
    private var identifiedCapturedForConnection = false

    @Synchronized
    fun initializeGlassesStatus(status: GlassesStatus) {
        lastConnected = status.analyticsConnected
        // Only treat identification as already captured when a valid serial is
        // present at init. If the glasses are connected but the serial has not
        // arrived yet (Mentra Live fills it via version_info after connect), leave
        // this false so the identify event still fires once the serial arrives.
        identifiedCapturedForConnection =
            status.analyticsConnected && status.serialNumber.validManufacturingSerial() != null
    }

    @Synchronized
    fun captureStarted() {
        if (startedCaptured || !config.isReady) return
        startedCaptured = true
        capture("bluetooth_sdk_started", mapOf("event_kind" to "sdk_started"))
    }

    @Synchronized
    fun observeGlassesStatus(status: GlassesStatus) {
        val isConnected = status.analyticsConnected
        val wasConnected = lastConnected
        lastConnected = isConnected
        if (!config.isReady) return
        if (!isConnected) {
            identifiedCapturedForConnection = false
            return
        }
        if (isConnected && !wasConnected) {
            identifiedCapturedForConnection = false
            capture(
                "bluetooth_sdk_glasses_connected",
                buildMap {
                    put("event_kind", "glasses_connected")
                    put("fully_booted", status.fullyBooted)
                    status.deviceModel.takeIf { it.isNotBlank() }?.let { put("glasses_model", it) }
                },
            )
            // Fall through: a serial already present at connect time (G1/Ar99 report
            // it in the advertisement) should be identified now rather than waiting
            // for some later, unrelated glasses-store update to run.
        }

        val serialNumber = status.serialNumber.validManufacturingSerial() ?: return
        if (!identifiedCapturedForConnection) {
            identifiedCapturedForConnection = true
            capture(
                "bluetooth_sdk_glasses_identified",
                buildMap {
                    put("event_kind", "glasses_identified")
                    put("fully_booted", status.fullyBooted)
                    put("glasses_device_id", serialNumber)
                    put("glasses_device_id_type", "manufacturing_serial")
                    status.deviceModel.takeIf { it.isNotBlank() }?.let { put("glasses_model", it) }
                },
            )
        }
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

        try {
            // Payload construction stays on the executor: distinctId() reads
            // SharedPreferences, which must not run on the caller (often main) thread.
            executor.execute {
                try {
                    val payload =
                        JSONObject(
                            mapOf(
                                "api_key" to DEFAULT_POSTHOG_API_KEY,
                                "event" to eventName,
                                "distinct_id" to distinctId(),
                                "properties" to baseProperties(activeConfig) + eventProperties,
                            )
                        )
                    val connection = URL(captureUrl()).openConnection() as HttpURLConnection
                    connection.requestMethod = "POST"
                    connection.connectTimeout = 4_000
                    connection.readTimeout = 4_000
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { output ->
                        output.write(payload.toString().toByteArray(Charsets.UTF_8))
                    }
                    connection.inputStream.close()
                    connection.disconnect()
                } catch (_: Exception) {
                    // Analytics must never affect Bluetooth SDK behavior.
                }
            }
        } catch (_: RejectedExecutionException) {
            // The executor was shut down (SDK closed); dropping the event is fine.
        }
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

private val GlassesStatus.analyticsConnected: Boolean
    get() = connectionState.isConnected || connected || fullyBooted

private fun String.validManufacturingSerial(): String? =
    trim().takeIf { it.isNotEmpty() && !it.matches(Regex("0+")) }
