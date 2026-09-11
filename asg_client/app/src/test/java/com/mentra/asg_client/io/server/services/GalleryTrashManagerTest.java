package com.mentra.asg_client.io.server.services;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class GalleryTrashManagerTest {

    private File packageDirectory;
    private GalleryTrashManager manager;

    @Before
    public void setUp() throws Exception {
        packageDirectory = Files.createTempDirectory("gallery-trash-test").toFile();
        manager = new GalleryTrashManager(packageDirectory);
    }

    @After
    public void tearDown() throws Exception {
        deleteRecursively(packageDirectory);
    }

    @Test
    public void trashesAndRestoresDirectoryCaptureIdempotently() throws Exception {
        File capture = new File(packageDirectory, "VID_100");
        assertTrue(capture.mkdir());
        write(new File(capture, "base.mp4"), "video");

        GalleryTrashManager.Result first = manager.trashCapture("VID_100", "ack-1");
        assertTrue(first.success);
        assertFalse(first.alreadyTrashed);
        assertFalse(capture.exists());

        GalleryTrashManager.Result repeated = manager.trashCapture("VID_100", "ack-1");
        assertTrue(repeated.success);
        assertTrue(repeated.alreadyTrashed);
        assertEquals(1, manager.listTrashed().size());

        GalleryTrashManager.Result restored = manager.restoreCapture("VID_100");
        assertTrue(restored.success);
        assertTrue(new File(capture, "base.mp4").isFile());
        assertTrue(manager.listTrashed().isEmpty());
    }

    @Test
    public void flatCaptureMatchDoesNotUseUnsafePrefix() throws Exception {
        write(new File(packageDirectory, "IMG_1.jpg"), "one");
        write(new File(packageDirectory, "IMG_10.jpg"), "ten");

        GalleryTrashManager.Result result = manager.trashCapture("IMG_1", "ack-1");
        assertTrue(result.success);
        assertFalse(new File(packageDirectory, "IMG_1.jpg").exists());
        assertTrue(new File(packageDirectory, "IMG_10.jpg").exists());

        manager.restoreCapture("IMG_1");
        assertTrue(new File(packageDirectory, "IMG_1.jpg").isFile());
    }

    @Test
    public void retryReconcilesInterruptedFlatCaptureMove() throws Exception {
        File trashCapture = new File(packageDirectory, "_gallery_trash/IMG_2");
        assertTrue(trashCapture.mkdirs());
        write(new File(trashCapture, ".flat_layout"), "flat");
        write(new File(trashCapture, "IMG_2_ev0.jpg"), "bracket");
        write(new File(packageDirectory, "IMG_2.jpg"), "primary");

        GalleryTrashManager.Result result = manager.trashCapture("IMG_2", "ack-retry");

        assertTrue(result.success);
        assertTrue(result.alreadyTrashed);
        assertEquals(2, result.fileCount);
        assertFalse(new File(packageDirectory, "IMG_2.jpg").exists());
        assertTrue(new File(trashCapture, "IMG_2.jpg").isFile());
    }

    @Test
    public void rejectsInvalidAcknowledgementBeforeMovingCapture() throws Exception {
        File capture = new File(packageDirectory, "IMG_invalid_ack");
        assertTrue(capture.mkdir());
        write(new File(capture, "base.jpg"), "photo");

        try {
            manager.trashCapture("IMG_invalid_ack", "  \n  ");
            throw new AssertionError("Expected invalid acknowledgement to be rejected");
        } catch (IllegalArgumentException expected) {
            assertEquals("Invalid acknowledgement ID", expected.getMessage());
        }

        assertTrue(new File(capture, "base.jpg").isFile());
        assertFalse(new File(packageDirectory, "_gallery_trash/IMG_invalid_ack").exists());
    }

    @Test
    public void garbageCollectionOnlyRemovesTrash() throws Exception {
        write(new File(packageDirectory, "IMG_live.jpg"), "live");
        write(new File(packageDirectory, "IMG_old.jpg"), "old");
        manager.trashCapture("IMG_old", "ack-1");

        File trashed =
                manager.listTrashed().isEmpty()
                        ? null
                        : new File(
                                new File(packageDirectory, "_gallery_trash"),
                                manager.listTrashed().get(0).captureId);
        assertTrue(trashed != null && trashed.setLastModified(1));

        assertEquals(1, manager.garbageCollect(1));
        assertTrue(new File(packageDirectory, "IMG_live.jpg").isFile());
        assertTrue(manager.listTrashed().isEmpty());
    }

    @Test
    public void garbageCollectionRetainsInterruptedUnacknowledgedTrash() throws Exception {
        File interrupted = new File(packageDirectory, "_gallery_trash/VID_interrupted");
        assertTrue(interrupted.mkdirs());
        write(new File(interrupted, "base.mp4"), "partial-move");
        assertTrue(interrupted.setLastModified(1));

        assertEquals(0, manager.garbageCollect(1));
        assertTrue(new File(interrupted, "base.mp4").isFile());
    }

    private static void write(File file, String value) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteRecursively(File file) throws Exception {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(file.toPath());
    }
}
