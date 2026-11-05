package com.mentra.bluetoothsdk.utils;

import com.mentra.bluetoothsdk.utils.NativeLog;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * POSTs report artifact JSON from the BLE relay using the same path as glasses direct upload.
 */
public final class IncidentLogBleUploadService {

    private static final String TAG = "IncidentLogBleUpload";

    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");

    private IncidentLogBleUploadService() {}

    public interface Callback {
        /** @param httpStatus Cloud's status code, or 0 when no response arrived. */
        void onDone(boolean success, int httpStatus, String message);
    }

    /** Cloud will refuse these bytes every time: missing report, invalid, conflicting or oversized body. */
    public static boolean isPermanentRejection(int httpStatus) {
        return httpStatus == 400 || httpStatus == 404 || httpStatus == 409 || httpStatus == 410
                || httpStatus == 413 || httpStatus == 422;
    }

    public static void upload(String apiBaseUrl, String incidentId, String authToken,
                              byte[] jsonUtf8, Callback callback) {
        new Thread(() -> {
            try {
                if (authToken == null || authToken.isEmpty()) {
                    callback.onDone(false, 0, "no auth token");
                    return;
                }
                HttpUrl baseHttpUrl = HttpUrl.parse(apiBaseUrl != null ? apiBaseUrl.trim() : "");
                if (baseHttpUrl == null) {
                    callback.onDone(false, 0, "empty or malformed api base url");
                    return;
                }
                HttpUrl url = baseHttpUrl.newBuilder()
                        .addPathSegment("api")
                        .addPathSegment("client")
                        .addPathSegment("reports")
                        .addPathSegment(incidentId)
                        .addPathSegment("artifacts")
                        .build();
                RequestBody body = RequestBody.create(jsonUtf8, JSON);
                OkHttpClient client = new OkHttpClient.Builder()
                        .connectTimeout(20, TimeUnit.SECONDS)
                        .writeTimeout(60, TimeUnit.SECONDS)
                        .readTimeout(60, TimeUnit.SECONDS)
                        .build();
                Request request = new Request.Builder()
                        .url(url)
                        .header("Authorization", "Bearer " + authToken)
                        .post(body)
                        .build();
                try (Response response = client.newCall(request).execute()) {
                    if (response.isSuccessful()) {
                        NativeLog.i(TAG, "Incident BLE relay upload OK: " + url);
                        callback.onDone(true, response.code(), null);
                    } else {
                        String msg = "HTTP " + response.code();
                        NativeLog.e(TAG, "Incident BLE relay upload failed: " + msg + " " + url);
                        callback.onDone(false, response.code(), msg);
                    }
                }
            } catch (IOException e) {
                NativeLog.e(TAG, "Incident BLE relay upload IO error", e);
                callback.onDone(false, 0, e.getMessage());
            }
        }).start();
    }
}
