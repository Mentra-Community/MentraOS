package com.mentra.bluetoothsdk

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

internal object OtaManifestDefaults {
    const val DEFAULT_OTA_VERSION_URL = "https://staging.ota.mentraglass.com/staging_live_version.json"
    const val PROD_OTA_VERSION_URL = "https://ota.mentraglass.com/prod_live_version.json"
}

internal object OtaManifestChecker {
    private const val ASG_CLIENT_PACKAGE = "com.mentra.asg_client"

    fun normalizeHttpUrl(value: String): String {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) {
            throw BluetoothException("invalid_ota_url", "OTA version URL must be a non-empty http(s) URL.")
        }

        val uri =
            try {
                URI(trimmed)
            } catch (error: Exception) {
                throw BluetoothException("invalid_ota_url", "OTA version URL must be a valid http(s) URL.", error)
            }

        val scheme = uri.scheme?.lowercase()
        if ((scheme != "http" && scheme != "https") || uri.host.isNullOrBlank()) {
            throw BluetoothException("invalid_ota_url", "OTA version URL must be an http(s) URL.")
        }

        return uri.toString()
    }

    fun fetch(otaVersionUrl: String): JSONObject {
        val connection = URL(otaVersionUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 15_000
        connection.requestMethod = "GET"
        return try {
            val status = connection.responseCode
            if (status !in 200..299) {
                throw BluetoothException("ota_manifest_request_failed", "OTA manifest request failed with HTTP $status.")
            }
            JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }

    fun hasUpdate(
        currentBuildNumber: String,
        currentMtkVersion: String,
        currentBesVersion: String,
        manifest: JSONObject,
    ): Boolean =
        hasApkUpdate(currentBuildNumber, manifest) ||
            hasMtkUpdate(manifest.optJSONArray("mtk_patches"), currentMtkVersion) ||
            hasBesUpdate(manifest.optJSONObject("bes_firmware"), currentBesVersion)

    private fun latestAppInfo(manifest: JSONObject): JSONObject {
        val apps = manifest.optJSONObject("apps")
        val app = apps?.optJSONObject(ASG_CLIENT_PACKAGE)
        if (app != null && app.hasNumber("versionCode")) {
            return app
        }

        if (manifest.hasNumber("versionCode")) {
            return manifest
        }

        throw BluetoothException("invalid_ota_manifest", "OTA manifest is missing ASG app versionCode.")
    }

    private fun hasApkUpdate(currentBuildNumber: String, manifest: JSONObject): Boolean {
        val currentVersion =
            currentBuildNumber.toLongOrNull()
                ?: throw BluetoothException(
                    "invalid_glasses_version",
                    "Cannot check OTA update because glasses build number is invalid.",
                )
        val serverVersion = latestAppInfo(manifest).requiredLong("versionCode")
        return serverVersion > currentVersion
    }

    private fun hasMtkUpdate(patches: JSONArray?, currentVersion: String): Boolean {
        if (patches == null || patches.length() == 0) return false
        if (currentVersion.isBlank()) {
            throw BluetoothException(
                "missing_mtk_version",
                "Cannot check OTA update because MTK firmware version is unavailable.",
            )
        }

        for (index in 0 until patches.length()) {
            val patch = patches.optJSONObject(index) ?: continue
            val startFirmware = patch.optString("start_firmware", "")
            if (startFirmware == currentVersion) return true
            val serverDate = if (startFirmware.contains("_")) startFirmware.substringAfterLast("_") else startFirmware
            if (serverDate == currentVersion) return true
        }
        return false
    }

    private fun hasBesUpdate(besFirmware: JSONObject?, currentVersion: String): Boolean {
        if (besFirmware == null) return false
        val serverVersion = besFirmware.optString("version", "")
        if (serverVersion.isBlank()) {
            throw BluetoothException("invalid_ota_manifest", "OTA manifest bes_firmware.version is missing.")
        }
        if (currentVersion.isBlank()) return true
        return compareVersions(serverVersion, currentVersion) > 0
    }

    private fun compareVersions(version1: String, version2: String): Int {
        if (version1.contains(".") && version2.contains(".")) {
            val parts1 = version1.split(".")
            val parts2 = version2.split(".")
            val maxLength = maxOf(parts1.size, parts2.size)
            for (index in 0 until maxLength) {
                val value1 = parts1.getOrNull(index)?.toIntOrNull() ?: 0
                val value2 = parts2.getOrNull(index)?.toIntOrNull() ?: 0
                if (value1 != value2) return value1 - value2
            }
            return 0
        }
        return version1.compareTo(version2)
    }

    private fun JSONObject.hasNumber(key: String): Boolean = !isNull(key) && opt(key) is Number

    private fun JSONObject.requiredLong(key: String): Long =
        (opt(key) as? Number)?.toLong()
            ?: throw BluetoothException("invalid_ota_manifest", "OTA manifest is missing ASG app versionCode.")
}
