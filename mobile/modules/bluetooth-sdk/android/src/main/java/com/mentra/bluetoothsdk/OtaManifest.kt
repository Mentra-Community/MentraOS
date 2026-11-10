package com.mentra.bluetoothsdk

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import org.json.JSONObject

internal object OtaManifestDefaults {
    // ASG builds before 39 ignore ota_start.ota_version_url, so SDK checks must
    // use the same legacy production manifest those glasses will install from.
    const val LEGACY_PROD_OTA_VERSION_URL = "https://ota.mentraglass.com/prod_live_version.json"

    fun defaultOtaVersionUrl(): String {
        val manifestUrl = GeneratedReleaseMetadata.OTA_MANIFEST_URL.trim()
        if (manifestUrl.isBlank()) {
            throw BluetoothSdkException(
                "ota_manifest_unconfigured",
                "This source-built Bluetooth SDK has no embedded OTA manifest. Configure one with the debug API.",
            )
        }
        return manifestUrl
    }
}

internal object OtaManifestChecker {
    /**
     * Package the stock Mentra glasses client installs as, and the key every apps-shaped manifest
     * is pinned under. A client reporting any other package is a sideloaded build that this
     * manifest cannot describe.
     */
    internal const val ASG_CLIENT_PACKAGE = "com.mentra.asg_client"

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
        // Mentra 3.0 is the oldest downgrade-safe target, matching Engine, ASG, and recovery.
        // Coordinated releases guarantee higher supported ASG builds can downgrade; no source gate is needed.
        // The shipped floor may increase, never decrease, and must stay aligned across all checkers.
        // See asg_client/docs/mentra-live-spec.md#ota-and-updates.
        // An explicit non-positive override still disables downgrades.
        downgradeFloorVersionCode: Long = 51518114L,
    ): Boolean =
        hasApkUpdate(currentBuildNumber, manifest, downgradeFloorVersionCode) ||
            hasMtkUpdate(manifest, currentMtkVersion) ||
            hasBesUpdate(manifest.optJSONObject("bes_firmware"), currentBesVersion)

    fun hasMtkPatches(manifest: JSONObject): Boolean =
        (manifest.optJSONArray("mtk_patches")?.length() ?: 0) > 0 || manifest.optJSONObject("mtk_full_ota") != null

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

    private fun hasApkUpdate(
        currentBuildNumber: String,
        manifest: JSONObject,
        downgradeFloorVersionCode: Long,
    ): Boolean {
        val currentVersion =
            currentBuildNumber.toLongOrNull()
                ?: throw BluetoothSdkException(
                    "invalid_glasses_version",
                    "Cannot check OTA update because glasses build number is invalid.",
                )
        // Only apps-shaped manifests are exact pins. A legacy top-level manifest (versionCode at
        // the root, no apps entry) is NOT a pin and stays strictly upgrade-only, matching the
        // engine TS checker — otherwise a build newer than such a manifest would report a false
        // downgrade the JS path ignores.
        val isExactPin = manifest.optJSONObject("apps")?.optJSONObject(ASG_CLIENT_PACKAGE)?.hasNumber("versionCode") == true
        val serverVersion = latestAppInfo(manifest).requiredLong("versionCode")
        if (!isExactPin) {
            return serverVersion > currentVersion
        }
        // Exact pin: any mismatch is an update in either direction (downgrades take the
        // uninstall-then-reinstall detour on the glasses). A non-positive pin is only legitimate
        // in the frozen legacy rescue manifests that pre-39 glasses are checked against; for
        // modern glasses it means the manifest cannot verify anything, and that must surface as an
        // error — never as "no update".
        if (serverVersion <= 0) {
            if (currentVersion >= 39) {
                throw BluetoothSdkException(
                    "invalid_ota_manifest",
                    "OTA manifest ASG pin is missing or zero; cannot verify update state.",
                )
            }
            return false
        }
        if (serverVersion > currentVersion) {
            return true
        }
        // Exact match: already on the pin, no update.
        if (serverVersion == currentVersion) {
            return false
        }
        // Downgrade: only actionable at/above the enabled floor; a non-positive floor disables
        // downgrades (fail closed, matching ASG and the engine).
        return downgradeFloorVersionCode > 0 && serverVersion >= downgradeFloorVersionCode
    }

    /**
     * Mentra 3.0's MTK. No downgrade goes below it: downgrades keep userdata (photos and videos),
     * which holds only between builds with the same Android version, security patch level and AVB
     * rollback indexes. The glasses (MtkOtaSelector), the engine and iOS keep the same floor.
     */
    internal const val MTK_DOWNGRADE_FLOOR = "MentraLive_20260709"
    /** Each published downgrade's record, by its two versions. */
    internal const val MTK_DOWNGRADE_RECORD_BASE_URL = "https://mtkfirmware.mentraglass.com/"

    private fun normalizeMtk(version: String): String = version.trim().substringAfterLast('_')

    /** Date, then revision (a date-only version is revision 0); false when either is unknown. */
    internal fun isNewerMtk(target: String, current: String): Boolean {
        val pattern = Regex("[0-9]{8}(\\.[0-9]{1,9})?")
        val t = normalizeMtk(target)
        val c = normalizeMtk(current)
        if (!pattern.matches(t) || !pattern.matches(c)) return false
        val targetParts = t.split('.').map { it.toLong() }
        val currentParts = c.split('.').map { it.toLong() }
        return targetParts[0] > currentParts[0] ||
            (targetParts[0] == currentParts[0] && targetParts.getOrElse(1) { 0 } > currentParts.getOrElse(1) { 0 })
    }

    /**
     * The older MTK this manifest pins, from Mentra 3.0's up: its full OTA's version, or else the
     * one version its patches all end at.
     */
    internal fun mtkDowngradeTarget(manifest: JSONObject, currentVersion: String): String? {
        val full = manifest.optJSONObject("mtk_full_ota")
        var target: String? = (full?.opt("end_firmware") as? String)?.let(::normalizeMtk)
        if (full == null) {
            val patches = manifest.optJSONArray("mtk_patches")
            for (index in 0 until (patches?.length() ?: 0)) {
                val end = normalizeMtk(patches?.optJSONObject(index)?.optString("end_firmware", "") ?: "")
                if (target != null && target != end) return null
                target = end
            }
        }
        if (target == null || !isNewerMtk(currentVersion, target) || isNewerMtk(MTK_DOWNGRADE_FLOOR, target)) return null
        return target
    }

    /**
     * Whether the glasses would downgrade their MTK to the older one this manifest pins: its
     * release predates the newer MTK, so the downgrade's published record decides. Network.
     */
    fun hasMtkDowngrade(
        manifest: JSONObject,
        currentVersion: String,
        fetchRecord: (String) -> JSONObject? = ::fetchRecordOrNull,
    ): Boolean {
        val target = mtkDowngradeTarget(manifest, currentVersion) ?: return false
        val url = "${MTK_DOWNGRADE_RECORD_BASE_URL}mtk_ota_downgrade_${normalizeMtk(currentVersion)}_$target.json"
        val record = fetchRecord(url) ?: return false
        return normalizeMtk(record.optString("start_firmware", "")) == normalizeMtk(currentVersion) &&
            normalizeMtk(record.optString("end_firmware", "")) == target &&
            Regex("https?://[^/\\s]+/.*").matches(record.optString("url", "")) &&
            Regex("[a-fA-F0-9]{64}").matches(record.optString("sha256", "")) &&
            (record.opt("size") is Int || record.opt("size") is Long) &&
            record.optLong("size", 0) in 1..(1024L * 1024 * 1024)
    }

    private fun fetchRecordOrNull(url: String): JSONObject? =
        try {
            fetch(url)
        } catch (error: Exception) {
            null
        }

    private fun hasMtkUpdate(manifest: JSONObject, currentVersion: String): Boolean {
        if (currentVersion.isBlank()) return false
        val current = normalizeMtk(currentVersion)
        val patches = manifest.optJSONArray("mtk_patches")
        for (index in 0 until (patches?.length() ?: 0)) {
            val patch = patches?.optJSONObject(index) ?: continue
            // An upgrade only: a reverse patch listed here could be a userdata-wiping one.
            if (normalizeMtk(patch.optString("start_firmware", "")) == current &&
                isNewerMtk(patch.optString("end_firmware", ""), current)
            ) {
                return true
            }
        }
        val full = manifest.optJSONObject("mtk_full_ota") ?: return false
        val target = full.opt("end_firmware") as? String ?: return false
        return isNewerMtk(target, current) && !full.has("start_firmware") &&
            Regex("https?://[^/\\s]+/.*").matches(full.optString("url", "")) &&
            Regex("[a-fA-F0-9]{64}").matches(full.optString("sha256", "")) &&
            (full.opt("size") is Int || full.opt("size") is Long) &&
            full.optLong("size", 0) in 1..(1024L * 1024 * 1024)
    }

    private fun hasBesUpdate(besFirmware: JSONObject?, currentVersion: String): Boolean {
        if (besFirmware == null) return false
        val serverVersion = besFirmware.optString("version", "")
        if (serverVersion.isBlank()) {
            throw BluetoothSdkException("invalid_ota_manifest", "OTA manifest bes_firmware.version is missing.")
        }
        if (currentVersion.isBlank()) return true
        return serverVersion != currentVersion
    }

    private fun JSONObject.hasNumber(key: String): Boolean = !isNull(key) && opt(key) is Number

    private fun JSONObject.requiredLong(key: String): Long =
        (opt(key) as? Number)?.toLong()
            ?: throw BluetoothSdkException("invalid_ota_manifest", "OTA manifest is missing ASG app versionCode.")
}
