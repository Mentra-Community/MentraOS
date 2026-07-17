package com.mentra.asg_client.camera.policy;

import android.util.Log;

import com.mentra.asg_client.camera.CameraConstants;

/** Normalizes photo size tier strings (legacy + canonical). */
public final class PhotoSizeTier {

    private static final String TAG = "PhotoSizeTier";

    private PhotoSizeTier() {}

    /**
     * Maps legacy tier names to canonical {@code low | medium | high | max}. Unknown values fall
     * through unchanged so newer phones can talk to older glasses firmware without crashing.
     */
    public static String normalize(String size) {
        if (size == null || size.isEmpty()) {
            return CameraConstants.SIZE_MEDIUM;
        }
        switch (size) {
            case "small":
                Log.w(TAG, "Deprecated photo size 'small' — use 'low'");
                return CameraConstants.SIZE_LOW;
            case "large":
                Log.w(TAG, "Deprecated photo size 'large' — use 'high'");
                return CameraConstants.SIZE_HIGH;
            case "full":
                Log.w(TAG, "Deprecated photo size 'full' — use 'max'");
                return CameraConstants.SIZE_MAX;
            case CameraConstants.SIZE_LOW:
            case CameraConstants.SIZE_MEDIUM:
            case CameraConstants.SIZE_HIGH:
            case CameraConstants.SIZE_MAX:
                return size;
            default:
                Log.w(TAG, "Unknown photo size '" + size + "' — using medium");
                return CameraConstants.SIZE_MEDIUM;
        }
    }

    /**
     * Normalizes a size after {@link PhotoMode#captureSize} has resolved the capture mode. Unlike
     * {@link #normalize}, this accepts the internal text-mode sensor tier; do not use it to parse a
     * public {@code size} wire field.
     */
    public static String normalizeCaptureSize(String size) {
        return CameraConstants.SIZE_TEXT.equals(size) ? size : normalize(size);
    }
}
