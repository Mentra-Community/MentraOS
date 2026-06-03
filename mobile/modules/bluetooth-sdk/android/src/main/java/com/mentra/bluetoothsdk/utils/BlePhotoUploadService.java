package com.mentra.bluetoothsdk.utils;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.bluetoothsdk.debug.BleTraceLogger;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * Service to handle BLE photo uploads including AVIF decoding and webhook posting
 */
public class BlePhotoUploadService {
    private static final String TAG = "BlePhotoUploadService";

    public interface UploadCallback {
        void onSuccess(String requestId);
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

                // 1. Decode image (AVIF or JPEG) to Bitmap
                Bitmap bitmap = decodeImage(imageData);
                if (bitmap == null) {
                    throw new Exception("Failed to decode image data");
                }

                Log.d(TAG, "Decoded image to bitmap: " + bitmap.getWidth() + "x" + bitmap.getHeight());

                // 2. Convert to JPEG for upload (in case it was AVIF)
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 90, baos);
                byte[] jpegData = baos.toByteArray();
                bitmap.recycle();

                Log.d(TAG, "Converted to JPEG for upload. Size: " + jpegData.length + " bytes");

                // 3. Upload to webhook
                uploadToWebhook(jpegData, imageData.length, requestId, webhookUrl, authToken);

                Log.d(TAG, "Photo uploaded successfully for requestId: " + requestId);
                callback.onSuccess(requestId);

            } catch (Exception e) {
                Log.e(TAG, "Error processing BLE photo for requestId: " + requestId, e);
                callback.onError(requestId, e.getMessage());
            }
        }).start();
    }

    /**
     * Decode image data (AVIF or JPEG) to Bitmap
     * @param imageData Raw image bytes
     * @return Decoded bitmap or null if failed
     */
    private static Bitmap decodeImage(byte[] imageData) {
        try {
            // Check if this is AVIF by looking for "ftyp" box
            boolean isAvif = imageData.length > 12 &&
                           imageData[4] == 'f' && imageData[5] == 't' &&
                           imageData[6] == 'y' && imageData[7] == 'p' &&
                           (imageData[8] == 'a' && imageData[9] == 'v' && imageData[10] == 'i' && imageData[11] == 'f');

            if (isAvif) {
                Log.d(TAG, "Detected AVIF image format");
                // AVIF decoding - requires Android API 31+ for native support
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // Android 12+ has native AVIF support
                    BitmapFactory.Options options = new BitmapFactory.Options();
                    options.inPreferredConfig = Bitmap.Config.ARGB_8888;
                    return BitmapFactory.decodeByteArray(imageData, 0, imageData.length, options);
                } else {
                    // For older Android versions, we could add a library or convert on glasses side
                    Log.e(TAG, "AVIF decoding requires Android 12+ (API 31+). Current API: " + Build.VERSION.SDK_INT);
                    throw new UnsupportedOperationException("AVIF not supported on Android " + Build.VERSION.SDK_INT);
                }
            } else {
                Log.d(TAG, "Detected JPEG image format");
                // Standard JPEG decoding
                return BitmapFactory.decodeByteArray(imageData, 0, imageData.length);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to decode image", e);
            return null;
        }
    }

    /**
     * Upload JPEG data to webhook
     * @param jpegData JPEG image bytes
     * @param requestId Request ID for tracking
     * @param webhookUrl Destination URL
     * @param authToken Optional bearer token for auth
     * @throws IOException If upload fails
     */
    private static void uploadToWebhook(byte[] jpegData, String requestId,
                                       String webhookUrl, @Nullable String authToken) throws IOException {
        uploadToWebhook(jpegData, -1, requestId, webhookUrl, authToken);
    }

    private static void uploadToWebhook(byte[] jpegData, int sourceImageBytes, String requestId,
                                       String webhookUrl, @Nullable String authToken) throws IOException {
        OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build();

        // Build multipart request
        RequestBody requestBody = new MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("requestId", requestId)
            .addFormDataPart("source", "ble_transfer")
            .addFormDataPart("photo", requestId + ".jpg",
                RequestBody.create(MediaType.parse("image/jpeg"), jpegData))
            .build();

        // Build request with auth header
        Request.Builder requestBuilder = new Request.Builder()
            .url(webhookUrl)
            .post(requestBody);

        if (authToken != null && !authToken.isEmpty()) {
            requestBuilder.addHeader("Authorization", "Bearer " + authToken);
        }

        Request request = requestBuilder.build();

        Log.d(TAG, "Uploading photo to webhook: " + webhookUrl);
        long startMs = System.currentTimeMillis();
        traceRelayUploadStart(requestId, webhookUrl, authToken, sourceImageBytes, jpegData.length, startMs);

        boolean responseTraced = false;
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                String errorBody = response.body() != null ? response.body().string() : "No response body";
                traceRelayUploadEnd(
                    requestId,
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

            traceRelayUploadEnd(
                requestId,
                webhookUrl,
                sourceImageBytes,
                jpegData.length,
                startMs,
                response.code(),
                true,
                "uploaded");
            responseTraced = true;
            Log.d(TAG, "Upload successful. Response code: " + response.code());
        } catch (IOException e) {
            if (!responseTraced) {
                traceRelayUploadError(
                    requestId,
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

    private static void traceRelayUploadStart(String requestId, String webhookUrl,
                                             @Nullable String authToken, int sourceImageBytes,
                                             int jpegBytes, long startMs) {
        JSONObject payload = createRelayUploadPayload(
            "photo_relay_upload_start",
            requestId,
            webhookUrl,
            sourceImageBytes,
            jpegBytes,
            startMs);
        putJson(payload, "bearerHeaderPresent", authToken != null && !authToken.isEmpty());
        safeTraceJson("phone_to_wifi", "wifi_http_output", payload);
    }

    private static void traceRelayUploadEnd(String requestId, String webhookUrl,
                                           int sourceImageBytes, int jpegBytes, long startMs,
                                           int statusCode, boolean success, String outcome) {
        JSONObject payload = createRelayUploadPayload(
            "photo_relay_upload_end",
            requestId,
            webhookUrl,
            sourceImageBytes,
            jpegBytes,
            startMs);
        long endMs = System.currentTimeMillis();
        putJson(payload, "endMs", endMs);
        putJson(payload, "durationMs", endMs - startMs);
        putJson(payload, "statusCode", statusCode);
        putJson(payload, "success", success);
        putJson(payload, "outcome", outcome);
        safeTraceJson("wifi_to_phone", "wifi_http_input", payload);
    }

    private static void traceRelayUploadError(String requestId, String webhookUrl,
                                             int sourceImageBytes, int jpegBytes, long startMs,
                                             Exception error, String outcome) {
        JSONObject payload = createRelayUploadPayload(
            "photo_relay_upload_error",
            requestId,
            webhookUrl,
            sourceImageBytes,
            jpegBytes,
            startMs);
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
                uploadToWebhook(jpegData, requestId, webhookUrl, authToken);
                callback.onSuccess(requestId);
            } catch (Exception e) {
                Log.e(TAG, "Error uploading JPEG photo", e);
                callback.onError(requestId, e.getMessage());
            }
        }).start();
    }
}
