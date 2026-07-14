package com.mentra.asg_client.io.media.core;

import android.util.Log;

import com.mentra.asg_client.AsgConstants;

/**
 * Chooses the payload codec for a prepared BLE image. Text mode defaults to the low-latency
 * {@link BleCodec#JPEG_FAST} path (configured via {@link AsgConstants#TEXT_MODE_BLE_CODEC});
 * ordinary size-tier photos keep the established AVIF path. This replaces the old
 * "encode a q95 JPEG candidate, keep it only under 200KB, otherwise also pay for AVIF" gate,
 * which double-encoded most text photos.
 */
final class BlePhotoEncodingPolicy {
    private static final String TAG = "BlePhotoEncodingPolicy";

    private BlePhotoEncodingPolicy() {}

    static BleCodec selectCodec(boolean textModeRequested) {
        if (!textModeRequested) {
            return BleCodec.AVIF;
        }
        return parseCodec(AsgConstants.TEXT_MODE_BLE_CODEC);
    }

    /** Visible for tests. Unknown names fall back to AVIF, the proven path. */
    static BleCodec parseCodec(String name) {
        try {
            return BleCodec.valueOf(name);
        } catch (IllegalArgumentException | NullPointerException e) {
            Log.w(TAG, "Unknown BLE codec '" + name + "', falling back to AVIF");
            return BleCodec.AVIF;
        }
    }
}
