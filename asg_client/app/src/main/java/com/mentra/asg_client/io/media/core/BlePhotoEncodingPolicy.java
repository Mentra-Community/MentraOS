package com.mentra.asg_client.io.media.core;

import com.mentra.asg_client.AsgConstants;
import java.util.Locale;

/**
 * Chooses the payload codec for a prepared BLE image from the central ASG configuration constant.
 * Text mode and ordinary size-tier photos intentionally share this one policy — there is no
 * per-mode codec split.
 */
final class BlePhotoEncodingPolicy {
    private BlePhotoEncodingPolicy() {}

    static BleCodec selectCodec() {
        try {
            return BleCodec.valueOf(
                    AsgConstants.BLE_PHOTO_CODEC.toUpperCase(Locale.US));
        } catch (IllegalArgumentException | NullPointerException e) {
            return BleCodec.AVIF;
        }
    }
}
