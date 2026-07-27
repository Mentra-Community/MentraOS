package com.mentra.asg_client.io.media.utils;

import android.content.Context;
import android.util.Log;

import java.io.File;

/**
 * Single source of truth for where capture media lives.
 *
 * <p>Media (photos, videos, audio, capture sidecars, upload queues, thumbnails) is stored under a
 * non-app-owned shared-storage root instead of {@code getExternalFilesDir()}. Hardware-verified
 * 2026-07-21: the OEM SystemUI uninstall used by the pinned-downgrade detour deletes the app-owned
 * {@code Android/data/&lt;pkg&gt;/files} tree even though the package itself survives as the
 * factory build, while root-level shared storage (like {@code /storage/emulated/0/asg}) is
 * preserved. Keeping media outside the app-owned tree is what makes an ASG downgrade unable to
 * destroy user captures.
 *
 * <p>The first build shipping this relocation is the downgrade floor
 * ({@code OtaConstants.DOWNGRADE_FLOOR_VERSION_CODE}): older builds read media from the app-owned
 * paths and must not be downgrade targets.
 */
public final class MediaStorage {
    private static final String TAG = "MediaStorage";

    /** Non-app-owned media root; sibling of the OTA staging dir, which survives uninstall. */
    public static final String MEDIA_ROOT_PATH = "/storage/emulated/0/asg_media";

    private static final Object MIGRATION_LOCK = new Object();
    private static volatile boolean migrationAttempted = false;

    private MediaStorage() {}

    /**
     * Returns the media root, running the one-time migration from the legacy app-owned tree on
     * first use in this process. Callers may use the returned directory immediately: migration is
     * complete (or skipped) by the time this returns.
     */
    public static File getMediaRoot(Context context) {
        File root = new File(MEDIA_ROOT_PATH);
        if (!migrationAttempted) {
            synchronized (MIGRATION_LOCK) {
                if (!migrationAttempted) {
                    try {
                        int moved =
                                MediaLocationMigrator.migrate(
                                        context.getExternalFilesDir(null),
                                        root,
                                        context.getPackageName());
                        if (moved > 0) {
                            Log.i(TAG, "Migrated " + moved + " media entries to " + MEDIA_ROOT_PATH);
                        }
                    } catch (Exception e) {
                        // Never block media capture on migration problems; unmigrated legacy
                        // files are retried on the next process start.
                        Log.e(TAG, "Media migration failed; continuing with new root", e);
                    }
                    migrationAttempted = true;
                }
            }
        }
        if (!root.exists() && !root.mkdirs()) {
            Log.e(TAG, "Failed to create media root: " + MEDIA_ROOT_PATH);
        }
        return root;
    }
}
