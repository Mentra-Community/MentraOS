package com.mentra.bluetoothsdk

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

internal data class BluetoothSdkUpdateCheckResult(
    val status: String,
    val channel: String,
    val latestVersion: String?,
    val minimumSupportedVersion: String?,
) {
    companion object {
        fun parse(body: String): BluetoothSdkUpdateCheckResult? =
            try {
                val json = JSONObject(body)
                BluetoothSdkUpdateCheckResult(
                    status = json.optString("status"),
                    channel = json.optString("channel"),
                    latestVersion = json.optNonBlankString("latestVersion"),
                    minimumSupportedVersion = json.optNonBlankString("minimumSupportedVersion"),
                )
            } catch (_: Exception) {
                null
            }

        private fun JSONObject.optNonBlankString(key: String): String? =
            if (isNull(key)) null else optString(key).trim().takeIf { it.isNotEmpty() }
    }
}

/** The developer-facing console banner for an out-of-date SDK. Never shown in app UI. */
internal object BluetoothSdkUpdateNotice {
    const val STATUS_UPDATE_AVAILABLE = "update_available"
    const val STATUS_UNSUPPORTED = "unsupported"
    private const val RULE = "=================================================================="

    /** Null when the installed SDK is current or the server could not tell. */
    fun banner(installedVersion: String, result: BluetoothSdkUpdateCheckResult, surface: String): String? {
        val latest = result.latestVersion
        val heading =
            when (result.status) {
                STATUS_UNSUPPORTED -> "MENTRA BLUETOOTH SDK $installedVersion IS NO LONGER SUPPORTED"
                STATUS_UPDATE_AVAILABLE -> if (latest != null) "MENTRA BLUETOOTH SDK UPDATE AVAILABLE" else return null
                else -> return null
            }
        return buildString {
            appendLine(RULE)
            appendLine("  $heading")
            appendLine("  Installed: $installedVersion    Latest: ${latest ?: "unknown"}")
            appendLine("  Update:    ${updateLine(surface, latest)}")
            if (result.status == STATUS_UNSUPPORTED) {
                appendLine("  This version has known issues that are fixed in newer releases.")
            }
            appendLine("  Running an old SDK is the most common cause of glasses issues.")
            append(RULE)
        }
    }

    private fun updateLine(surface: String, version: String?): String =
        when (surface) {
            "react_native" -> "bun add @mentra/bluetooth-sdk@${version ?: "latest"}"
            "ios" -> "the MentraBluetoothSDK Swift package at ${version ?: "its latest release"}"
            else -> "com.mentraglass:bluetooth-sdk:${version ?: "<latest release>"}"
        }
}

/**
 * Checks Mentra Core for a newer SDK on every SDK start and, when this SDK is
 * behind, prints a console banner now and every [REPRINT_INTERVAL_MINUTES] while
 * the SDK instance lives. The check is one request with a short timeout and no
 * retry; any failure is silent and changes no SDK behavior. It runs regardless
 * of the analytics setting.
 */
internal class BluetoothSdkUpdateCheck(
    context: Context,
    private val surface: String,
    private val sdkVersion: String = BuildConfig.SDK_VERSION,
    private val transport: (String) -> String? = ::post,
    private val onNotice: (banner: String, result: BluetoothSdkUpdateCheckResult) -> Unit,
) {
    private val appContext = context.applicationContext
    private val lock = Any()
    private var stopped = false
    private var reprint: ScheduledFuture<*>? = null

    fun start() {
        if (!isCheckable(sdkVersion)) return
        try {
            executor.execute { runCatching { check() } }
        } catch (_: RejectedExecutionException) {
        }
    }

    fun stop() {
        synchronized(lock) {
            stopped = true
            reprint?.cancel(false)
            reprint = null
        }
    }

    private fun check() {
        val response = transport(requestBody().toString()) ?: return
        val result = BluetoothSdkUpdateCheckResult.parse(response) ?: return
        val banner = BluetoothSdkUpdateNotice.banner(sdkVersion, result, surface) ?: return
        synchronized(lock) {
            if (stopped) return
            onNotice(banner, result)
            reprint =
                executor.scheduleAtFixedRate(
                    { synchronized(lock) { if (!stopped) onNotice(banner, result) } },
                    REPRINT_INTERVAL_MINUTES,
                    REPRINT_INTERVAL_MINUTES,
                    TimeUnit.MINUTES,
                )
        }
    }

    internal fun requestBody(): JSONObject {
        val host = BluetoothSdkAnalyticsHost.resolve(appContext)
        return JSONObject().apply {
            put("install_id", BluetoothSdkInstallId.get(appContext))
            put("app_identifier", appContext.packageName)
            host.appVersion?.let { put("app_version", it) }
            host.appBuild?.let { put("app_build", it) }
            put("app_build_type", host.buildType)
            put("app_install_source", host.installSource)
            host.environment?.let { put("app_environment", it) }
            put("sdk_version", sdkVersion)
            put("sdk_platform", "android")
            put("sdk_surface", surface)
            put("os_platform", "android")
            put("os_version", Build.VERSION.SDK_INT.toString())
        }
    }

    companion object {
        const val UPDATE_CHECK_URL = "https://core.mentraglass.com/api/client/bluetooth-sdk/update-check"
        const val REPRINT_INTERVAL_MINUTES = 15L
        private const val TIMEOUT_MS = 4_000

        private val executor: ScheduledExecutorService =
            Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "MentraBluetoothSdkUpdateCheck").apply { isDaemon = true }
            }

        fun isCheckable(version: String): Boolean = version.isNotBlank() && version != "unknown"

        private fun post(body: String): String? {
            val connection = URL(UPDATE_CHECK_URL).openConnection() as HttpURLConnection
            return try {
                connection.requestMethod = "POST"
                connection.connectTimeout = TIMEOUT_MS
                connection.readTimeout = TIMEOUT_MS
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                if (connection.responseCode != 200) {
                    connection.errorStream?.close()
                    null
                } else {
                    connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                }
            } catch (_: Exception) {
                null
            } finally {
                connection.disconnect()
            }
        }

        /** Test hook: waits until every task submitted so far has run. */
        internal fun awaitIdle() {
            executor.submit {}.get()
        }
    }
}
