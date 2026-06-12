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

        internal fun fromMap(
            values: Map<String, Any?>,
            baseConfig: BluetoothSdkAnalyticsConfig = BluetoothSdkAnalyticsConfig(),
        ): BluetoothSdkAnalyticsConfig =
            BluetoothSdkAnalyticsConfig(
                enabled = (values["enabled"] as? Boolean) ?: baseConfig.enabled,
                surface = baseConfig.surface,
            )
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
    // config/startedCaptured/lastConnected are touched from the store-listener
    // thread, the Expo async-function queue, and the creating thread, hence
    // @Synchronized on every method that reads or writes them.
    private var config = initialConfig.toRuntimeConfig().resolvedForApp(appContext)
    private var startedCaptured = false
    private var lastConnected = false

    @Synchronized
    fun configure(nextConfig: BluetoothSdkAnalyticsConfig) {
        config = nextConfig.withSurface(config.surface).toRuntimeConfig().resolvedForApp(appContext)
        captureStarted()
    }

    @Synchronized
    fun configure(values: Map<String, Any?>, surface: String) {
        config =
            BluetoothSdkAnalyticsConfig
                .fromMap(values, BluetoothSdkAnalyticsConfig(enabled = config.enabled))
                .withSurface(surface)
                .toRuntimeConfig()
                .resolvedForApp(appContext)
        captureStarted()
    }

    @Synchronized
    fun initializeGlassesStatus(status: GlassesStatus) {
        lastConnected = status.analyticsConnected
    }

    @Synchronized
    fun captureStarted() {
        if (startedCaptured || !config.isReady) return
        startedCaptured = true
        capture("bluetooth_sdk_started", mapOf("event_kind" to "sdk_started"))
    }

    @Synchronized
    fun observeGlassesStatus(status: GlassesStatus) {
        // Track the real connection state even while analytics is disabled so that
        // enabling it later cannot fabricate a connection event from stale or
        // pre-existing connected flags; only genuine not-connected -> connected
        // transitions observed while enabled are captured.
        val isConnected = status.analyticsConnected
        val wasConnected = lastConnected
        lastConnected = isConnected
        if (!config.isReady) return
        if (isConnected && !wasConnected) {
            capture(
                "bluetooth_sdk_glasses_connected",
                buildMap {
                    put("event_kind", "glasses_connected")
                    put("fully_booted", status.fullyBooted)
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
