package com.mentra.bluetoothsdk.debug

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class BleTraceLoggerTest {
    @Test
    fun wifiScanPreservesBooleanSecurityWhileRedactingCredentials() {
        val secret = UUID.randomUUID().toString()
        val networks = JSONArray()
        for (secured in listOf(true, false)) {
            networks.put(
                JSONObject()
                    .put("ssid", if (secured) "secured-fixture" else "open-fixture")
                    .put("requiresPassword", secured)
                    .put("signalStrength", -45)
                    .put("password", secret)
                    .put("token", secret)
            )
        }
        ShadowLog.clear()
        BleTraceLogger.logJson(
            "glasses_to_phone",
            "sdk_ble_event",
            JSONObject().put("type", "wifi_scan_result").put("networks_neo", networks),
        )
        val message = ShadowLog.getLogsForTag("MentraBleTrace").single().msg
        assertFalse(message.contains(secret))
        val actual = JSONObject(message.substringAfter("payload=")).getJSONArray("networks_neo")
        for ((index, secured) in listOf(true, false).withIndex()) {
            val item = actual.getJSONObject(index)
            assertEquals(secured, item.get("requiresPassword"))
            assertEquals(-45, item.getInt("signalStrength"))
            assertEquals("<redacted>", item.getString("password"))
            assertEquals("<redacted>", item.getString("token"))
        }
    }

    @Test
    fun exceptionDoesNotExposeNonBooleanOrOtherPasswordFields() {
        val secret = UUID.randomUUID().toString()
        ShadowLog.clear()
        BleTraceLogger.logJson(
            "glasses_to_phone",
            "sdk_ble_event",
            JSONObject()
                .put("type", "wifi_scan_result")
                .put("requiresPassword", secret)
                .put("password", true)
                .put("RequiresPassword", false),
        )
        val message = ShadowLog.getLogsForTag("MentraBleTrace").single().msg
        assertFalse(message.contains(secret))
        val actual = JSONObject(message.substringAfter("payload="))
        for (key in listOf("requiresPassword", "password", "RequiresPassword")) {
            assertEquals("<redacted>", actual.getString(key))
        }
    }
}
