package com.mentra.bluetoothsdk.utils;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.VisibleForTesting;
import androidx.exifinterface.media.ExifInterface;

import com.mentra.bluetoothsdk.debug.BleTraceLogger;
import com.mentra.bluetoothsdk.photoreceiver.LocalPhotoReceiverRegistry;
import com.radzivon.bartoshyk.avif.coder.HeifCoder;
import com.radzivon.bartoshyk.avif.coder.PreferredColorConfig;

import org.json.JSONArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * Service to handle BLE photo uploads including AVIF decoding and webhook posting.
 * Preserves IMU metadata embedded in EXIF UserComment when re-encoding to JPEG.
 */
public class BlePhotoUploadService {
    private static final String TAG = "BlePhotoUploadService";
    // AVIF sources already went through a lossy pass on the glasses; re-encode at
    // high-but-not-max quality to avoid inflating upload size. JPEG fast-path
    // payloads from text mode are uploaded as-is.
    private static final int AVIF_TO_JPEG_QUALITY = 90;

    public interface UploadCallback {
        void onSuccess(String requestId, String responseBody);
        void onError(String requestId, String error);
    }

    /**
     * Process image data and upload to webhook
     * @param imageData Raw image data (AVIF or JPEG)
     * @param requestId Original request ID for tracking
     * @param webhookUrl Destination webhook URL
     * @param authToken Optional authentication token for upload
     * @param callback Callback for success/error
     */
    public static void processAndUploadPhoto(byte[] imageData, String requestId,
                                            String webhookUrl, @Nullable String authToken,
                                            UploadCallback callback) {
        new Thread(() -> {
            try {
                Log.d(TAG, "Processing BLE photo for upload. Image size: " + imageData.length + " bytes");

                byte[] jpegData = convertToJpegPreservingExif(imageData);
                Log.d(TAG, "Converted to JPEG for upload. Size: " + jpegData.length + " bytes");

                // 3. Upload to webhook
                String responseBody =
                        uploadToWebhook(jpegData, imageData.length, requestId, webhookUrl, authToken);

                Log.d(TAG, "Photo uploaded successfully for requestId: " + requestId);
                callback.onSuccess(requestId, responseBody);

            } catch (Exception e) {
                Log.e(TAG, "Error processing BLE photo for requestId: " + requestId, e);
                callback.onError(requestId, e.getMessage());
            }
        }).start();
    }

