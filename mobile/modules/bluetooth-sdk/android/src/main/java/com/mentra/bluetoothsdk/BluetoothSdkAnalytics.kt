package com.mentra.bluetoothsdk

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

data class BluetoothSdkAnalyticsConfig @JvmOverloads constructor(
    val enabled: Boolean = true,
    val postHogApiKey: String? = null,
    val postHogHost: String = BluetoothSdkAnalytics.DEFAULT_POSTHOG_HOST,
    val surface: String = "android",
) {
    internal val isReady: Boolean
        get() = enabled && !postHogApiKey.isNullOrBlank()

    internal fun withSurface(surface: String): BluetoothSdkAnalyticsConfig = copy(surface = surface)

    companion object {
        @JvmStatic
        fun disabled(): BluetoothSdkAnalyticsConfig = BluetoothSdkAnalyticsConfig(enabled = false)

        internal fun fromMap(values: Map<String, Any?>, surface: String): BluetoothSdkAnalyticsConfig =
            BluetoothSdkAnalyticsConfig(
                enabled = (values["enabled"] as? Boolean) ?: ((values["disabled"] as? Boolean)?.not() ?: true),
                postHogApiKey = values["postHogApiKey"] as? String,
                postHogHost =
                    (values["postHogHost"] as? String)
                        ?.takeIf { it.isNotBlank() }
                        ?: BluetoothSdkAnalytics.DEFAULT_POSTHOG_HOST,
                surface = surface,
            )
    }
}

internal class BluetoothSdkAnalytics(
    private val context: Context,
    initialConfig: BluetoothSdkAnalyticsConfig,
) {
    private val appContext = context.applicationContext
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "MentraBluetoothSdkAnalytics").apply { isDaemon = true }
    }
    private var config = initialConfig
    private var startedCaptured = false
    private var lastConnected = false

    fun configure(nextConfig: BluetoothSdkAnalyticsConfig) {
        config = nextConfig
        captureStarted()
    }

    fun captureStarted() {
        if (startedCaptured || !config.isReady) return
        startedCaptured = true
        capture("bluetooth_sdk_started", mapOf("event_kind" to "sdk_started"))
    }

    fun observeGlassesStatus(status: GlassesStatus) {
        val isConnected = status.connectionState.isConnected || status.connected || status.fullyBooted
        if (isConnected && !lastConnected) {
            capture(
                "bluetooth_sdk_glasses_connected",
                buildMap {
                    put("event_kind", "glasses_connected")
                    put("fully_booted", status.fullyBooted)
                    status.deviceModel.takeIf { it.isNotBlank() }?.let { put("glasses_model", it) }
                },
            )
        }
        lastConnected = isConnected
    }

    fun shutdown() {
        executor.shutdown()
    }

    private fun capture(
        eventName: String,
        eventProperties: Map<String, Any>,
    ) {
        val activeConfig = config
        val apiKey = activeConfig.postHogApiKey?.takeIf { activeConfig.isReady } ?: return
        val payload =
            JSONObject(
                mapOf(
                    "api_key" to apiKey,
                    "event" to eventName,
                    "distinct_id" to distinctId(),
                    "properties" to baseProperties(activeConfig) + eventProperties,
                )
            )

        executor.execute {
            try {
                val connection = URL(captureUrl(activeConfig.postHogHost)).openConnection() as HttpURLConnection
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
            } catch (_: Throwable) {
                // Analytics must never affect Bluetooth SDK behavior.
            }
        }
    }

    private fun baseProperties(activeConfig: BluetoothSdkAnalyticsConfig): Map<String, Any> =
        buildMap {
            put("\$process_person_profile", false)
            put("event_source", "mentra_bluetooth_sdk")
            put("sdk_platform", "android")
            put("sdk_surface", activeConfig.surface)
            put("sdk_version", BuildConfig.VERSION_NAME)
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

    private fun captureUrl(host: String): String {
        val normalized = host.trim().trimEnd('/')
        return "$normalized/i/v0/e/"
    }

    companion object {
        const val DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
        private const val PREFS_NAME = "mentra_bluetooth_sdk_analytics"
        private const val PREFS_DISTINCT_ID = "distinct_id"
    }
}
