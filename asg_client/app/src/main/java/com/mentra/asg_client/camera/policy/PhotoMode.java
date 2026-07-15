package com.mentra.asg_client.camera.policy;

import android.util.Log;

/** Normalizes SDK photo capture modes. */
public final class PhotoMode {

    public static final String PHOTO = "photo";
    public static final String TEXT = "text";

    private static final String TAG = "PhotoMode";

    private PhotoMode() {}

    /**
     * Normalizes a requested mode to {@code photo | text}. Missing and unknown values use the
     * regular photo mode for compatibility with older callers.
     */
    public static String normalize(String mode) {
        if (mode == null || mode.isEmpty()) {
            return PHOTO;
        }
        switch (mode) {
            case PHOTO:
            case TEXT:
                return mode;
            default:
                Log.w(TAG, "Unknown photo mode '" + mode + "' — using photo");
                return PHOTO;
        }
    }
}
