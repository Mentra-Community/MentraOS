package com.mentra.core.utils;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

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
     * @param authToken Authentication token for upload
     * @param callback Callback for success/error
     */
    public static void processAndUploadPhoto(byte[] imageData, String requestId,
                                            String webhookUrl, String authToken,
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
                uploadToWebhook(jpegData, requestId, webhookUrl, authToken);

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
     * @param authToken Bearer token for auth
     * @throws IOException If upload fails
     */
    private static void uploadToWebhook(byte[] jpegData, String requestId,
                                       String webhookUrl, String authToken) throws IOException {
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

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                String errorBody = response.body() != null ? response.body().string() : "No response body";
                throw new IOException("Upload failed with code " + response.code() + ": " + errorBody);
            }

            Log.d(TAG, "Upload successful. Response code: " + response.code());
        }
    }

    /**
     * Alternative method for platforms without AVIF support
     * Expects already-decoded JPEG data instead of AVIF
     */
    public static void uploadJpegPhoto(byte[] jpegData, String requestId,
                                      String webhookUrl, String authToken,
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
