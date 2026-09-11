package com.mentra.asg_client.io.media.utils;

import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * One-time move of capture media from the legacy app-owned external-files tree to the shared
 * media root.
 *
 * <p>Moves only the known media entries (capture package directories, upload queues, thumbnails,
 * media type directories, and legacy flat {@code IMG_*}/{@code VID_*} entries) so unrelated
 * app-owned files (crash reports, caches) stay where they are. Same-volume moves use
 * {@link File#renameTo}, falling back to copy-then-delete. Existing destination files are never
 * overwritten: on a partially migrated tree the remaining source files are moved and clashes keep
 * the destination copy, so re-running is always safe.
 */
public final class MediaLocationMigrator {
    private static final String TAG = "MediaLocationMigrator";

    /** Media directory names shared between the legacy tree and the new root. */
    static final String[] MEDIA_DIR_NAMES = {
        PhotoQueueDirs.PHOTO_QUEUE,
        PhotoQueueDirs.MEDIA_QUEUE,
        "thumbnails",
        MediaUtils.PHOTOS_DIR,
        MediaUtils.VIDEOS_DIR,
        MediaUtils.AUDIO_DIR,
        MediaUtils.TEMP_DIR,
    };

    /** Names of the queue directories, kept here to avoid a dependency cycle with the managers. */
    static final class PhotoQueueDirs {
        static final String PHOTO_QUEUE = "photo_queue";
        static final String MEDIA_QUEUE = "media_queue";

        private PhotoQueueDirs() {}
    }

    private MediaLocationMigrator() {}

    /**
     * Moves the known media entries from {@code legacyRoot} into {@code mediaRoot}.
     *
     * @param legacyRoot the app-owned external-files dir (may be null or missing)
     * @param mediaRoot the shared media root
     * @param packageName used to locate the capture package directory ({@code <pkg>.camera})
     * @return number of files moved
     */
    public static int migrate(File legacyRoot, File mediaRoot, String packageName) {
        if (legacyRoot == null || !legacyRoot.isDirectory()) {
            return 0;
        }
        List<File> sources = new ArrayList<>();
        File cameraDir = new File(legacyRoot, packageName + ".camera");
        if (cameraDir.exists()) {
            sources.add(cameraDir);
        }
        for (String name : MEDIA_DIR_NAMES) {
            File dir = new File(legacyRoot, name);
            if (dir.exists()) {
                sources.add(dir);
            }
        }
        File[] flatEntries = legacyRoot.listFiles(
                (dir, name) -> name.startsWith("IMG_") || name.startsWith("VID_"));
        if (flatEntries != null) {
            for (File entry : flatEntries) {
                sources.add(entry);
            }
        }
        if (sources.isEmpty()) {
            return 0;
        }
        if (!mediaRoot.exists() && !mediaRoot.mkdirs()) {
            Log.e(TAG, "Cannot create media root " + mediaRoot.getAbsolutePath());
            return 0;
        }
        int moved = 0;
        for (File source : sources) {
            moved += moveEntry(source, new File(mediaRoot, source.getName()));
        }
        return moved;
    }

    private static int moveEntry(File source, File destination) {
        if (!destination.exists() && source.renameTo(destination)) {
            return countFiles(destination);
        }
        if (source.isDirectory()) {
            if (destination.exists() && !destination.isDirectory()) {
                Log.e(TAG, "Destination clash (file vs dir), keeping both: " + destination);
                return 0;
            }
            if (!destination.exists() && !destination.mkdirs()) {
                Log.e(TAG, "Cannot create " + destination.getAbsolutePath());
                return 0;
            }
            int moved = 0;
            File[] children = source.listFiles();
            if (children != null) {
                for (File child : children) {
                    moved += moveEntry(child, new File(destination, child.getName()));
                }
            }
            File[] remaining = source.listFiles();
            if (remaining != null && remaining.length == 0 && !source.delete()) {
                Log.w(TAG, "Could not remove emptied legacy dir " + source.getAbsolutePath());
            }
            return moved;
        }
        // Source is a file. Never overwrite an existing destination byte: keep the destination
        // copy (it is the one active code already sees) and leave the source for inspection.
        if (destination.exists()) {
            Log.w(TAG, "Destination exists, keeping it: " + destination.getAbsolutePath());
            return 0;
        }
        try {
            copyFile(source, destination);
        } catch (IOException e) {
            Log.e(TAG, "Copy failed for " + source.getAbsolutePath(), e);
            if (destination.exists() && !destination.delete()) {
                Log.w(TAG, "Could not remove partial copy " + destination.getAbsolutePath());
            }
            return 0;
        }
        if (!source.delete()) {
            Log.w(TAG, "Moved but could not delete source " + source.getAbsolutePath());
        }
        return 1;
    }

    private static void copyFile(File source, File destination) throws IOException {
        try (FileInputStream in = new FileInputStream(source);
                FileOutputStream out = new FileOutputStream(destination)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
        }
    }

    private static int countFiles(File entry) {
        if (entry.isFile()) {
            return 1;
        }
        int count = 0;
        File[] children = entry.listFiles();
        if (children != null) {
            for (File child : children) {
                count += countFiles(child);
            }
        }
        return count;
    }
}
