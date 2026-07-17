package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;

import androidx.annotation.Nullable;

import org.json.JSONObject;

/**
 * Selector over the concrete {@link BlePhotoEncoder} implementations. Callers pick a codec (via
 * {@link BlePhotoEncodingPolicy}) and get one encoding contract.
 */
final class BlePhotoEncoders {
    private static final JpegFastBleEncoder JPEG_FAST = new JpegFastBleEncoder();
    private static final AvifBleEncoder AVIF = new AvifBleEncoder();

    private BlePhotoEncoders() {}

    static BlePhotoEncoder forCodec(BleCodec codec) {
        return codec == BleCodec.JPEG_FAST ? JPEG_FAST : AVIF;
    }

    /** Encode a RAM-first capture without consulting the source JPEG path for IMU metadata. */
    static BlePhotoEncoder.EncodeResult encode(
            Bitmap bitmap,
            BleCodec codec,
            int quality,
            @Nullable String sourceJpegPath,
            @Nullable JSONObject imuPayload,
            @Nullable String intendedCapturePath)
            throws Exception {
        // A null source path explicitly identifies a RAM-first capture, including the valid case
        // where the IMU recorder produced no samples. Never probe a path that was intentionally
        // not persisted.
        if (codec == BleCodec.JPEG_FAST) {
            return sourceJpegPath == null
                    ? JPEG_FAST.encode(bitmap, quality, imuPayload, intendedCapturePath)
                    : JPEG_FAST.encode(bitmap, quality, sourceJpegPath);
        }
        return sourceJpegPath == null
                ? AVIF.encode(bitmap, quality, imuPayload, intendedCapturePath)
                : AVIF.encode(bitmap, quality, sourceJpegPath);
    }
}
