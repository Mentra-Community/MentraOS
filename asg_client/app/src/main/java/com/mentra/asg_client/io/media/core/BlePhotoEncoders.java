package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;
import android.util.Log;

/**
 * Selector over the concrete {@link BlePhotoEncoder} implementations. Callers pick a codec (via
 * {@link BlePhotoEncodingPolicy}) and get one contract: {@link #encodeWithFallback} runs the
 * selected encoder and, when the JPEG fast path fails, retries with the AVIF encoder so a
 * metadata or Skia hiccup degrades to the slow-but-proven path instead of failing the photo.
 */
final class BlePhotoEncoders {
    private static final String TAG = "BlePhotoEncoders";

    private static final JpegFastBleEncoder JPEG_FAST = new JpegFastBleEncoder();
    private static final AvifBleEncoder AVIF = new AvifBleEncoder();

    private BlePhotoEncoders() {}

    static BlePhotoEncoder forCodec(BleCodec codec) {
        return codec == BleCodec.JPEG_FAST ? JPEG_FAST : AVIF;
    }

    /**
     * Encode {@code bitmap} with the encoder for {@code codec}. A {@link BleCodec#JPEG_FAST}
     * failure falls back to AVIF at {@code avifFallbackQuality} (JPEG and AVIF quality scales
     * are not comparable, so each codec keeps its own tuned value). An AVIF failure propagates:
     * there is no cheaper codec left to fall back to, and the caller's error path already
     * handles it.
     */
    static BlePhotoEncoder.EncodeResult encodeWithFallback(
            Bitmap bitmap,
            BleCodec codec,
            int quality,
            int avifFallbackQuality,
            String sourceJpegPath)
            throws Exception {
        if (codec == BleCodec.JPEG_FAST) {
            try {
                return JPEG_FAST.encode(bitmap, quality, sourceJpegPath);
            } catch (Exception e) {
                Log.w(
                        TAG,
                        "JPEG_FAST encode failed, falling back to AVIF q"
                                + avifFallbackQuality
                                + ": "
                                + e.getMessage(),
                        e);
                return AVIF.encode(bitmap, avifFallbackQuality, sourceJpegPath);
            }
        }
        return AVIF.encode(bitmap, quality, sourceJpegPath);
    }
}
