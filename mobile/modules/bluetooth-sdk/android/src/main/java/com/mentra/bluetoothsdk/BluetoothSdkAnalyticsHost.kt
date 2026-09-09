package com.mentra.bluetoothsdk

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build

/**
 * Host-app facts attached to every analytics event so Mentra can separate store
 * installs from sideloaded, debuggable, and internal-lane builds.
 */
internal data class BluetoothSdkAnalyticsHostProperties(
    val appVersion: String?,
    val appBuild: String?,
    val buildType: String,
    val installSource: String,
    val installerPackage: String?,
    val environment: String?,
) {
    fun toMap(): Map<String, Any> =
        buildMap {
            appVersion?.let { put("app_version", it) }
            appBuild?.let { put("app_build", it) }
            put("app_build_type", buildType)
            put("app_install_source", installSource)
            installerPackage?.let { put("app_installer_package", it) }
            environment?.let { put("app_environment", it) }
        }
}

internal object BluetoothSdkAnalyticsHost {
    /**
     * Optional host-declared lane (`dev`, `staging`, `prod`, ...). Stamped by the Expo
     * config plugin's `analytics.environment` option; native apps may set it directly.
     */
    const val META_ENVIRONMENT = "com.mentra.bluetoothsdk.analytics.environment"

    private val environmentPattern = Regex("^[a-z0-9][a-z0-9_-]{0,31}$")

    /**
     * Android cannot tell a Play production install from a Play testing track: both
     * arrive through `com.android.vending`. `app_environment` is the host's way to
     * add that distinction. A missing installer means adb, a file manager, or an
     * IDE put the APK on the device.
     */
    fun installSourceFor(installerPackage: String?): String =
        when (installerPackage?.trim()?.takeIf { it.isNotEmpty() }) {
            null -> "sideload"
            "com.android.vending" -> "play_store"
            "com.amazon.venezia" -> "amazon_appstore"
            "com.sec.android.app.samsungapps" -> "galaxy_store"
            "com.huawei.appmarket" -> "huawei_appgallery"
            "com.xiaomi.market" -> "xiaomi_getapps"
            else -> "other_store"
        }

    fun normalizedEnvironment(raw: String?): String? =
        raw?.trim()?.lowercase()?.takeIf { environmentPattern.matches(it) }

    fun resolve(context: Context): BluetoothSdkAnalyticsHostProperties {
        val packageManager = context.packageManager
        val packageName = context.packageName
        val packageInfo =
            try {
                packageManager.getPackageInfo(packageName, 0)
            } catch (_: Exception) {
                null
            }
        val applicationInfo =
            try {
                packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
            } catch (_: Exception) {
                null
            }
        val installer =
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    packageManager.getInstallSourceInfo(packageName).installingPackageName
                } else {
                    @Suppress("DEPRECATION")
                    packageManager.getInstallerPackageName(packageName)
                }
            } catch (_: Exception) {
                null
            }
        val debuggable = ((applicationInfo?.flags ?: 0) and ApplicationInfo.FLAG_DEBUGGABLE) != 0

        return BluetoothSdkAnalyticsHostProperties(
            appVersion = packageInfo?.versionName?.trim()?.takeIf { it.isNotEmpty() },
            appBuild = packageInfo?.longVersionCode?.toString(),
            buildType = if (debuggable) "debug" else "release",
            installSource = installSourceFor(installer),
            installerPackage = installer?.trim()?.takeIf { it.isNotEmpty() },
            environment = normalizedEnvironment(applicationInfo?.metaData?.getString(META_ENVIRONMENT)),
        )
    }
}
