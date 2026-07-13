package com.mentra.asg_client.io.media.core;

import androidx.annotation.Nullable;

import com.mentra.asg_client.AsgConstants;

/** Chooses whether a prepared BLE image should use the text-mode JPEG shortcut. */
final class BlePhotoEncodingPolicy {
    private BlePhotoEncodingPolicy() {}

    static boolean shouldUseJpeg(boolean textModeRequested, @Nullable byte[] jpegCandidate) {
        return textModeRequested
                && jpegCandidate != null
                && jpegCandidate.length < AsgConstants.TEXT_MODE_AVIF_SIZE_THRESHOLD_BYTES;
    }
}
