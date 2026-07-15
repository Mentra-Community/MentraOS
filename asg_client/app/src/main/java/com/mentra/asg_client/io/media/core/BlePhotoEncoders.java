package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;

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

    /** Encode {@code bitmap} with the selected codec without silently switching codecs. */
    static BlePhotoEncoder.EncodeResult encode(
            Bitmap bitmap,
            BleCodec codec,
            int quality,
            String sourceJpegPath)
            throws Exception {
        if (codec == BleCodec.JPEG_FAST) {
            return JPEG_FAST.encode(bitmap, quality, sourceJpegPath);
        }
        return AVIF.encode(bitmap, quality, sourceJpegPath);
    }
}
