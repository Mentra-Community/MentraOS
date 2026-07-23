package com.mentra.asg_client.camera.policy;

import android.util.Log;

import com.mentra.asg_client.camera.CameraConstants;

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

    /**
     * Resolves the sensor capture tier for a mode. Text mode uses the internal {@link
     * CameraConstants#SIZE_TEXT} tier (dimensions from {@code AsgConstants}); regular photos
     * preserve the caller's normalized quality tier.
     */
    public static String captureSize(String mode, String requestedSize) {
        return TEXT.equals(normalize(mode))
                ? CameraConstants.SIZE_TEXT
                : PhotoSizeTier.normalize(requestedSize);
    }
}
