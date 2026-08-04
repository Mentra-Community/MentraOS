package com.mentra.asg_client.camera.lifecycle;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.exifinterface.media.ExifInterface;
import androidx.heifwriter.AvifWriter;

import com.mentra.asg_client.io.media.core.BlePhotoTimingLog;
import com.radzivon.bartoshyk.avif.coder.HeifCoder;
import com.radzivon.bartoshyk.avif.coder.PreciseMode;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Locale;

/** Embeds IMU JSON in JPEG EXIF (UserComment) and preserves/copies metadata across re-encodes. */
public final class PhotoExifMetadataWriter {
    private static final String TAG = "PhotoExifMetadata";

    /** EXIF UserComment practical limit; full samples remain in gallery sidecar. */
    private static final int MAX_EXIF_SAMPLES = 400;

    private PhotoExifMetadataWriter() {}

    private static void logAvifEncodeTiming(long encodeStartMs, String path, int bytes) {
        long ms = System.currentTimeMillis() - encodeStartMs;
        String encoder =
                switch (path) {
                    case "avifwriter_exif" -> "Android AvifWriter with embedded EXIF";
                    case "heifcoder_bmff_exif" -> "HeifCoder AVIF + BMFF EXIF inject";
                    case "heifcoder_plain_fallback" -> "HeifCoder plain AVIF (EXIF inject failed)";
                    case "heifcoder_plain" -> "HeifCoder plain AVIF (no IMU metadata)";
                    default -> path;
                };
        BlePhotoTimingLog.event(
                "COMPRESS",
                "AVIF encoded via "
                        + encoder
                        + " in "
                        + ms
                        + "ms, output="
                        + String.format(Locale.US, "%.1f", bytes / 1024.0)
                        + "KB");
    }

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

    /**
     * Stamp the capture ID (the capture directory name, e.g. {@code IMG_..._<requestId>}) into EXIF
     * ImageUniqueID so the request correlation survives file renames and camera-roll export.
     * Derived from the file's own path, which covers every capture flow (SDK and button, gallery
     * and transient) without threading IDs through the camera layer. No-op for files that don't
     * live in a capture directory. Best-effort: a capture must never fail over metadata.
     */
    public static void writeCaptureIdFromPath(String jpegPath) {
        writeCaptureIdFromPath(jpegPath, jpegPath);
    }

