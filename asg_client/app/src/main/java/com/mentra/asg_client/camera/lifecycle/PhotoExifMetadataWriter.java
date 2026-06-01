package com.mentra.asg_client.camera.lifecycle;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.exifinterface.media.ExifInterface;
import androidx.heifwriter.AvifWriter;
import com.radzivon.bartoshyk.avif.coder.HeifCoder;
import com.radzivon.bartoshyk.avif.coder.PreciseMode;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Embeds IMU JSON in JPEG EXIF (UserComment) and preserves/copies metadata across re-encodes. */
public final class PhotoExifMetadataWriter {
    private static final String TAG = "PhotoExifMetadata";

    /** EXIF UserComment practical limit; full samples remain in gallery sidecar. */
    private static final int MAX_EXIF_SAMPLES = 400;

    private PhotoExifMetadataWriter() {}

    public static void writeImuPayload(String jpegPath, JSONObject imuPayload) throws IOException {
        try {
            JSONObject forExif = trimPayloadForExif(imuPayload);
            String json = forExif.toString();
            ExifInterface exif = new ExifInterface(jpegPath);
            exif.setAttribute(ExifInterface.TAG_USER_COMMENT, json);
            exif.saveAttributes();
            Log.d(TAG, "Wrote IMU EXIF to " + jpegPath + " (" + json.length() + " chars)");
        } catch (JSONException e) {
            throw new IOException("Invalid IMU payload JSON", e);
        }
    }

    public static void copyImuMetadata(String sourcePath, String destPath) {
        try {
            String json = readImuJsonFromJpeg(sourcePath);
            if (json == null || json.isEmpty()) {
                return;
            }
            ExifInterface dest = new ExifInterface(destPath);
            dest.setAttribute(ExifInterface.TAG_USER_COMMENT, json);
            dest.saveAttributes();
            Log.d(TAG, "Copied IMU EXIF from " + sourcePath + " to " + destPath);
        } catch (IOException e) {
            Log.w(TAG, "Failed to copy IMU EXIF metadata", e);
        }
    }

    public static boolean hasImuMetadata(String jpegPath) {
        try {
            String json = readImuJsonFromJpeg(jpegPath);
            return json != null && !json.isEmpty();
        } catch (IOException e) {
            return false;
        }
    }

