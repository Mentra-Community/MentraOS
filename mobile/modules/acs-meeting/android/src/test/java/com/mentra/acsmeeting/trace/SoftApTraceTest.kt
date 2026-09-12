package com.mentra.acsmeeting.trace

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * Covers the pure formatter. The `Log.i` wrapper is a one-liner and is exercised on device.
 */
class SoftApTraceTest {

    @Test
    fun `format carries the grep marker`() {
        assertThat(SoftApTrace.format("t1", "scoped_network_available", 12))
            .contains("SOFTAP_TRACE")
    }

    @Test
    fun `format includes traceId stage and elapsed`() {
        assertThat(SoftApTrace.format("abc123", "ice_selected_pair", 450))
            .isEqualTo("[SOFTAP_TRACE] traceId=abc123 stage=ice_selected_pair elapsedMs=450")
    }

    @Test
    fun `format omits traceId when absent`() {
        assertThat(SoftApTrace.format("", "boot", 0))
            .isEqualTo("[SOFTAP_TRACE] stage=boot elapsedMs=0")
    }

    @Test
    fun `format appends fields in order`() {
        assertThat(SoftApTrace.format("t", "whip_request", 7, "method" to "POST", "status" to 201))
            .endsWith("method=POST status=201")
    }

    @Test
    fun `sanitize redacts the hotspot password`() {
        assertThat(SoftApTrace.sanitize("password", "hunter2")).isEqualTo("<redacted>")
        assertThat(SoftApTrace.sanitize("hotspotPassword", "hunter2")).isEqualTo("<redacted>")
        assertThat(SoftApTrace.sanitize("psk", "hunter2")).isEqualTo("<redacted>")
        assertThat(SoftApTrace.sanitize("passphrase", "hunter2")).isEqualTo("<redacted>")
    }

    @Test
    fun `sanitize redacts tokens and credentials`() {
        assertThat(SoftApTrace.sanitize("token", "eyJhbGciOi")).isEqualTo("<redacted>")
        assertThat(SoftApTrace.sanitize("acsToken", "eyJhbGciOi")).isEqualTo("<redacted>")
        assertThat(SoftApTrace.sanitize("Authorization", "Bearer x")).isEqualTo("<redacted>")
        assertThat(SoftApTrace.sanitize("meetingUrl", "https://teams.microsoft.com/l/x"))
            .isEqualTo("<redacted>")
    }

    @Test
    fun `format never leaks a secret value into the line`() {
        val line = SoftApTrace.format(
            "t", "hotspot_started", 5,
            "ssid" to "MentraLive", "password" to "hunter2",
        )
        assertThat(line).doesNotContain("hunter2")
        assertThat(line).contains("ssid=MentraLive")
        assertThat(line).contains("password=<redacted>")
    }

    @Test
    fun `sanitize keeps the local whip url which is diagnostic`() {
        assertThat(SoftApTrace.sanitize("whipUrl", "http://192.168.43.20:8790/whip/abc"))
            .isEqualTo("http://192.168.43.20:8790/whip/abc")
    }

    @Test
    fun `sanitize strips query strings that may carry tokens`() {
        assertThat(SoftApTrace.sanitize("playbackUrl", "https://example.com/live?token=secret123"))
            .isEqualTo("https://example.com/live?<redacted>")
    }

    @Test
    fun `sanitize strips userinfo from urls`() {
        val result = SoftApTrace.sanitize("endpoint", "https://user:pw@example.com/x")
        assertThat(result).doesNotContain("pw@")
        assertThat(result).contains("<redacted>@example.com/x")
    }

    @Test
    fun `sanitize quotes values containing spaces`() {
        assertThat(SoftApTrace.sanitize("reason", "two words")).isEqualTo("\"two words\"")
    }

    @Test
    fun `sanitize renders null and empty`() {
        assertThat(SoftApTrace.sanitize("reason", null)).isEqualTo("null")
        assertThat(SoftApTrace.sanitize("reason", "")).isEqualTo("\"\"")
    }

    @Test
    fun `newTraceId produces distinct ids`() {
        assertThat(SoftApTrace.newTraceId()).isNotEqualTo(SoftApTrace.newTraceId())
    }
}
