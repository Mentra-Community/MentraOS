package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;

import androidx.annotation.Nullable;

import com.mentra.asg_client.camera.lifecycle.PhotoExifMetadataWriter;

import org.json.JSONObject;

/**
 * AVIF BLE payload encoder. Thin adapter over the established {@link
 * PhotoExifMetadataWriter#encodeAvifForBle} path (HeifCoder software AV1, or AvifWriter+MediaCodec
 * where an AV1 hardware encoder exists), so AVIF stays fully available as a selectable codec and as
 * the fallback when {@link JpegFastBleEncoder} fails.
 */
final class AvifBleEncoder implements BlePhotoEncoder {
    @Override
    public BleCodec codec() {
        return BleCodec.AVIF;
    }

    @Override
    public EncodeResult encode(Bitmap bitmap, int quality, String sourceJpegPath) throws Exception {
        long start = System.currentTimeMillis();
        byte[] avif = PhotoExifMetadataWriter.encodeAvifForBle(bitmap, quality, sourceJpegPath);
        return new EncodeResult(avif, BleCodec.AVIF, System.currentTimeMillis() - start);
    }

    EncodeResult encode(
            Bitmap bitmap,
            int quality,
            @Nullable JSONObject imuPayload,
            @Nullable String intendedCapturePath)
            throws Exception {
        long start = System.currentTimeMillis();
        byte[] avif =
                PhotoExifMetadataWriter.encodeAvifForBle(
                        bitmap, quality, imuPayload, intendedCapturePath);
        return new EncodeResult(avif, BleCodec.AVIF, System.currentTimeMillis() - start);
    }
}