    @Nullable
    public static String readImuJsonFromJpeg(String jpegPath) throws IOException {
        ExifInterface exif = new ExifInterface(jpegPath);
        String userComment = exif.getAttribute(ExifInterface.TAG_USER_COMMENT);
        if (userComment != null && !userComment.isEmpty()) {
            return userComment;
        }
        return exif.getAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION);
    }

    /**
     * Builds a standalone EXIF APP1 segment (including marker and length) for
     * AvifWriter.addExifData.
     */
    public static byte[] buildExifApp1Segment(JSONObject imuPayload) throws IOException {
        File tempDir = new File(System.getProperty("java.io.tmpdir"));
        File tempJpeg = File.createTempFile("imu_exif_", ".jpg", tempDir);
        try {
            writeMinimalJpeg(tempJpeg);
            writeImuPayload(tempJpeg.getAbsolutePath(), imuPayload);
            return extractExifApp1Segment(tempJpeg);
        } finally {
            if (!tempJpeg.delete()) {
                tempJpeg.deleteOnExit();
            }
        }
    }

    /**
     * Encode bitmap as AVIF with embedded EXIF when source JPEG has IMU metadata; otherwise use
     * HeifCoder.
     */
    public static byte[] encodeAvifForBle(Bitmap bitmap, int quality, String sourceJpegPath)
            throws Exception {
        boolean hasImu = hasImuMetadata(sourceJpegPath);
        Log.d(
                TAG,
                "encodeAvifForBle: source="
                        + sourceJpegPath
                        + " hasImuMetadata="
                        + hasImu
                        + " quality="
                        + quality);
        HeifCoder heifCoder = new HeifCoder();
        if (hasImu) {
            String json = readImuJsonFromJpeg(sourceJpegPath);
            if (json == null) {
                Log.w(
                        TAG,
                        "encodeAvifForBle: hasImuMetadata true but readImuJsonFromJpeg returned null");
            } else {
                JSONObject payload = new JSONObject(json);
                byte[] exifSegment = buildExifApp1Segment(payload);
                byte[] exifTiff = Arrays.copyOfRange(exifSegment, 4, exifSegment.length);

                if (isAv1EncoderAvailable()) {
                    try {
                        byte[] withExif = encodeAvifWithExif(bitmap, quality, payload);
                        Log.d(
                                TAG,
                                "encodeAvifForBle: AvifWriter+EXIF, "
                                        + withExif.length
                                        + " bytes, rawHasExifMarker="
                                        + containsExifMarker(withExif));
                        return withExif;
                    } catch (Exception e) {
                        Log.w(
                                TAG,
                                "AvifWriter+EXIF failed, using HeifCoder+BMFF EXIF inject: "
                                        + e.getMessage());
                    }
                } else {
                    Log.d(
                            TAG,
                            "encodeAvifForBle: no AV1 encoder; using HeifCoder+BMFF EXIF inject");
                }

                byte[] avif = heifCoder.encodeAvif(bitmap, quality, PreciseMode.LOSSY);
                byte[] withExif = AvifBmffExifInjector.injectExif(avif, exifTiff);
                Log.d(
                        TAG,
                        "encodeAvifForBle: HeifCoder+EXIF, "
                                + withExif.length
                                + " bytes, rawHasExifMarker="
                                + containsExifMarker(withExif));
                return withExif;
            }
        }
        byte[] plain = heifCoder.encodeAvif(bitmap, quality, PreciseMode.LOSSY);
        Log.d(
                TAG,
                "encodeAvifForBle: HeifCoder (no IMU), "
                        + plain.length
                        + " bytes, rawHasExifMarker="
                        + containsExifMarker(plain));
        return plain;
    }

    /** True when the device exposes an AV1 encoder for {@link AvifWriter}. */
    static boolean isAv1EncoderAvailable() {
        MediaCodecList list = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
        for (MediaCodecInfo info : list.getCodecInfos()) {
            if (!info.isEncoder()) {
                continue;
            }
            try {
                MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType("video/av01");
                if (caps.getVideoCapabilities().isSizeSupported(512, 512)) {
                    return true;
                }
            } catch (IllegalArgumentException ignored) {
            }
        }
        return false;
    }

    static boolean containsExifMarker(byte[] data) {
        byte[] marker = new byte[] {'E', 'x', 'i', 'f', 0, 0};
        outer:
        for (int i = 0; i <= data.length - marker.length; i++) {
            for (int j = 0; j < marker.length; j++) {
                if (data[i + j] != marker[j]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    public static byte[] encodeAvifWithExif(Bitmap bitmap, int quality, JSONObject imuPayload)
            throws Exception {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        byte[] exifSegment = buildExifApp1Segment(imuPayload);
        byte[] exifPayload = Arrays.copyOfRange(exifSegment, 4, exifSegment.length);

        File tempFile = File.createTempFile("ble_avif_", ".avif");
        AvifWriter writer =
                new AvifWriter.Builder(
                                tempFile.getAbsolutePath(),
                                width,
                                height,
                                AvifWriter.INPUT_MODE_BITMAP)
                        .setQuality(quality)
                        .setMaxImages(1)
                        .setGridEnabled(false)
                        .build();
        try {
            writer.start();
            writer.addBitmap(bitmap);
            writer.addExifData(0, exifPayload, 0, exifPayload.length);
            writer.stop(10_000L);
            byte[] data = java.nio.file.Files.readAllBytes(tempFile.toPath());
            Log.d(TAG, "Encoded AVIF with EXIF: " + data.length + " bytes");
            return data;
        } finally {
            if (!tempFile.delete()) {
                tempFile.deleteOnExit();
            }
        }
    }

    static JSONObject trimPayloadForExif(JSONObject source) throws JSONException {
        JSONObject copy = new JSONObject(source.toString());
        JSONArray samples = copy.optJSONArray("samples");
        if (samples == null || samples.length() <= MAX_EXIF_SAMPLES) {
            return copy;
        }
        JSONArray trimmed = new JSONArray();
        for (int i = 0; i < MAX_EXIF_SAMPLES; i++) {
            trimmed.put(samples.get(i));
        }
        copy.put("samples", trimmed);
        copy.put("sampleCount", trimmed.length());
        copy.put("exifTruncated", true);
        return copy;
    }

    /** Visible for unit tests. */
    static void writeMinimalJpegForTest(File dest) throws IOException {
        writeMinimalJpeg(dest);
    }

    private static void writeMinimalJpeg(File dest) throws IOException {
        Bitmap bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.BLACK);
        try (FileOutputStream fos = new FileOutputStream(dest)) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, fos);
        } finally {
            bitmap.recycle();
        }
    }

    static byte[] extractExifApp1Segment(File jpegFile) throws IOException {
        byte[] data = java.nio.file.Files.readAllBytes(jpegFile.toPath());
        for (int i = 0; i < data.length - 10; i++) {
            if ((data[i] & 0xFF) != 0xFF) {
                continue;
            }
            int marker = data[i + 1] & 0xFF;
            if (marker != 0xE1) {
                continue;
            }
            int segmentLength = ((data[i + 2] & 0xFF) << 8) | (data[i + 3] & 0xFF);
            int total = 2 + segmentLength;
            if (i + total > data.length) {
                continue;
            }
            if (segmentLength >= 8
                    && data[i + 4] == 'E'
                    && data[i + 5] == 'x'
                    && data[i + 6] == 'i'
                    && data[i + 7] == 'f') {
                return Arrays.copyOfRange(data, i, i + total);
            }
        }
        throw new IOException("No EXIF APP1 segment in JPEG");
    }
}