    /**
     * Decode incoming AVIF/JPEG, re-encode as JPEG, and re-attach IMU EXIF when present.
     */
    @VisibleForTesting
    static byte[] convertToJpegPreservingExif(byte[] imageData) throws Exception {
        long conversionStartMs = System.currentTimeMillis();
        if (isJpeg(imageData)) {
            Log.d(
                    TAG,
                    "BLE relay pass-through: input already JPEG ("
                            + imageData.length
                            + " bytes), skipping decode/re-encode in "
                            + (System.currentTimeMillis() - conversionStartMs)
                            + "ms");
            return imageData;
        }

        File inputFile = File.createTempFile("ble_photo_in_", guessExtension(imageData));
        File outputFile = File.createTempFile("ble_photo_out_", ".jpg");
        try {
            try (FileOutputStream fos = new FileOutputStream(inputFile)) {
                fos.write(imageData);
            }

            logIncomingImageDiagnostics(imageData, inputFile.getAbsolutePath());

            String imuJson = readImuJsonFromBleImage(imageData, inputFile.getAbsolutePath());

            long decodeStartMs = System.currentTimeMillis();
            Bitmap bitmap = decodeImage(imageData);
            long decodeDurationMs = System.currentTimeMillis() - decodeStartMs;
            if (bitmap == null) {
                throw new Exception("Failed to decode image data");
            }

            Log.d(
                    TAG,
                    "AVIF decode complete: "
                            + bitmap.getWidth()
                            + "x"
                            + bitmap.getHeight()
                            + " in "
                            + decodeDurationMs
                            + "ms");

            long encodeStartMs = System.currentTimeMillis();
            try (FileOutputStream fos = new FileOutputStream(outputFile)) {
                bitmap.compress(Bitmap.CompressFormat.JPEG, AVIF_TO_JPEG_QUALITY, fos);
            } finally {
                bitmap.recycle();
            }
            long encodeDurationMs = System.currentTimeMillis() - encodeStartMs;
            Log.d(
                    TAG,
                    "AVIF->JPEG encode complete: quality="
                            + AVIF_TO_JPEG_QUALITY
                            + " in "
                            + encodeDurationMs
                            + "ms");

            long metadataStartMs = System.currentTimeMillis();
            if (imuJson != null && !imuJson.isEmpty()) {
                logImuData(imuJson);
                // IMU EXIF is enrichment, not the payload: a write failure must not drop the
                // already-decoded photo. Log and upload the plain JPEG instead.
                try {
                    writeImuJsonToJpeg(outputFile.getAbsolutePath(), imuJson);
                    Log.d(TAG, "Re-attached IMU EXIF UserComment on output JPEG (" + imuJson.length() + " chars)");
                } catch (Exception e) {
                    Log.w(TAG, "Failed to attach IMU EXIF; uploading photo without it", e);
                }
            } else {
                boolean rawHasExif = containsExifMarkerInBytes(imageData);
                Log.w(
                        TAG,
                        "No IMU from ExifInterface on "
                                + inputFile.getName()
                                + " (container="
                                + describeContainer(imageData)
                                + ", rawHasExifMarker="
                                + rawHasExif
                                + "). If rawHasExifMarker=true, EXIF may be present but unreadable via"
                                + " ExifInterface on this container.");
            }
            Log.d(
                    TAG,
                    "AVIF metadata handling complete in "
                            + (System.currentTimeMillis() - metadataStartMs)
                            + "ms");

            byte[] jpegData = java.nio.file.Files.readAllBytes(outputFile.toPath());
            Log.d(
                    TAG,
                    "Phone image conversion complete: AVIF "
                            + imageData.length
                            + " bytes -> JPEG "
                            + jpegData.length
                            + " bytes in "
                            + (System.currentTimeMillis() - conversionStartMs)
                            + "ms (decode="
                            + decodeDurationMs
                            + "ms, encode="
                            + encodeDurationMs
                            + "ms)");
            return jpegData;
        } finally {
            if (!inputFile.delete()) {
                inputFile.deleteOnExit();
            }
            if (!outputFile.delete()) {
                outputFile.deleteOnExit();
            }
        }
    }

    @Nullable
    @VisibleForTesting
    static String readImuJsonFromBleImage(byte[] imageData, String imagePath) {
        String fromExif = readImuJsonFromImageFile(imagePath);
        if (fromExif != null && !fromExif.isEmpty()) {
            return fromExif;
        }
        if (containsExifMarkerInBytes(imageData)) {
            String fromTiff = HeifExifTagReader.readImuJson(imageData);
            if (fromTiff != null && !fromTiff.isEmpty()) {
                Log.d(
                        TAG,
                        "Read IMU UserComment via TIFF scan ("
                                + fromTiff.length()
                                + " chars), container="
                                + describeContainer(imageData));
                return fromTiff;
            }
        }
        return null;
    }

