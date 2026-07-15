package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;

/**
 * One BLE photo payload encoder (one implementation per {@link BleCodec}). Implementations take
 * the fully processed (cropped/resized/sharpened) bitmap and return the encoded payload bytes.
 * The same encoders back both the live camera pipeline ({@code MediaCaptureService}) and the
 * on-device benchmark harness ({@code BlePhotoEncoderInstrumentedTest}).
 */
interface BlePhotoEncoder {
    /** Codec this encoder produces. */
    BleCodec codec();

    /**
     * Encode {@code bitmap} into a BLE payload. {@code sourceJpegPath} is the captured source
     * JPEG; it is only consulted to carry capture EXIF (IMU samples, capture ID) into the
     * payload, never re-decoded.
     */
    EncodeResult encode(Bitmap bitmap, int quality, String sourceJpegPath) throws Exception;

    /** Encoded payload plus the codec that actually produced it and the encode duration. */
    final class EncodeResult {
        final byte[] data;
        final BleCodec codecUsed;
        final long encodeMs;

        EncodeResult(byte[] data, BleCodec codecUsed, long encodeMs) {
            this.data = data;
            this.codecUsed = codecUsed;
            this.encodeMs = encodeMs;
        }
    }
}
