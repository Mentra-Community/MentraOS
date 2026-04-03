package com.mentra.asg_client.utils;

import com.mentra.asg_client.io.file.core.FileManager.FileMetadata;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CaptureGalleryRulesTest {

    private static FileMetadata meta(String name, long size, long modified) {
        return new FileMetadata(name, "/fake/" + name, size, modified, "image/jpeg", "pkg");
    }

    @Test
    public void deriveCaptureId_folderBased() {
        assertEquals("IMG_1", CaptureGalleryRules.deriveCaptureId("IMG_1/base.jpg"));
        assertEquals("VID_2", CaptureGalleryRules.deriveCaptureId("VID_2/imu.json"));
    }

    @Test
    public void isPrimaryBaseFile_onlyFolderLeaves() {
        assertTrue(CaptureGalleryRules.isPrimaryBaseFile("IMG_x/base.jpg"));
        assertTrue(CaptureGalleryRules.isPrimaryBaseFile("IMG_x/base.JPEG"));
        assertTrue(CaptureGalleryRules.isPrimaryBaseFile("VID_x/base.mp4"));
        assertFalse(CaptureGalleryRules.isPrimaryBaseFile("IMG_x/ev0.jpg"));
        assertFalse(CaptureGalleryRules.isPrimaryBaseFile("base.jpg"));
    }

    @Test
    public void isValidCapture_requiresBase() {
        List<FileMetadata> hdrOnly = Arrays.asList(
                meta("IMG_1/ev-2.jpg", 1, 100),
                meta("IMG_1/ev0.jpg", 2, 100),
                meta("IMG_1/ev2.jpg", 3, 100));
        assertFalse(CaptureGalleryRules.isValidCapture(hdrOnly));

        List<FileMetadata> withBase = Arrays.asList(
                meta("IMG_1/ev0.jpg", 2, 100),
                meta("IMG_1/base.jpg", 10, 101));
        assertTrue(CaptureGalleryRules.isValidCapture(withBase));
    }

    @Test
    public void classifyValidCaptureKind_mp4Wins() {
        List<FileMetadata> video = Collections.singletonList(meta("VID_1/base.mp4", 100, 1));
        assertEquals(CaptureGalleryRules.CaptureMediaKind.VIDEO, CaptureGalleryRules.classifyValidCaptureKind(video));

        List<FileMetadata> photo = Collections.singletonList(meta("IMG_1/base.jpg", 10, 1));
        assertEquals(CaptureGalleryRules.CaptureMediaKind.PHOTO, CaptureGalleryRules.classifyValidCaptureKind(photo));
    }

    @Test
    public void totalSizeAggregation_validCaptureOnly() {
        List<FileMetadata> all = Arrays.asList(
                meta("IMG_ok/base.jpg", 100, 1),
                meta("IMG_ok/imu.json", 5, 2),
                meta("IMG_bad/ev0.jpg", 50, 3));
        Set<String> valid = CaptureGalleryRules.validCaptureIds(all);
        assertTrue(valid.contains("IMG_ok"));
        assertFalse(valid.contains("IMG_bad"));

        long sum = 0;
        for (FileMetadata m : all) {
            if (CaptureGalleryRules.isFileInValidCapture(m.getFileName(), valid)) {
                sum += m.getFileSize();
            }
        }
        assertEquals(105L, sum);
    }

    @Test
    public void assignFileRole() {
        assertEquals("sidecar", CaptureGalleryRules.assignFileRole("IMG_1/imu.json"));
        assertEquals("bracket", CaptureGalleryRules.assignFileRole("IMG_1/ev-2.jpg"));
        assertEquals("primary", CaptureGalleryRules.assignFileRole("IMG_1/base.jpg"));
    }

    @Test
    public void isOrphanAutoDeleteCaptureId() {
        assertTrue(CaptureGalleryRules.isOrphanAutoDeleteCaptureId("IMG_20250101_120000_0_1"));
        assertTrue(CaptureGalleryRules.isOrphanAutoDeleteCaptureId("VID_20250101_120000_0_1"));
        assertTrue(CaptureGalleryRules.isOrphanAutoDeleteCaptureId("BUFFER_1_req"));
        assertFalse(CaptureGalleryRules.isOrphanAutoDeleteCaptureId("unknown"));
    }

    @Test
    public void groupByCaptureId() {
        List<FileMetadata> all = Arrays.asList(
                meta("A/base.jpg", 1, 1),
                meta("A/imu.json", 1, 1));
        Map<String, List<FileMetadata>> g = CaptureGalleryRules.groupByCaptureId(all);
        assertEquals(2, g.get("A").size());
    }
}
