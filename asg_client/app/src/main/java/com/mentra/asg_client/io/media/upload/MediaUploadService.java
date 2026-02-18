package com.mentra.asg_client.io.media.upload;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Binder;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.preference.PreferenceManager;

import com.mentra.asg_client.utils.ServerConfigUtil;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Timer;
import java.util.concurrent.atomic.AtomicBoolean;

import com.mentra.asg_client.R;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager; // Updated import

/**
 * Foreground service that manages media (photo/video) uploads in the background.
 * Handles processing the media upload queue, retry logic, and user notifications.
 */
public class MediaUploadService extends Service { // Renamed class

    private static final String TAG = "MediaUploadService"; // Renamed TAG

    // Notification constants
    private static final String CHANNEL_ID = "media_upload_channel"; // Renamed channel ID
    private static final int NOTIFICATION_ID = 1001;
    private static final String NOTIFICATION_CHANNEL_NAME = "Media Uploads"; // Updated channel name
    private static final String NOTIFICATION_CHANNEL_DESC = "Notifications about media uploads"; // Updated channel desc

    // Actions (remain largely the same, but reflect general media)
    public static final String ACTION_START_SERVICE = "com.mentra.asg_client.action.START_MEDIA_UPLOAD_SERVICE";
    public static final String ACTION_STOP_SERVICE = "com.mentra.asg_client.action.STOP_MEDIA_UPLOAD_SERVICE";
    public static final String ACTION_PROCESS_QUEUE = "com.mentra.asg_client.action.PROCESS_MEDIA_QUEUE";
    public static final String ACTION_UPLOAD_STATUS = "com.mentra.asg_client.action.MEDIA_UPLOAD_STATUS";
    public static final String EXTRA_REQUEST_ID = "request_id";
    public static final String EXTRA_SUCCESS = "success";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_ERROR = "error";
    public static final String EXTRA_MEDIA_TYPE = "media_type"; // Added for context in notifications/callbacks

    // Queue processing settings
    private static final long QUEUE_PROCESSING_INTERVAL = 60000; // 1 minute
    private static final int MAX_RETRY_COUNT = 3;

    // Binder for clients
    private final IBinder mBinder = new LocalBinder();

    // Service state
    private AtomicBoolean mIsProcessing = new AtomicBoolean(false);
    private MediaUploadQueueManager mMediaQueueManager; // Updated type
    private Timer mQueueProcessingTimer;
    private int mSuccessCount = 0;
    private int mFailureCount = 0;
    private PowerManager.WakeLock mWakeLock;

    /**
     * Callback interface for upload operations
     */
    public interface UploadCallback {
        void onSuccess(String url);
        void onFailure(String errorMessage);
    }

