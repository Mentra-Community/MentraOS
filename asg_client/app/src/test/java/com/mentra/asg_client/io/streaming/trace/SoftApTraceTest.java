package com.mentra.asg_client.io.streaming.trace;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Covers the pure formatter. The {@code Log.i} wrapper is a one-liner and is exercised on device.
 */
public class SoftApTraceTest {

    @Test
    public void format_carriesTheGrepMarker() {
        String line = SoftApTrace.format("t1", "hotspot_started", 12);
        assertTrue(line.contains("SOFTAP_TRACE"));
    }

    @Test
    public void format_includesTraceIdStageAndElapsed() {
        String line = SoftApTrace.format("abc123", "ice_gathering_complete", 450);
        assertEquals(
                "[SOFTAP_TRACE] traceId=abc123 stage=ice_gathering_complete elapsedMs=450", line);
    }

    @Test
    public void format_omitsTraceIdWhenAbsent() {
        String line = SoftApTrace.format("", "boot", 0);
        assertEquals("[SOFTAP_TRACE] stage=boot elapsedMs=0", line);
    }

    @Test
    public void format_appendsKeyValuePairs() {
        String line = SoftApTrace.format("t", "whip_post", 7, "status", 201, "candidates", 3);
        assertTrue(line.endsWith("status=201 candidates=3"));
    }

    @Test
    public void format_ignoresAnOddTrailingKey() {
        String line = SoftApTrace.format("t", "s", 0, "paired", "yes", "dangling");
        assertTrue(line.contains("paired=yes"));
        assertFalse(line.contains("dangling"));
    }

    @Test
    public void sanitize_redactsHotspotPassword() {
        assertEquals("<redacted>", SoftApTrace.sanitize("password", "hunter2"));
        assertEquals("<redacted>", SoftApTrace.sanitize("hotspotPassword", "hunter2"));
        assertEquals("<redacted>", SoftApTrace.sanitize("psk", "hunter2"));
        assertEquals("<redacted>", SoftApTrace.sanitize("passphrase", "hunter2"));
    }

    @Test
    public void sanitize_redactsTokensAndCredentials() {
        assertEquals("<redacted>", SoftApTrace.sanitize("token", "eyJhbGciOi"));
        assertEquals("<redacted>", SoftApTrace.sanitize("acsToken", "eyJhbGciOi"));
        assertEquals("<redacted>", SoftApTrace.sanitize("Authorization", "Bearer x"));
        assertEquals("<redacted>", SoftApTrace.sanitize("credential", "x"));
        assertEquals(
                "<redacted>",
                SoftApTrace.sanitize("meetingUrl", "https://teams.microsoft.com/l/x"));
    }

    @Test
    public void format_neverLeaksASecretValueIntoTheLine() {
        String line =
                SoftApTrace.format(
                        "t", "hotspot_started", 5, "ssid", "MentraLive", "password", "hunter2");
        assertFalse(line.contains("hunter2"));
        assertTrue(line.contains("ssid=MentraLive"));
        assertTrue(line.contains("password=<redacted>"));
    }

    @Test
    public void sanitize_keepsTheLocalWhipUrlWhichIsDiagnostic() {
        assertEquals(
                "http://192.168.43.20:8790/whip/abc",
                SoftApTrace.sanitize("whipUrl", "http://192.168.43.20:8790/whip/abc"));
    }

    @Test
    public void sanitize_stripsQueryStringsThatMayCarryTokens() {
        assertEquals(
                "https://example.com/live?<redacted>",
                SoftApTrace.sanitize("playbackUrl", "https://example.com/live?token=secret123"));
    }

    @Test
    public void sanitize_stripsUserInfoFromUrls() {
        String result = SoftApTrace.sanitize("endpoint", "https://user:pw@example.com/x");
        assertFalse(result.contains("pw"));
        assertTrue(result.contains("<redacted>@example.com/x"));
    }

    @Test
    public void sanitize_quotesValuesContainingSpaces() {
        assertEquals("\"two words\"", SoftApTrace.sanitize("reason", "two words"));
    }

    @Test
    public void sanitize_rendersNullAndEmpty() {
        assertEquals("null", SoftApTrace.sanitize("reason", null));
        assertEquals("\"\"", SoftApTrace.sanitize("reason", ""));
    }
}
