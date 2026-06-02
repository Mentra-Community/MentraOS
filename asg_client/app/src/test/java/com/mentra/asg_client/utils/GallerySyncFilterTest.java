package com.mentra.asg_client.utils;

import org.junit.Test;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GallerySyncFilterTest {

    @Test
    public void isZeroBytePrimaryVideo_detectsBaseMp4() {
        assertTrue(GallerySyncFilter.isZeroBytePrimaryVideo("VID_20260425_003433_149_402/base.mp4", 0));
    }

    @Test
    public void isZeroBytePrimaryVideo_ignoresNonZeroFiles() {
        assertFalse(GallerySyncFilter.isZeroBytePrimaryVideo("VID_test/base.mp4", 1024));
    }

    @Test
    public void isCaptureBlockedFromSync_matchesActiveAndPendingSets() {
        String fileName = "VID_active/base.mp4";
        Set<String> pending = new HashSet<>();
        pending.add("VID_pending");

        assertTrue(GallerySyncFilter.isCaptureBlockedFromSync(fileName, "VID_active", pending));
        assertTrue(GallerySyncFilter.isCaptureBlockedFromSync("VID_pending/base.mp4", null, pending));
        assertFalse(GallerySyncFilter.isCaptureBlockedFromSync("VID_done/base.mp4", null, Collections.emptySet()));
    }

    @Test
    public void deriveCaptureId_handlesFolderPaths() {
        assertEquals("VID_20260425_003433_149_402",
                GallerySyncFilter.deriveCaptureId("VID_20260425_003433_149_402/base.mp4"));
    }

    private static void assertEquals(String expected, String actual) {
        org.junit.Assert.assertEquals(expected, actual);
    }
}