    @Nullable
    @VisibleForTesting
    static String readImuJsonFromImageFile(String imagePath) {
        try {
            ExifInterface exif = new ExifInterface(imagePath);
            String userComment = exif.getAttribute(ExifInterface.TAG_USER_COMMENT);
            String imageDescription = exif.getAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION);
            Log.d(
                    TAG,
                    "ExifInterface on "
                            + imagePath
                            + ": UserComment="
                            + describeExifAttribute(userComment)
                            + ", ImageDescription="
                            + describeExifAttribute(imageDescription));
            if (userComment != null && !userComment.isEmpty()) {
                return userComment;
            }
            return imageDescription;
        } catch (IOException e) {
            Log.w(TAG, "Could not read EXIF from BLE image: " + imagePath, e);
            return null;
        }
    }

    private static void logIncomingImageDiagnostics(byte[] imageData, String tempPath) {
        Log.d(
                TAG,
                "BLE image diagnostics: size="
                        + imageData.length
                        + " bytes, container="
                        + describeContainer(imageData)
                        + ", tempFile="
                        + tempPath
                        + ", rawHasExifMarker="
                        + containsExifMarkerInBytes(imageData));
    }

    /** ISO BMFF major brand or JPEG; used to correlate with ExifInterface behavior on AVIF. */
    @VisibleForTesting
    static String describeContainer(byte[] data) {
        if (data.length >= 2 && (data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8) {
            return "jpeg";
        }
        if (data.length >= 12
                && data[4] == 'f'
                && data[5] == 't'
                && data[6] == 'y'
                && data[7] == 'p') {
            String brand = new String(data, 8, 4, StandardCharsets.US_ASCII);
            return "iso_bmff/ftyp=" + brand;
        }
        return "unknown";
    }

    /** Scans file bytes for the TIFF EXIF header (does not parse tags). */
    @VisibleForTesting
    static boolean containsExifMarkerInBytes(byte[] data) {
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

    private static String describeExifAttribute(@Nullable String value) {
        if (value == null) {
            return "null";
        }
        if (value.isEmpty()) {
            return "empty";
        }
        String preview = value.length() > 80 ? value.substring(0, 80) + "…" : value;
        return "len=" + value.length() + " preview=\"" + preview + "\"";
    }

    @VisibleForTesting
    static void writeImuJsonToJpeg(String jpegPath, String imuJson) throws IOException {
        ExifInterface exif = new ExifInterface(jpegPath);
        exif.setAttribute(ExifInterface.TAG_USER_COMMENT, imuJson);
        exif.saveAttributes();
    }

    private static boolean isJpeg(byte[] imageData) {
        return imageData.length >= 2
                && (imageData[0] & 0xFF) == 0xFF
                && (imageData[1] & 0xFF) == 0xD8;
    }

    private static String guessExtension(byte[] imageData) {
        if (imageData.length > 12
                && imageData[4] == 'f'
                && imageData[5] == 't'
                && imageData[6] == 'y'
                && imageData[7] == 'p') {
            return ".avif";
        }
        return ".jpg";
    }

    /**
     * Decode image data (AVIF or JPEG) to Bitmap
     * @param imageData Raw image bytes
     * @return Decoded bitmap or null if failed
     */
    private static Bitmap decodeImage(byte[] imageData) {
        try {
            boolean isAvif = imageData.length > 12
                           && imageData[4] == 'f' && imageData[5] == 't'
                           && imageData[6] == 'y' && imageData[7] == 'p'
                           && imageData[8] == 'a' && imageData[9] == 'v'
                           && imageData[10] == 'i' && imageData[11] == 'f';

            if (isAvif) {
                Log.d(TAG, "Detected AVIF image format");
                byte[] strippedBytes = imageData;
                if (containsExifMarkerInBytes(imageData)) {
                    try {
                        strippedBytes = AvifExifStripper.stripForDecode(imageData);
                        Log.d(
                                TAG,
                                "Stripped Exif metadata item for decode: "
                                        + imageData.length
                                        + " -> "
                                        + strippedBytes.length
                                        + " bytes");
                    } catch (Exception e) {
                        Log.w(TAG, "stripForDecode failed, using raw AVIF: " + e.getMessage());
                        strippedBytes = imageData;
                    }
                }
                Bitmap bmp = decodeAvifBytes(strippedBytes);
                if (bmp == null && strippedBytes != imageData) {
                    Log.w(TAG, "Stripped AVIF decode failed; retrying original BLE bytes");
                    bmp = decodeAvifBytes(imageData);
                }
                return bmp;
            }
            Log.d(TAG, "Detected JPEG image format");
            return BitmapFactory.decodeByteArray(imageData, 0, imageData.length);
        } catch (Exception e) {
            Log.e(TAG, "Failed to decode image", e);
            return null;
        }
    }

    @Nullable
    private static Bitmap decodeAvifBytes(byte[] avifBytes) {
        try {
            Bitmap bmp = new HeifCoder().decode(avifBytes, PreferredColorConfig.RGBA_8888);
            if (bmp != null) {
                return bmp;
            }
        } catch (Exception | LinkageError e) {
            Log.w(TAG, "HeifCoder AVIF decode unavailable/failed, trying BitmapFactory: " + e.getMessage());
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return BitmapFactory.decodeByteArray(avifBytes, 0, avifBytes.length);
        }
        Log.e(TAG, "AVIF decoding requires Android 12+ (API 31+). Current API: " + Build.VERSION.SDK_INT);
        return null;
    }

    /**
     * Upload JPEG data to webhook
     */
    private static void logImuData(String imuJson) {
        try {
            JSONObject root = new JSONObject(imuJson);
            int sampleCount = root.optInt("sampleCount", 0);
            double samplingRateHz = root.optDouble("samplingRateHz", 0);
            long durationMs = root.optLong("durationMs", 0);
            long startTimeNs = root.optLong("startTimeNs", 0);
            JSONArray samples = root.optJSONArray("samples");

            StringBuilder sb = new StringBuilder();
            sb.append("IMU data received: sampleCount=").append(sampleCount)
                    .append(" rate=").append(samplingRateHz).append("Hz")
                    .append(" duration=").append(durationMs).append("ms")
                    .append(" startNs=").append(startTimeNs);
            Log.d(TAG, sb.toString());

            if (samples != null && samples.length() > 0) {
                // Log first and last sample: [timestampMs, ax, ay, az, gx, gy, gz]
                logSample("first", samples.optJSONArray(0));
                if (samples.length() > 1) {
                    logSample("last", samples.optJSONArray(samples.length() - 1));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "logImuData: failed to parse IMU JSON: " + e.getMessage());
        }
    }

    private static void logSample(String label, @Nullable JSONArray sample) {
        if (sample == null || sample.length() < 7) return;
        try {
            Log.d(
                    TAG,
                    "IMU " + label + " sample:"
                            + " t=" + sample.optLong(0) + "ms"
                            + " accel=[" + String.format("%.3f", sample.optDouble(1))
                            + ", " + String.format("%.3f", sample.optDouble(2))
                            + ", " + String.format("%.3f", sample.optDouble(3)) + "]m/s²"
                            + " gyro=[" + String.format("%.3f", sample.optDouble(4))
                            + ", " + String.format("%.3f", sample.optDouble(5))
                            + ", " + String.format("%.3f", sample.optDouble(6)) + "]rad/s");
        } catch (Exception e) {
            Log.w(TAG, "logSample: " + e.getMessage());
        }
    }

    private static String uploadToWebhook(byte[] jpegData, String requestId,
                                       String webhookUrl, @Nullable String authToken) throws IOException {
        return uploadToWebhook(jpegData, -1, requestId, webhookUrl, authToken);
    }

    private static String uploadToWebhook(byte[] jpegData, int sourceImageBytes, String requestId,
                                       String webhookUrl, @Nullable String authToken) throws IOException {
        String effectiveWebhookUrl = resolvePhoneRelayWebhookUrl(webhookUrl);
        OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build();

        RequestBody requestBody = new MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("requestId", requestId)
            .addFormDataPart("source", "ble_transfer")
            .addFormDataPart("photo", requestId + ".jpg",
                RequestBody.create(MediaType.parse("image/jpeg"), jpegData))
            .build();

        Request.Builder requestBuilder = new Request.Builder()
            .url(effectiveWebhookUrl)
            .post(requestBody);

        if (authToken != null && !authToken.isEmpty()) {
            requestBuilder.addHeader("Authorization", "Bearer " + authToken);
        }

        Request request = requestBuilder.build();

        if (!effectiveWebhookUrl.equals(webhookUrl)) {
            Log.d(TAG, "Uploading BLE fallback photo to local receiver via loopback: " + effectiveWebhookUrl);
        } else {
            Log.d(TAG, "Uploading photo to webhook: " + webhookUrl);
        }
        long startMs = System.currentTimeMillis();
        traceRelayUploadStart(requestId, effectiveWebhookUrl, webhookUrl, authToken, sourceImageBytes, jpegData.length, startMs);

        boolean responseTraced = false;
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                String errorBody = response.body() != null ? response.body().string() : "No response body";
                traceRelayUploadEnd(
                    requestId,
                    effectiveWebhookUrl,
                    webhookUrl,
                    sourceImageBytes,
                    jpegData.length,
                    startMs,
                    response.code(),
                    false,
                    "http_error");
                responseTraced = true;
                throw new IOException("Upload failed with code " + response.code() + ": " + errorBody);
            }

            String responseBody = response.body() != null ? response.body().string() : "";
            traceRelayUploadEnd(
                requestId,
                effectiveWebhookUrl,
                webhookUrl,
                sourceImageBytes,
                jpegData.length,
                startMs,
                response.code(),
                true,
                "uploaded");
            responseTraced = true;
            Log.d(TAG, "Upload successful. Response code: " + response.code());
            return responseBody;
        } catch (IOException e) {
            if (!responseTraced) {
                traceRelayUploadError(
                    requestId,
                    effectiveWebhookUrl,
                    webhookUrl,
                    sourceImageBytes,
                    jpegData.length,
                    startMs,
                    e,
                    "failed");
            }
            throw e;
        }
    }

    private static String resolvePhoneRelayWebhookUrl(String webhookUrl) {
        String loopbackUrl = LocalPhotoReceiverRegistry.loopbackUploadUrlFor(webhookUrl);
        return loopbackUrl != null ? loopbackUrl : webhookUrl;
    }

    private static void traceRelayUploadStart(String requestId, String webhookUrl,
                                             String originalWebhookUrl,
                                             @Nullable String authToken, int sourceImageBytes,
                                             int jpegBytes, long startMs) {
        JSONObject payload = createRelayUploadPayload(
            "photo_relay_upload_start",
            requestId,
            webhookUrl,
            sourceImageBytes,
            jpegBytes,
            startMs);
        putRelayRewrite(payload, webhookUrl, originalWebhookUrl);
        putJson(payload, "bearerHeaderPresent", authToken != null && !authToken.isEmpty());
        safeTraceJson("phone_to_wifi", "wifi_http_output", payload);
    }

    private static void traceRelayUploadEnd(String requestId, String webhookUrl,
                                           String originalWebhookUrl,
                                           int sourceImageBytes, int jpegBytes, long startMs,
                                           int statusCode, boolean success, String outcome) {
        JSONObject payload = createRelayUploadPayload(
            "photo_relay_upload_end",
            requestId,
            webhookUrl,
            sourceImageBytes,
            jpegBytes,
            startMs);
        putRelayRewrite(payload, webhookUrl, originalWebhookUrl);
        long endMs = System.currentTimeMillis();
        putJson(payload, "endMs", endMs);
        putJson(payload, "durationMs", endMs - startMs);
        putJson(payload, "statusCode", statusCode);
        putJson(payload, "success", success);
        putJson(payload, "outcome", outcome);
        safeTraceJson("wifi_to_phone", "wifi_http_input", payload);
    }

    private static void traceRelayUploadError(String requestId, String webhookUrl,
                                             String originalWebhookUrl,
                                             int sourceImageBytes, int jpegBytes, long startMs,
                                             Exception error, String outcome) {
        JSONObject payload = createRelayUploadPayload(
            "photo_relay_upload_error",
            requestId,
            webhookUrl,
            sourceImageBytes,
            jpegBytes,
            startMs);
        putRelayRewrite(payload, webhookUrl, originalWebhookUrl);
        long endMs = System.currentTimeMillis();
        putJson(payload, "endMs", endMs);
        putJson(payload, "durationMs", endMs - startMs);
        putJson(payload, "success", false);
        putJson(payload, "outcome", outcome);
        putJson(payload, "errorClass", error.getClass().getSimpleName());
        putJson(payload, "errorMessage", error.getMessage());
        safeTraceJson("wifi_to_phone", "wifi_http_input", payload);
    }

    private static JSONObject createRelayUploadPayload(String type, String requestId,
                                                      String webhookUrl, int sourceImageBytes,
                                                      int jpegBytes, long startMs) {
        JSONObject payload = new JSONObject();
        putJson(payload, "type", type);
        putJson(payload, "requestId", requestId);
        putJson(payload, "source", "ble_fallback");
        if (sourceImageBytes >= 0) {
            putJson(payload, "imageBytes", sourceImageBytes);
        }
        putJson(payload, "jpegBytes", jpegBytes);
        putJson(payload, "startMs", startMs);
        putWebhookSummary(payload, webhookUrl);
        return payload;
    }

    private static void putRelayRewrite(JSONObject payload, String webhookUrl, String originalWebhookUrl) {
        if (webhookUrl == null || originalWebhookUrl == null || webhookUrl.equals(originalWebhookUrl)) {
            return;
        }

        putJson(payload, "relayRewrite", "loopback");
        try {
            URI original = URI.create(originalWebhookUrl);
            putJson(payload, "originalUrlHost", original.getHost());
            if (original.getPort() != -1) {
                putJson(payload, "originalUrlPort", original.getPort());
            }
        } catch (Exception e) {
            putJson(payload, "originalUrlParseError", e.getClass().getSimpleName());
        }
    }

    private static void putWebhookSummary(JSONObject payload, String webhookUrl) {
        if (webhookUrl == null || webhookUrl.isEmpty()) {
            return;
        }

        try {
            URI uri = URI.create(webhookUrl);
            putJson(payload, "urlScheme", uri.getScheme());
            putJson(payload, "urlHost", uri.getHost());
            if (uri.getPort() != -1) {
                putJson(payload, "urlPort", uri.getPort());
            }
            String path = uri.getRawPath();
            putJson(payload, "urlHasPath", path != null && !path.isEmpty() && !"/".equals(path));
            putJson(payload, "urlHasQuery", uri.getRawQuery() != null && !uri.getRawQuery().isEmpty());
        } catch (Exception e) {
            putJson(payload, "urlParseError", e.getClass().getSimpleName());
        }
    }

    private static void putJson(JSONObject payload, String key, Object value) {
        if (payload == null || key == null || value == null) {
            return;
        }
        try {
            payload.put(key, value);
        } catch (Exception ignored) {
        }
    }

    private static void safeTraceJson(String direction, String layer, JSONObject payload) {
        try {
            BleTraceLogger.logJson(direction, layer, payload, null);
        } catch (Throwable ignored) {
        }
    }

    /**
     * Alternative method for platforms without AVIF support
     * Expects already-decoded JPEG data instead of AVIF
     */
    public static void uploadJpegPhoto(byte[] jpegData, String requestId,
                                      String webhookUrl, @Nullable String authToken,
                                      UploadCallback callback) {
        new Thread(() -> {
            try {
                Log.d(TAG, "Uploading pre-decoded JPEG. Size: " + jpegData.length + " bytes");
                String responseBody = uploadToWebhook(jpegData, requestId, webhookUrl, authToken);
                callback.onSuccess(requestId, responseBody);
            } catch (Exception e) {
                Log.e(TAG, "Error uploading JPEG photo", e);
                callback.onError(requestId, e.getMessage());
            }
        }).start();
    }
}
