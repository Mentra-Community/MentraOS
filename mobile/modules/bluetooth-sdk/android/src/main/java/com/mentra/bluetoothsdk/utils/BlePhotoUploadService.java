package com.mentra.bluetoothsdk.utils;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.VisibleForTesting;
import androidx.exifinterface.media.ExifInterface;

import com.radzivon.bartoshyk.avif.coder.HeifCoder;
import com.radzivon.bartoshyk.avif.coder.PreferredColorConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Service to handle BLE photo uploads including AVIF decoding and webhook posting.
 * Preserves IMU metadata embedded in EXIF UserComment when re-encoding to JPEG.
 */
public class BlePhotoUploadService {
    private static final String TAG = "BlePhotoUploadService";
    private static final int JPEG_QUALITY = 90;

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

                byte[] jpegData = convertToJpegPreservingExif(imageData);
                Log.d(TAG, "Converted to JPEG for upload. Size: " + jpegData.length + " bytes");

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
     * Decode incoming AVIF/JPEG, re-encode as JPEG, and re-attach IMU EXIF when present.
     */
    @VisibleForTesting
    static byte[] convertToJpegPreservingExif(byte[] imageData) throws Exception {
        File inputFile = File.createTempFile("ble_photo_in_", guessExtension(imageData));
        File outputFile = File.createTempFile("ble_photo_out_", ".jpg");
        try {
            try (FileOutputStream fos = new FileOutputStream(inputFile)) {
                fos.write(imageData);
            }

            logIncomingImageDiagnostics(imageData, inputFile.getAbsolutePath());

            String imuJson = readImuJsonFromBleImage(imageData, inputFile.getAbsolutePath());

            Bitmap bitmap = decodeImage(imageData);
            if (bitmap == null) {
                throw new Exception("Failed to decode image data");
            }

            Log.d(TAG, "Decoded image to bitmap: " + bitmap.getWidth() + "x" + bitmap.getHeight());

            try (FileOutputStream fos = new FileOutputStream(outputFile)) {
                bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, fos);
            } finally {
                bitmap.recycle();
            }

            if (imuJson != null && !imuJson.isEmpty()) {
                logImuData(imuJson);
                writeImuJsonToJpeg(outputFile.getAbsolutePath(), imuJson);
                Log.d(TAG, "Re-attached IMU EXIF UserComment on output JPEG (" + imuJson.length() + " chars)");
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

            return java.nio.file.Files.readAllBytes(outputFile.toPath());
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            Log.w(TAG, "EXIF read skipped: API < 24");
            return null;
        }
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
                byte[] decodeBytes = imageData;
                if (containsExifMarkerInBytes(imageData)) {
                    try {
                        decodeBytes = AvifExifStripper.stripForDecode(imageData);
                        Log.d(
                                TAG,
                                "Stripped Exif metadata item for decode: "
                                        + imageData.length
                                        + " -> "
                                        + decodeBytes.length
                                        + " bytes");
                    } catch (IOException e) {
                        Log.w(TAG, "stripForDecode failed, using raw AVIF: " + e.getMessage());
                    }
                }
                try {
                    Bitmap bmp = new HeifCoder().decode(decodeBytes, PreferredColorConfig.RGBA_8888);
                    if (bmp != null) {
                        return bmp;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "HeifCoder AVIF decode failed, trying BitmapFactory: " + e.getMessage());
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    return BitmapFactory.decodeByteArray(imageData, 0, imageData.length);
                }
                Log.e(TAG, "AVIF decoding requires Android 12+ (API 31+). Current API: " + Build.VERSION.SDK_INT);
                throw new UnsupportedOperationException("AVIF not supported on Android " + Build.VERSION.SDK_INT);
            }
            Log.d(TAG, "Detected JPEG image format");
            return BitmapFactory.decodeByteArray(imageData, 0, imageData.length);
        } catch (Exception e) {
            Log.e(TAG, "Failed to decode image", e);
            return null;
        }
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

    private static void uploadToWebhook(byte[] jpegData, String requestId,
                                       String webhookUrl, @Nullable String authToken) throws IOException {
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
