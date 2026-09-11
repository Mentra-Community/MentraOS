package com.mentra.asg_client.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class CaptureRequestIdTest {

    @Test
    public void sanitizeForDirName_passesThroughTypicalRequestIds() {
        assertEquals(
                "photo_1751920000000_abc123",
                CaptureRequestId.sanitizeForDirName("photo_1751920000000_abc123"));
        assertEquals(
                "550e8400-e29b-41d4-a716-446655440000",
                CaptureRequestId.sanitizeForDirName("550e8400-e29b-41d4-a716-446655440000"));
    }

    @Test
    public void sanitizeForDirName_stripsPathAndUnsafeCharacters() {
        // Dots are not allowlisted: a surviving ".." would trip FileSecurityValidator's
        // path-traversal check when serving/deleting, stranding the capture.
        assertEquals("------etc-passwd", CaptureRequestId.sanitizeForDirName("../../etc/passwd"));
        assertEquals("a-b-c", CaptureRequestId.sanitizeForDirName("a/b\\c"));
        assertEquals("", CaptureRequestId.sanitizeForDirName("..."));
        assertEquals("v1-2-3", CaptureRequestId.sanitizeForDirName("v1.2.3"));
    }

    @Test
    public void sanitizeForDirName_handlesNullAndEmpty() {
        assertEquals("", CaptureRequestId.sanitizeForDirName(null));
        assertEquals("", CaptureRequestId.sanitizeForDirName(""));
    }

    @Test
    public void sanitizeForDirName_capsLength() {
        StringBuilder longId = new StringBuilder();
        for (int i = 0; i < 100; i++) {
            longId.append("a");
        }
        assertEquals(64, CaptureRequestId.sanitizeForDirName(longId.toString()).length());
    }

    @Test
    public void extractFromCaptureId_readsEmbeddedRequestId() {
        assertEquals(
                "photo_1751920000000_abc123",
                CaptureRequestId.extractFromCaptureId(
                        "IMG_20260709_143022_456_789_photo_1751920000000_abc123"));
        assertEquals(
                "req-42",
                CaptureRequestId.extractFromCaptureId("VID_20260425_003433_149_402_req-42"));
    }

    @Test
    public void extractFromCaptureId_returnsNullForButtonAndLegacyCaptures() {
        // Button capture: no embedded request ID.
        assertNull(CaptureRequestId.extractFromCaptureId("IMG_20260709_143022_456_789"));
        // Legacy flat-file stem without millis/random components.
        assertNull(CaptureRequestId.extractFromCaptureId("IMG_20250302_143022"));
        assertNull(CaptureRequestId.extractFromCaptureId("BUFFER_20260709_143022_456_789"));
        assertNull(CaptureRequestId.extractFromCaptureId(null));
    }

    @Test
    public void extractFromCaptureId_roundTripsSanitizedIds() {
        String sanitized = CaptureRequestId.sanitizeForDirName("photo:1751920000000/abc");
        String captureId = "IMG_20260709_143022_456_789_" + sanitized;
        assertEquals(sanitized, CaptureRequestId.extractFromCaptureId(captureId));
    }
}
