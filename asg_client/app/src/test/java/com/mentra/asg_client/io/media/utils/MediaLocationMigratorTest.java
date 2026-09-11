package com.mentra.asg_client.io.media.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MediaLocationMigratorTest {
    private static final String PKG = "com.mentra.asg_client";

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private File write(File dir, String name, String content) throws Exception {
        dir.mkdirs();
        File f = new File(dir, name);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
        return f;
    }

    private String read(File f) throws Exception {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void movesKnownMediaEntriesAndLeavesOthers() throws Exception {
        File legacy = tmp.newFolder("legacy");
        File mediaRoot = new File(tmp.getRoot(), "asg_media");

        File captureDir = new File(legacy, PKG + ".camera/IMG_20260722_000516_460_542");
        write(captureDir, "base.jpg", "jpegbytes");
        write(captureDir, "imu.json", "{\"imu\":1}");
        write(new File(legacy, "media_queue"), "queue_manifest.json", "{}");
        write(new File(legacy, "thumbnails"), "thumb.jpg", "thumb");
        write(legacy, "IMG_20260101_000000.jpg", "flatphoto");
        // Non-media app-owned file must stay put (crash reports, caches).
        write(legacy, "report.txt", "not media");

        int moved = MediaLocationMigrator.migrate(legacy, mediaRoot, PKG);

        assertEquals(5, moved);
        assertEquals(
                "jpegbytes",
                read(new File(mediaRoot, PKG + ".camera/IMG_20260722_000516_460_542/base.jpg")));
        assertTrue(new File(mediaRoot, "media_queue/queue_manifest.json").exists());
        assertTrue(new File(mediaRoot, "thumbnails/thumb.jpg").exists());
        assertTrue(new File(mediaRoot, "IMG_20260101_000000.jpg").exists());
        assertFalse(new File(legacy, PKG + ".camera").exists());
        assertTrue("non-media file must not move", new File(legacy, "report.txt").exists());
    }

    @Test
    public void neverOverwritesExistingDestinationFiles() throws Exception {
        File legacy = tmp.newFolder("legacy");
        File mediaRoot = new File(tmp.getRoot(), "asg_media");

        write(new File(legacy, "media_queue"), "queue_manifest.json", "legacy manifest");
        write(new File(legacy, "media_queue"), "media_1_req.jpg", "queued payload");
        // The new build already recreated a fresh manifest at the destination.
        write(new File(mediaRoot, "media_queue"), "queue_manifest.json", "active manifest");

        int moved = MediaLocationMigrator.migrate(legacy, mediaRoot, PKG);

        // Payload moved, manifest clash kept the destination copy.
        assertEquals(1, moved);
        assertEquals("active manifest", read(new File(mediaRoot, "media_queue/queue_manifest.json")));
        assertTrue(new File(mediaRoot, "media_queue/media_1_req.jpg").exists());
        assertTrue("clashing source must be preserved", new File(legacy, "media_queue/queue_manifest.json").exists());
    }

    @Test
    public void migrationIsIdempotent() throws Exception {
        File legacy = tmp.newFolder("legacy");
        File mediaRoot = new File(tmp.getRoot(), "asg_media");
        write(new File(legacy, "photos"), "a.jpg", "a");

        assertEquals(1, MediaLocationMigrator.migrate(legacy, mediaRoot, PKG));
        assertEquals(0, MediaLocationMigrator.migrate(legacy, mediaRoot, PKG));
        assertEquals("a", read(new File(mediaRoot, "photos/a.jpg")));
    }

    @Test
    public void missingLegacyRootIsANoop() {
        assertEquals(
                0,
                MediaLocationMigrator.migrate(
                        new File(tmp.getRoot(), "does-not-exist"),
                        new File(tmp.getRoot(), "asg_media"),
                        PKG));
        assertEquals(0, MediaLocationMigrator.migrate(null, new File(tmp.getRoot(), "asg_media"), PKG));
    }
}
