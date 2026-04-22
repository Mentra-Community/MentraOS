package com.mentra.core.utils;

import android.util.Log;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * POSTs incident log JSON (from BLE relay) using the same path as glasses direct upload.
 */
public final class IncidentLogBleUploadService {

    private static final String TAG = "IncidentLogBleUpload";

    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");

    private IncidentLogBleUploadService() {}

    public interface Callback {
        void onDone(boolean success, String message);
    }

    public static void upload(String apiBaseUrl, String incidentId, String authToken,
                              byte[] jsonUtf8, Callback callback) {
        new Thread(() -> {
            try {
                if (authToken == null || authToken.isEmpty()) {
                    callback.onDone(false, "no auth token");
                    return;
                }
                HttpUrl baseHttpUrl = HttpUrl.parse(apiBaseUrl != null ? apiBaseUrl.trim() : "");
                if (baseHttpUrl == null) {
                    callback.onDone(false, "empty or malformed api base url");
                    return;
                }
                HttpUrl url = baseHttpUrl.newBuilder()
                        .addPathSegment("api")
                        .addPathSegment("incidents")
                        .addPathSegment(incidentId)
                        .addPathSegment("logs")
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
                        Log.i(TAG, "Incident BLE relay upload OK: " + url);
                        callback.onDone(true, null);
                    } else {
                        String msg = "HTTP " + response.code();
                        Log.e(TAG, "Incident BLE relay upload failed: " + msg + " " + url);
                        callback.onDone(false, msg);
                    }
                }
            } catch (IOException e) {
                Log.e(TAG, "Incident BLE relay upload IO error", e);
                callback.onDone(false, e.getMessage());
            }
        }).start();
    }
}
