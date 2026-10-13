package com.mentra.bluetoothsdk

import android.content.Context
import java.util.UUID

/**
 * One random id per app install, shared by usage analytics (as the PostHog
 * `distinct_id`) and the startup update check, so both describe the same install.
 * It is created on first use whether or not analytics is enabled.
 */
internal object BluetoothSdkInstallId {
    private const val PREFS_NAME = "mentra_bluetooth_sdk_analytics"
    private const val PREFS_DISTINCT_ID = "distinct_id"

    @Synchronized
    fun get(context: Context): String {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.getString(PREFS_DISTINCT_ID, null)?.let { return it }
        val generated = "mentra-bt-sdk-${UUID.randomUUID()}"
        prefs.edit().putString(PREFS_DISTINCT_ID, generated).apply()
        return generated
    }
}