    /** Writes capture correlation from an intended gallery path onto another JPEG. */
    public static void writeCaptureIdFromPath(String jpegPath, String intendedCapturePath) {
        try {
            File parent = new File(intendedCapturePath).getParentFile();
            String captureId = parent != null ? parent.getName() : null;
            if (captureId == null
                    || !(captureId.startsWith("IMG_") || captureId.startsWith("VID_"))) {
                return;
            }
            ExifInterface exif = new ExifInterface(jpegPath);
            exif.setAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID, captureId);
            exif.saveAttributes();
            Log.d(TAG, "Wrote ImageUniqueID EXIF to " + jpegPath + ": " + captureId);
        } catch (Exception e) {
            Log.w(TAG, "Failed to write ImageUniqueID EXIF on " + jpegPath, e);
        }
    }

    /** Copies capture metadata (IMU UserComment + ImageUniqueID) onto a re-encoded copy. */
    public static void copyImuMetadata(String sourcePath, String destPath) {
        try {
            String json = readImuJsonFromJpeg(sourcePath);
            String uniqueId =
                    new ExifInterface(sourcePath).getAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID);
            boolean hasJson = json != null && !json.isEmpty();
            boolean hasUniqueId = uniqueId != null && !uniqueId.isEmpty();
            if (!hasJson && !hasUniqueId) {
                return;
            }
            ExifInterface dest = new ExifInterface(destPath);
            if (hasJson) {
                dest.setAttribute(ExifInterface.TAG_USER_COMMENT, json);
            }
            if (hasUniqueId) {
                dest.setAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID, uniqueId);
            }
            dest.saveAttributes();
            Log.d(TAG, "Copied capture EXIF from " + sourcePath + " to " + destPath);
        } catch (IOException e) {
            Log.w(TAG, "Failed to copy capture EXIF metadata", e);
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
        byte[] segment = buildCaptureExifApp1Segment(imuPayload, null);
        if (segment == null) {
            throw new IOException("Could not build IMU EXIF segment");
        }
        return segment;
    }

    /**
     * Builds EXIF for a RAM-first capture from its in-memory IMU payload and intended gallery path.
     * The path need not exist; its capture-directory name supplies ImageUniqueID.
     */
    @Nullable
    public static byte[] buildCaptureExifApp1Segment(
            @Nullable JSONObject imuPayload, @Nullable String intendedCapturePath)
            throws IOException {
        String captureId = captureIdFromPath(intendedCapturePath);
        if (imuPayload == null && captureId == null) {
            return null;
        }
        File tempDir = new File(System.getProperty("java.io.tmpdir"));
        File tempJpeg = File.createTempFile("capture_exif_", ".jpg", tempDir);
        try {
            writeMinimalJpeg(tempJpeg);
            ExifInterface exif = new ExifInterface(tempJpeg.getAbsolutePath());
            if (imuPayload != null) {
                try {
                    exif.setAttribute(
                            ExifInterface.TAG_USER_COMMENT,
                            trimPayloadForExif(imuPayload).toString());
                } catch (JSONException e) {
                    throw new IOException("Invalid IMU payload JSON", e);
                }
            }
            if (captureId != null) {
                exif.setAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID, captureId);
            }
            exif.saveAttributes();
            return extractExifApp1Segment(tempJpeg);
        } finally {
            if (!tempJpeg.delete()) {
                tempJpeg.deleteOnExit();
            }
        }
    }

    @Nullable
    private static String captureIdFromPath(@Nullable String capturePath) {
        if (capturePath == null) {
            return null;
        }
        File parent = new File(capturePath).getParentFile();
        String captureId = parent != null ? parent.getName() : null;
        return captureId != null
                        && (captureId.startsWith("IMG_") || captureId.startsWith("VID_"))
                ? captureId
                : null;
    }

    /**
     * Builds an EXIF APP1 segment (including the {@code FFE1} marker and length) carrying the
     * source capture's IMU UserComment and/or ImageUniqueID, for splicing into an in-memory
     * re-encoded JPEG without round-tripping the full image through a temp file. Returns {@code
     * null} when the source carries neither attribute. The only disk I/O is the same 2x2-pixel
     * scratch JPEG {@link #buildExifApp1Segment} already uses, because {@link ExifInterface} can
     * only write to files.
     */
    @Nullable
    public static byte[] buildCaptureExifApp1Segment(String sourceJpegPath) throws IOException {
        String imuJson = readImuJsonFromJpeg(sourceJpegPath);
        String uniqueId =
                new ExifInterface(sourceJpegPath).getAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID);
        boolean hasJson = imuJson != null && !imuJson.isEmpty();
        boolean hasUniqueId = uniqueId != null && !uniqueId.isEmpty();
        if (!hasJson && !hasUniqueId) {
            return null;
        }

        File tempDir = new File(System.getProperty("java.io.tmpdir"));
        File tempJpeg = File.createTempFile("capture_exif_", ".jpg", tempDir);
        try {
            writeMinimalJpeg(tempJpeg);
            ExifInterface exif = new ExifInterface(tempJpeg.getAbsolutePath());
            if (hasJson) {
                exif.setAttribute(ExifInterface.TAG_USER_COMMENT, imuJson);
            }
            if (hasUniqueId) {
                exif.setAttribute(ExifInterface.TAG_IMAGE_UNIQUE_ID, uniqueId);
            }
            exif.saveAttributes();
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
        JSONObject payload = null;
        if (hasImuMetadata(sourceJpegPath)) {
            String json = readImuJsonFromJpeg(sourceJpegPath);
            if (json == null) {
                Log.w(
                        TAG,
                        "encodeAvifForBle: hasImuMetadata true but readImuJsonFromJpeg returned"
                                + " null");
            } else {
                try {
                    payload = new JSONObject(json);
                } catch (JSONException e) {
                    Log.w(TAG, "encodeAvifForBle: source IMU EXIF is not valid JSON", e);
                }
            }
        }
        Log.d(
                TAG,
                "encodeAvifForBle: source="
                        + sourceJpegPath
                        + " hasImuMetadata="
                        + (payload != null)
                        + " quality="
                        + quality);
        return encodeAvifForBle(bitmap, quality, payload, sourceJpegPath);
    }

    /**
     * In-memory variant: encodes AVIF with EXIF built from an already-assembled IMU payload,
     * avoiding any disk reads of the source capture.
     */
    public static byte[] encodeAvifForBle(
            Bitmap bitmap, int quality, @Nullable JSONObject imuPayload) throws Exception {
        return encodeAvifForBle(bitmap, quality, imuPayload, null);
    }

    /** RAM-first AVIF variant that also preserves capture-ID correlation from the intended path. */
    public static byte[] encodeAvifForBle(
            Bitmap bitmap,
            int quality,
            @Nullable JSONObject imuPayload,
            @Nullable String intendedCapturePath)
            throws Exception {
        long encodeStartMs = System.currentTimeMillis();
        HeifCoder heifCoder = new HeifCoder();
        byte[] captureExif = null;
        try {
            captureExif = buildCaptureExifApp1Segment(imuPayload, intendedCapturePath);
        } catch (Exception exifBuildError) {
            Log.w(
                    TAG,
                    "encodeAvifForBle: capture EXIF build failed, sending plain AVIF: "
                            + exifBuildError.getMessage());
        }
        if (captureExif != null) {
            try {
                byte[] exifTiff = Arrays.copyOfRange(captureExif, 4, captureExif.length);

                if (isAv1EncoderAvailable()) {
                    try {
                        byte[] withExif = encodeAvifWithExif(bitmap, quality, captureExif);
                        logAvifEncodeTiming(encodeStartMs, "avifwriter_exif", withExif.length);
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
                try {
                    byte[] withExif = AvifBmffExifInjector.injectExif(avif, exifTiff);
                    logAvifEncodeTiming(encodeStartMs, "heifcoder_bmff_exif", withExif.length);
                    Log.d(
                            TAG,
                            "encodeAvifForBle: HeifCoder+EXIF, "
                                    + withExif.length
                                    + " bytes, rawHasExifMarker="
                                    + containsExifMarker(withExif));
                    return withExif;
                } catch (Exception injectError) {
                    Log.w(
                            TAG,
                            "BMFF EXIF inject failed, sending plain AVIF: "
                                    + injectError.getMessage());
                    logAvifEncodeTiming(encodeStartMs, "heifcoder_plain_fallback", avif.length);
                    return avif;
                }
            } catch (Exception exifPathError) {
                Log.w(
                        TAG,
                        "encodeAvifForBle: capture EXIF path failed, sending plain AVIF: "
                                + exifPathError.getMessage());
            }
        }
        byte[] plain = heifCoder.encodeAvif(bitmap, quality, PreciseMode.LOSSY);
        logAvifEncodeTiming(encodeStartMs, "heifcoder_plain", plain.length);
        Log.d(
                TAG,
                "encodeAvifForBle: HeifCoder (no capture EXIF), "
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
        return encodeAvifWithExif(bitmap, quality, buildExifApp1Segment(imuPayload));
    }

    private static byte[] encodeAvifWithExif(Bitmap bitmap, int quality, byte[] exifSegment)
            throws Exception {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
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
            try {
                writer.close();
            } catch (Exception e) {
                Log.w(TAG, "AvifWriter close failed: " + e.getMessage());
            }
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
