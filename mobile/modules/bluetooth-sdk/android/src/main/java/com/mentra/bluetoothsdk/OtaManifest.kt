package com.mentra.bluetoothsdk

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

internal object OtaManifestDefaults {
    private const val SDK_OTA_RELEASE_BASE_URL =
        "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota"
    // ASG builds before 39 ignore ota_start.ota_version_url, so SDK checks must
    // use the same legacy production manifest those glasses will install from.
    const val LEGACY_PROD_OTA_VERSION_URL = "https://ota.mentraglass.com/prod_live_version.json"

    fun defaultOtaVersionUrl(): String {
        val sdkVersion = BuildConfig.SDK_VERSION.trim()
        if (sdkVersion.isBlank() || sdkVersion == "unspecified") {
            throw BluetoothSdkException(
                "missing_sdk_version",
                "Cannot determine Bluetooth SDK version for the default OTA manifest URL.",
            )
        }
        return "$SDK_OTA_RELEASE_BASE_URL/bluetooth-sdk-$sdkVersion-version.json"
    }
}

internal object OtaManifestChecker {
    private const val ASG_CLIENT_PACKAGE = "com.mentra.asg_client"

    fun normalizeHttpUrl(value: String): String {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) {
            throw BluetoothSdkException("invalid_ota_url", "OTA version URL must be a non-empty http(s) URL.")
        }

        val uri =
            try {
                URI(trimmed)
            } catch (error: Exception) {
                throw BluetoothSdkException("invalid_ota_url", "OTA version URL must be a valid http(s) URL.", error)
            }

        val scheme = uri.scheme?.lowercase()
        if ((scheme != "http" && scheme != "https") || uri.host.isNullOrBlank()) {
            throw BluetoothSdkException("invalid_ota_url", "OTA version URL must be an http(s) URL.")
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
                throw BluetoothSdkException("ota_manifest_request_failed", "OTA manifest request failed with HTTP $status for $otaVersionUrl.")
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

    fun hasMtkPatches(manifest: JSONObject): Boolean =
        (manifest.optJSONArray("mtk_patches")?.length() ?: 0) > 0

    fun hasBesFirmware(manifest: JSONObject): Boolean =
        manifest.optJSONObject("bes_firmware") != null

    private fun latestAppInfo(manifest: JSONObject): JSONObject {
        val apps = manifest.optJSONObject("apps")
        val app = apps?.optJSONObject(ASG_CLIENT_PACKAGE)
        if (app != null && app.hasNumber("versionCode")) {
            return app
        }

        if (manifest.hasNumber("versionCode")) {
            return manifest
        }

        throw BluetoothSdkException("invalid_ota_manifest", "OTA manifest is missing ASG app versionCode.")
    }

    private fun hasApkUpdate(currentBuildNumber: String, manifest: JSONObject): Boolean {
        val currentVersion =
            currentBuildNumber.toLongOrNull()
                ?: throw BluetoothSdkException(
                    "invalid_glasses_version",
                    "Cannot check OTA update because glasses build number is invalid.",
                )
        val serverVersion = latestAppInfo(manifest).requiredLong("versionCode")
        // Every manifest this checker consumes pins one exact ASG artifact, so any mismatch is an
        // update in either direction (downgrades take the uninstall-then-reinstall detour on the
        // glasses). A non-positive pin is only legitimate in the frozen legacy rescue manifests
        // that pre-39 glasses are checked against; for modern glasses it means the manifest
        // cannot verify anything, and that must surface as an error — never as "no update".
        if (serverVersion <= 0) {
            if (currentVersion >= 39) {
                throw BluetoothSdkException(
                    "invalid_ota_manifest",
                    "OTA manifest ASG pin is missing or zero; cannot verify update state.",
                )
            }
            return false
        }
        return serverVersion != currentVersion
    }

    private fun hasMtkUpdate(patches: JSONArray?, currentVersion: String): Boolean {
        if (patches == null || patches.length() == 0) return false
        if (currentVersion.isBlank()) return false

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
            throw BluetoothSdkException("invalid_ota_manifest", "OTA manifest bes_firmware.version is missing.")
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
            ?: throw BluetoothSdkException("invalid_ota_manifest", "OTA manifest is missing ASG app versionCode.")
}
