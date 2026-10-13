package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BesIncidentTest {
    @Test
    public void bootIdsAreSixteenLowercaseHexAndNeverZero() {
        assertTrue(BesIncident.isBootId("9f3a0c1b2d4e5f60"));
        assertFalse(BesIncident.isBootId("0000000000000000"));
        assertFalse(BesIncident.isBootId("9F3A0C1B2D4E5F60"));
        assertFalse(BesIncident.isBootId("9f3a0c1b"));
        assertFalse(BesIncident.isBootId(null));
    }

    @Test
    public void dumpIdsAreSeqDashCrc() {
        assertTrue(BesIncident.isDumpId("0000002a-1f2e3d4c"));
        assertEquals("1f2e3d4c", BesIncident.dumpIdCrc("0000002a-1f2e3d4c"));
        assertFalse(BesIncident.isDumpId("none"));
        assertFalse(BesIncident.isDumpId("2a-1f2e3d4c"));
        assertNull(BesIncident.dumpIdCrc("none"));
    }

    @Test
    public void headerAndTrailerParse() {
        BesIncident.DumpHeader header = BesIncident.parseHeader(
                "[CRASH-DUMP] v=1 dump_id=0000002a-1f2e3d4c len=23456 crc=1f2e3d4c\n");
        assertNotNull(header);
        assertEquals("0000002a-1f2e3d4c", header.dumpId);
        assertEquals(23456, header.len);
        assertEquals("1f2e3d4c", header.crcHex);
        assertTrue(BesIncident.parseHeader("[CRASH-DUMP] v=1 dump_id=none len=0 crc=00000000")
                .isNone());
        assertNull(BesIncident.parseHeader("[CRASH-DUMP] v=2 dump_id=none len=0 crc=00000000"));
        assertNull(BesIncident.parseHeader("[CRASH-DUMP] v=1 dump_id=x len=1 crc=1F2E3D4C"));
        assertNull(BesIncident.parseHeader(null));

        BesIncident.Trailer trailer = BesIncident.parseTrailer(
                "[CRASH-TRUNCATED] sent=79200 total=90000 crc=0a0b0c0d");
        assertNotNull(trailer);
        assertEquals(79200, trailer.sent);
        assertEquals(90000, trailer.total);
        assertEquals("0a0b0c0d", trailer.crcHex);
        assertNull(BesIncident.parseTrailer("[CRASH-TRUNCATED] sent=1 total=2"));
    }

    @Test
    public void crashContextGivesBootResetCodesAndAValidCrashTimeOnly() {
        String text = "[CRASH-CONTEXT] v=2 seq=42 boot_id=1a2b3c4d5e6f7081 uptime_ms=10"
                + " unix_ms=1790000000000 clock=2 age_ms=5000 boot_anchor_ms=1"
                + " reset_hw=0x1f reset_sw=0x02000000\n";
        BesIncident.DumpContext ctx = BesIncident.parseDumpContext(text);
        assertEquals("1a2b3c4d5e6f7081", ctx.bootId);
        assertEquals(Long.valueOf(0x1f), ctx.resetHw);
        assertEquals(Long.valueOf(0x02000000L), ctx.resetSw);
        assertEquals(1_790_000_000_000L, ctx.crashUnixMs);

        // Unknown clock, expired anchor and out-of-range times never become a crash time.
        assertEquals(0, BesIncident.parseDumpContext(text.replace("clock=2", "clock=0")).crashUnixMs);
        assertEquals(0, BesIncident.parseDumpContext(text.replace("age_ms=5000", "age_ms=21600001"))
                .crashUnixMs);
        assertEquals(0, BesIncident.parseDumpContext(text.replace("unix_ms=1790000000000", "unix_ms=5"))
                .crashUnixMs);
    }

    @Test
    public void legacyDumpHasNoBootIdAndNoTail() {
        BesIncident.DumpContext ctx = BesIncident.parseDumpContext(
                "[CRASH-CONTEXT] v=1 seq=3 uptime_ms=5 unix_ms=0 clock=0 age_ms=0"
                        + " boot_anchor_ms=0 reset_hw=0x0 reset_sw=0x00000000\nabrupt\n");
        assertNull(ctx.bootId);
        assertFalse(ctx.tailCaptured);
        assertFalse(ctx.torn);
        assertFalse(ctx.logLost);
        assertEquals(Long.valueOf(0), ctx.resetHw);
    }

    @Test
    public void tailFlagsAreRead() {
        BesIncident.DumpContext ctx = BesIncident.parseDumpContext(
                "[CRASH-TAIL] captured=100 requested=900 truncated=1 torn=1\nx\n[CRASH-TAIL-END]\n");
        assertTrue(ctx.tailCaptured);
        assertTrue(ctx.tailTruncated);
        assertTrue(ctx.torn);
        BesIncident.DumpContext empty = BesIncident.parseDumpContext(
                "[CRASH-TAIL] captured=0 requested=900 truncated=1 torn=0\n");
        assertFalse(empty.tailCaptured);
    }

    @Test
    public void defaultResetClassifierIsConservative() {
        ResetClassifier classifier = new DefaultResetClassifier();
        assertFalse(classifier.isUnexpected(0, 0));
        assertFalse(classifier.isUnexpected(0x1e, 0));
        // Measured codes (docs/crash-timestamps.md): watchdog/assert/exception restart.
        assertTrue(classifier.isUnexpected(0x01, 0x00800030));
        // Requested restarts: BES soft reboot and OTA apply.
        assertFalse(classifier.isUnexpected(0x02, 0x00800030));
        assertFalse(classifier.isUnexpected(0x02, 0x00810030));
        assertFalse(classifier.isUnexpected(0, 1L << 16));
        assertFalse(classifier.isUnexpected(0xffff, 0x00ffffff));
        assertTrue(classifier.isUnexpected(0, 1L << 25));
    }
}