    /**
     * Static method to upload media files
     */
    public static void uploadMedia(Context context, String filePath, String requestId, int mediaType, UploadCallback callback) {
        // Get authentication token from SharedPreferences
        String coreToken = PreferenceManager.getDefaultSharedPreferences(context)
                .getString("core_token", "");

        if (coreToken.isEmpty()) {
            callback.onFailure("No authentication token available");
            return;
        }

        // Create file object and verify it exists
        File mediaFile = new File(filePath);
        if (!mediaFile.exists()) {
            callback.onFailure("Media file does not exist: " + filePath);
            return;
        }

        // Get device ID
        String deviceId = android.os.Build.MODEL + "_" + android.os.Build.SERIAL;

        // Get appropriate upload URL based on media type
        String uploadUrl;
        MediaType mediaContentType;

        if (mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO) {
            uploadUrl = ServerConfigUtil.getPhotoUploadUrl(context);
            mediaContentType = MediaType.parse("image/jpeg");
        } else if (mediaType == MediaUploadQueueManager.MEDIA_TYPE_VIDEO) {
            uploadUrl = ServerConfigUtil.getVideoUploadUrl(context);
            mediaContentType = MediaType.parse("video/mp4");
        } else {
            callback.onFailure("Invalid media type: " + mediaType);
            return;
        }

        uploadUrl = "https://dev.augmentos.org:443/api/photos/upload";

        Log.d(TAG, "Uploading media to: " + uploadUrl);

        try {
            // Create HTTP client with appropriate timeouts
            OkHttpClient client = new OkHttpClient.Builder()
                    .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                    .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                    .retryOnConnectionFailure(true)  // Enable retries
                    .build();

            // Log network state
            ConnectivityManager connectivityManager =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network activeNetwork = connectivityManager.getActiveNetwork();
            if (activeNetwork != null) {
                NetworkCapabilities capabilities =
                        connectivityManager.getNetworkCapabilities(activeNetwork);
                if (capabilities != null) {
                    boolean hasInternet = capabilities.hasCapability(
                            NetworkCapabilities.NET_CAPABILITY_INTERNET);
                    boolean validatedInternet = capabilities.hasCapability(
                            NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                    Log.d(TAG, "Network state - Internet: " + hasInternet +
                            ", Validated: " + validatedInternet);
                }
            }

            // Build JSON metadata
            JSONObject metadata = new JSONObject();
            metadata.put("requestId", requestId);
            metadata.put("deviceId", deviceId);
            metadata.put("timestamp", System.currentTimeMillis());
            metadata.put("mediaType", mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO ? "photo" : "video");
            metadata.put("appId", "asg_client");  // Add appId

            // Create multipart request
            RequestBody requestBody = new MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("file", mediaFile.getName(),
                            RequestBody.create(mediaContentType, mediaFile))
                    .addFormDataPart("metadata", metadata.toString())
                    .build();

            // Build the request
            Request request = new Request.Builder()
                    .url(uploadUrl)
                    .header("Authorization", "Bearer " + coreToken)
                    .post(requestBody)
                    .build();

            // Log detailed request information
            StringBuilder requestLog = new StringBuilder();
            requestLog.append("\n=== Request Details ===\n");
            requestLog.append("URL: ").append(request.url()).append("\n");
            requestLog.append("Method: ").append(request.method()).append("\n");
            requestLog.append("Headers:\n");
            request.headers().forEach(header ->
                    requestLog.append("  ").append(header.getFirst()).append(": ")
                            .append(header.getSecond())
                            .append("\n")
            );
            requestLog.append("Metadata: ").append(metadata.toString()).append("\n");
            requestLog.append("File name: ").append(mediaFile.getName()).append("\n");
            requestLog.append("File size: ").append(mediaFile.length()).append(" bytes\n");
            requestLog.append("Media type: ").append(mediaContentType).append("\n");
            requestLog.append("====================");

            Log.d(TAG, requestLog.toString());

            // Execute the request
            client.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    String errorMsg = "Network error during upload: " + e.getMessage();
                    Log.e(TAG, errorMsg);
                    callback.onFailure(errorMsg);
                }

                @Override
                public void onResponse(Call call, Response response) {
                    try {
                        if (!response.isSuccessful()) {
                            String errorMsg = "Server error: " + response.code();
                            Log.e(TAG, errorMsg);
                            callback.onFailure(errorMsg);
                            return;
                        }

                        // Parse the response
                        String responseBody = response.body().string();
                        JSONObject jsonResponse = new JSONObject(responseBody);

                        // Check if response contains URL
                        if (jsonResponse.has("url")) {
                            String url = jsonResponse.getString("url");
                            Log.d(TAG, "Media upload successful, URL: " + url);
                            callback.onSuccess(url);
                        } else {
                            Log.e(TAG, "Invalid server response - missing URL");
                            callback.onFailure("Invalid server response - missing URL");
                        }
                    } catch (Exception e) {
                        String errorMsg = "Error processing server response: " + e.getMessage();
                        Log.e(TAG, errorMsg);
                        callback.onFailure(errorMsg);
                    } finally {
                        response.close();
                    }
                }
            });
        } catch (Exception e) {
            String errorMsg = "Error preparing upload request: " + e.getMessage();
            Log.e(TAG, errorMsg);
            callback.onFailure(errorMsg);
        }
    }

    /**
     * Class for clients to access the service
     */
    public class LocalBinder extends Binder {
        public MediaUploadService getService() { // Updated return type
            return MediaUploadService.this;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return mBinder;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "MediaUploadService created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "MediaUploadService started");
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "MediaUploadService destroyed");
    }
} 