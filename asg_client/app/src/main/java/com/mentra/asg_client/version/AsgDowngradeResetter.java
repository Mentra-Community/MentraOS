package com.mentra.asg_client.version;

import android.content.Context;
import android.util.Log;
import java.io.File;

/** Performs the mandatory, media-preserving state reset before an ASG downgrade. */
public final class AsgDowngradeResetter {
    private static final String TAG = "AsgDowngradeReset";

    private static final String[] PREFERENCE_FILES = {
        "com.mentra.asg_client_preferences",
        "asg_settings",
        "MentraOSNetworkManager",
        "ota_session",
        "ota_state",
        "RecoveryWorkerManagerPrefs",
        "boot_stats"
    };

    private static final String[] QUEUE_DIRECTORIES = {"media_queue", "photo_queue"};

    private AsgDowngradeResetter() {}

    /** Clears app-owned state synchronously. User photos, videos, and all other media survive. */
    public static void reset(Context context) {
        Context app = context.getApplicationContext();
        clearPreferences(app);
        Context deviceProtected = app.createDeviceProtectedStorageContext();
        if (deviceProtected != null) {
            clearPreference(deviceProtected, "boot_stats");
        }
        clearQueueMetadata(app.getExternalFilesDir(null));
        Log.i(TAG, "Cleared ASG preferences and queue metadata; preserved user media");
    }

    private static void clearPreferences(Context context) {
        for (String name : PREFERENCE_FILES) {
            clearPreference(context, name);
        }
    }

    private static void clearPreference(Context context, String name) {
        if (!context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()) {
            throw new IllegalStateException("Could not clear downgrade preferences: " + name);
        }
    }

    static void clearQueueMetadata(File externalFilesDir) {
        if (externalFilesDir == null) {
            return;
        }
        for (String directory : QUEUE_DIRECTORIES) {
            File queueDir = new File(externalFilesDir, directory);
            delete(new File(queueDir, "queue_manifest.json"));
            delete(new File(queueDir, "queue_manifest.json.tmp"));
        }
    }

    private static void delete(File file) {
        if (file.exists() && !file.delete()) {
            throw new IllegalStateException("Could not clear downgrade state: " + file.getAbsolutePath());
        }
    }
}
