package com.mentra.asg_client.version;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class AsgDowngradeResetterTest {
    @Test
    public void clearsAllPreferencesAndQueueMetadataButPreservesMedia() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        String[] preferences = {
            "com.mentra.asg_client_preferences",
            "asg_settings",
            "MentraOSNetworkManager",
            "ota_session",
            "ota_state",
            "RecoveryWorkerManagerPrefs",
            "boot_stats"
        };
        for (String name : preferences) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().putString("state", "old").commit();
        }
        context.createDeviceProtectedStorageContext()
                .getSharedPreferences("boot_stats", Context.MODE_PRIVATE)
                .edit()
                .putString("state", "old")
                .commit();

        File external = context.getExternalFilesDir(null);
        File mediaQueue = new File(external, "media_queue");
        File photoQueue = new File(external, "photo_queue");
        assertTrue(mediaQueue.mkdirs() || mediaQueue.isDirectory());
        assertTrue(photoQueue.mkdirs() || photoQueue.isDirectory());
        File mediaManifest = new File(mediaQueue, "queue_manifest.json");
        File mediaManifestTmp = new File(mediaQueue, "queue_manifest.json.tmp");
        File photoManifest = new File(photoQueue, "queue_manifest.json");
        File photoManifestTmp = new File(photoQueue, "queue_manifest.json.tmp");
        File video = new File(mediaQueue, "recording.mp4");
        File photo = new File(photoQueue, "capture.jpg");
        for (File manifest :
                new File[] {mediaManifest, mediaManifestTmp, photoManifest, photoManifestTmp}) {
            Files.write(manifest.toPath(), "{}".getBytes(StandardCharsets.UTF_8));
        }
        Files.write(video.toPath(), "video".getBytes(StandardCharsets.UTF_8));
        Files.write(photo.toPath(), "photo".getBytes(StandardCharsets.UTF_8));

        AsgDowngradeResetter.reset(context);

        for (String name : preferences) {
            assertTrue(context.getSharedPreferences(name, Context.MODE_PRIVATE).getAll().isEmpty());
        }
        assertTrue(
                context.createDeviceProtectedStorageContext()
                        .getSharedPreferences("boot_stats", Context.MODE_PRIVATE)
                        .getAll()
                        .isEmpty());
        assertFalse(mediaManifest.exists());
        assertFalse(mediaManifestTmp.exists());
        assertFalse(photoManifest.exists());
        assertFalse(photoManifestTmp.exists());
        assertTrue(video.exists());
        assertTrue(photo.exists());
    }
}
