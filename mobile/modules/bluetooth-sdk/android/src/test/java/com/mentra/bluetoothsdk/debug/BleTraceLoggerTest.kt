package com.mentra.bluetoothsdk.debug

import org.assertj.core.api.Assertions.assertThat
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BleTraceLoggerTest {
    @Test
    fun `redacts notification content without mutating delivered payload`() {
        val body =
            JSONObject()
                .put("event", 0)
                .put("uid", 42)
                .put("title", "Private title")
                .put("subtitle", "Private subtitle")
                .put("message", "Private message")
                .put("appIdentifier", "com.example.private")
                .put("date", "20260821T120000")
                .put("messageSize", 15)
        val payload = JSONObject().put("C", "sr_ancs").put("B", body)

        val sanitized = BleTraceLogger.sanitizeForLogging(payload)
        val sanitizedBody = sanitized.getJSONObject("B")

        assertThat(sanitizedBody.getString("title")).isEqualTo("<redacted>")
        assertThat(sanitizedBody.getString("subtitle")).isEqualTo("<redacted>")
        assertThat(sanitizedBody.getString("message")).isEqualTo("<redacted>")
        assertThat(sanitizedBody.getString("appIdentifier")).isEqualTo("<redacted>")
        assertThat(sanitizedBody.getString("date")).isEqualTo("<redacted>")
        assertThat(sanitizedBody.getInt("event")).isEqualTo(0)
        assertThat(sanitizedBody.getInt("uid")).isEqualTo(42)
        assertThat(sanitizedBody.getInt("messageSize")).isEqualTo(15)

        assertThat(payload.getJSONObject("B").getString("title")).isEqualTo("Private title")
        assertThat(payload.getJSONObject("B").getString("message")).isEqualTo("Private message")
    }

    @Test
    fun `redacts compact chunk data while retaining reassembly metadata`() {
        val payload =
            JSONObject()
                .put("t", "ck")
                .put("id", "a7")
                .put("c", 1)
                .put("n", 4)
                .put("d", "private chunk content")

        val sanitized = BleTraceLogger.sanitizeForLogging(payload)

        assertThat(sanitized.getString("d")).isEqualTo("<redacted chunk data>")
        assertThat(sanitized.getString("id")).isEqualTo("a7")
        assertThat(sanitized.getInt("c")).isEqualTo(1)
        assertThat(sanitized.getInt("n")).isEqualTo(4)
        assertThat(payload.getString("d")).isEqualTo("private chunk content")
    }

    @Test
    fun `redacts notification event content while retaining routing metadata`() {
        val payload =
            JSONObject()
                .put("type", "phone_notification")
                .put("notificationId", "ancs-42")
                .put("app", "com.example.private")
                .put("title", "Private title")
                .put("content", "Private message")
                .put("packageName", "com.example.private")
                .put("priority", "1")

        val sanitized = BleTraceLogger.sanitizeForLogging(payload)

        assertThat(sanitized.getString("app")).isEqualTo("<redacted>")
        assertThat(sanitized.getString("title")).isEqualTo("<redacted>")
        assertThat(sanitized.getString("content")).isEqualTo("<redacted>")
        assertThat(sanitized.getString("packageName")).isEqualTo("<redacted>")
        assertThat(sanitized.getString("notificationId")).isEqualTo("ancs-42")
        assertThat(sanitized.getString("priority")).isEqualTo("1")
    }
}
