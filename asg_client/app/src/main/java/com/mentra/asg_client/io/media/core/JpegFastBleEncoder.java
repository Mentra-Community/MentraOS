package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.asg_client.camera.lifecycle.PhotoExifMetadataWriter;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * Low-latency BLE payload encoder: baseline JPEG via {@link Bitmap#compress} (Skia's bundled
 * libjpeg-turbo with NEON). The whole encode happens in memory - no temp files, no read-back -
 * unlike the previous flow that compressed to disk, rewrote EXIF in place, and read the bytes back.
 * Capture EXIF (IMU UserComment / ImageUniqueID) is carried over by splicing a pre-built APP1
 * segment into the encoded stream right after SOI; a metadata failure never fails the encode.
 */
final class JpegFastBleEncoder implements BlePhotoEncoder {
    private static final String TAG = "JpegFastBleEncoder";

    /** JPEG streams open with the two-byte SOI marker; the EXIF APP1 segment goes right after. */
    private static final int SOI_LENGTH = 2;

    @Override
    public BleCodec codec() {
        return BleCodec.JPEG_FAST;
    }

    @Override
    public EncodeResult encode(Bitmap bitmap, int quality, String sourceJpegPath)
            throws IOException {
        return encodeInternal(bitmap, quality, sourceJpegPath, null, null);
    }

    EncodeResult encode(
            Bitmap bitmap,
            int quality,
            @Nullable JSONObject imuPayload,
            @Nullable String intendedCapturePath)
            throws IOException {
        return encodeInternal(bitmap, quality, null, imuPayload, intendedCapturePath);
    }

    private EncodeResult encodeInternal(
            Bitmap bitmap,
            int quality,
            @Nullable String sourceJpegPath,
            @Nullable JSONObject imuPayload,
            @Nullable String intendedCapturePath)
            throws IOException {
        long start = System.currentTimeMillis();
        // Bitmap.compress caps its own output; 1/4 byte per pixel comfortably covers q75-q95
        // text crops and avoids ByteArrayOutputStream regrowing mid-encode.
        ByteArrayOutputStream baos =
                new ByteArrayOutputStream(bitmap.getWidth() * bitmap.getHeight() / 4 + 1024);
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, baos)) {
            throw new IOException("Bitmap JPEG compress failed");
        }
        byte[] jpeg =
                spliceCaptureExif(
                        baos.toByteArray(), sourceJpegPath, imuPayload, intendedCapturePath);
        long encodeMs = System.currentTimeMillis() - start;
        Log.d(
                TAG,
                "JPEG_FAST encode: "
                        + bitmap.getWidth()
                        + "x"
                        + bitmap.getHeight()
                        + " q"
                        + quality
                        + " -> "
                        + jpeg.length
                        + " bytes in "
                        + encodeMs
                        + "ms");
        return new EncodeResult(jpeg, BleCodec.JPEG_FAST, encodeMs);
    }

    /**
     * Inserts the source capture's EXIF APP1 segment (IMU samples + capture ID) after the SOI
     * marker. Best-effort: returns the plain JPEG if the source has no metadata or the splice fails
     * - the payload must never be lost over metadata.
     */
    private static byte[] spliceCaptureExif(
            byte[] jpeg,
            @Nullable String sourceJpegPath,
            @Nullable JSONObject imuPayload,
            @Nullable String intendedCapturePath) {
        if (sourceJpegPath == null && imuPayload == null && intendedCapturePath == null) {
            return jpeg;
        }
        try {
            byte[] app1 =
                    sourceJpegPath != null
                            ? PhotoExifMetadataWriter.buildCaptureExifApp1Segment(sourceJpegPath)
                            : PhotoExifMetadataWriter.buildCaptureExifApp1Segment(
                                    imuPayload, intendedCapturePath);
            if (app1 == null
                    || jpeg.length < SOI_LENGTH
                    || (jpeg[0] & 0xFF) != 0xFF
                    || (jpeg[1] & 0xFF) != 0xD8) {
                return jpeg;
            }
            byte[] withExif = new byte[jpeg.length + app1.length];
            System.arraycopy(jpeg, 0, withExif, 0, SOI_LENGTH);
            System.arraycopy(app1, 0, withExif, SOI_LENGTH, app1.length);
            System.arraycopy(
                    jpeg, SOI_LENGTH, withExif, SOI_LENGTH + app1.length, jpeg.length - SOI_LENGTH);
            return withExif;
        } catch (Exception e) {
            Log.w(TAG, "Capture EXIF splice failed, sending JPEG without metadata", e);
            return jpeg;
        }
    }
}
