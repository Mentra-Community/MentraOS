package com.augmentos.asg_client.camera.upload;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.preference.PreferenceManager;

import com.augmentos.augmentos_core.utils.ServerConfigUtil;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.atomic.AtomicBoolean;

import com.augmentos.asg_client.MainActivity;
import com.augmentos.asg_client.R;
import com.augmentos.asg_client.camera.MediaUploadQueueManager; // Updated import

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
    public static final String ACTION_START_SERVICE = "com.augmentos.asg_client.action.START_MEDIA_UPLOAD_SERVICE";
    public static final String ACTION_STOP_SERVICE = "com.augmentos.asg_client.action.STOP_MEDIA_UPLOAD_SERVICE";
    public static final String ACTION_PROCESS_QUEUE = "com.augmentos.asg_client.action.PROCESS_MEDIA_QUEUE";
    public static final String ACTION_UPLOAD_STATUS = "com.augmentos.asg_client.action.MEDIA_UPLOAD_STATUS";
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
     * Class for clients to access the service
     */
    public class LocalBinder extends Binder {
        public MediaUploadService getService() { // Updated return type
            return MediaUploadService.this;
        }
    }

    /**
     * Factory method to start the service with appropriate action
     *
     * @param context Application context
     */
    public static void startService(Context context) {
        Intent intent = new Intent(context, MediaUploadService.class);
        intent.setAction(ACTION_START_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /**
     * Factory method to stop the service
     *
     * @param context Application context
     */
    public static void stopService(Context context) {
        Intent intent = new Intent(context, MediaUploadService.class);
        intent.setAction(ACTION_STOP_SERVICE);
        context.startService(intent);
    }

    /**
     * Factory method to trigger queue processing manually
     *
     * @param context Application context
     */
    public static void processQueue(Context context) {
        Intent intent = new Intent(context, MediaUploadService.class);
        intent.setAction(ACTION_PROCESS_QUEUE);
        context.startService(intent);
    }

    /**
     * Static method to initiate an upload (used by MediaUploadQueueManager)
     */
    public static void uploadMedia(Context context, String filePath, String requestId, int mediaType, UploadCallback callback) {
        // Get authentication token from SharedPreferences
        String coreToken = PreferenceManager.getDefaultSharedPreferences(context)
                .getString("core_token", "");

        if (coreToken == null || coreToken.isEmpty()) {
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
            uploadUrl = ServerConfigUtil.getPhotoUploadUrl();
            mediaContentType = MediaType.parse("image/jpeg");
        } else if (mediaType == MediaUploadQueueManager.MEDIA_TYPE_VIDEO) {
            uploadUrl = ServerConfigUtil.getVideoUploadUrl();
            mediaContentType = MediaType.parse("video/mp4");
        } else {
            callback.onFailure("Invalid media type: " + mediaType);
            return;
        }

        Log.d(TAG, "Uploading media to: " + uploadUrl);

        try {
            // Create HTTP client with appropriate timeouts
            OkHttpClient client = new OkHttpClient.Builder()
                    .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                    .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                    .build();

            // Build JSON metadata
            JSONObject metadata = new JSONObject();
            metadata.put("requestId", requestId);
            metadata.put("deviceId", deviceId);
            metadata.put("timestamp", System.currentTimeMillis());
            metadata.put("mediaType", mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO ? "photo" : "video");

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

    // Callback interface for upload results
    public interface UploadCallback {
        void onSuccess(String url);
        void onFailure(String errorMessage);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "Service created");

        // Initialize the MediaUploadQueueManager
        mMediaQueueManager = new MediaUploadQueueManager(getApplicationContext()); // Updated instantiation

        // Set up queue callback
        setupQueueCallbacks();

        // Create notification channel
        createNotificationChannel();

        // Acquire wake lock to ensure service keeps running
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            mWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                    "AugmentOS:MediaUploadWakeLock"); // Updated wake lock tag
        } else {
            Log.e(TAG, "PowerManager not available");
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            Log.e(TAG, "Service started with null intent or action");
            return START_STICKY;
        }

        String action = intent.getAction();
        Log.d(TAG, "Service received action: " + action);

        switch (action) {
            case ACTION_START_SERVICE:
                startForeground(NOTIFICATION_ID, createNotification("Starting media upload service..."));
                startQueueProcessing();
                break;

            case ACTION_STOP_SERVICE:
                stopQueueProcessing();
                stopForeground(true);
                stopSelf();
                break;

            case ACTION_PROCESS_QUEUE:
                processQueueNow();
                break;

            case ACTION_UPLOAD_STATUS:
                handleUploadStatus(intent);
                break;
        }

        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return mBinder;
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "Service destroyed");
        stopQueueProcessing();

        // Release wake lock if held
        if (mWakeLock != null && mWakeLock.isHeld()) {
            mWakeLock.release();
        }

        super.onDestroy();
    }

    /**
     * Create the notification channel for Android O and above
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    NOTIFICATION_CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(NOTIFICATION_CHANNEL_DESC);

            NotificationManager notificationManager = getSystemService(NotificationManager.class);
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(channel);
            }
        }
    }

    /**
     * Create notification with current status
     */
    private Notification createNotification(String contentText) {
        // Create an intent to open the app when notification is tapped
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, intent, PendingIntent.FLAG_IMMUTABLE);

        // Get queue stats
        JSONObject stats = mMediaQueueManager.getQueueStats();
        int totalCount = stats.optInt("totalCount", 0);
        int queuedCount = stats.optInt("queuedCount", 0);
        int uploadingCount = stats.optInt("uploadingCount", 0);
        int failedCount = stats.optInt("failedCount", 0);

        String statusContent;
        if (totalCount == 0) {
            statusContent = "No media items in queue";
        } else {
            statusContent = String.format("Queue: %d items (%d waiting, %d in progress, %d failed)",
                    totalCount, queuedCount, uploadingCount, failedCount);
        }

        // Create the notification
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Media Upload Service") // Updated title
                .setContentText(contentText)
                .setStyle(new NotificationCompat.BigTextStyle()
                        .bigText(contentText + "\n" + statusContent))
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build();
    }

    /**
     * Update the notification with new content
     */
    private void updateNotification(String contentText) {
        Notification notification = createNotification(contentText);

        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(this);
        notificationManager.notify(NOTIFICATION_ID, notification);
    }

    /**
     * Set up callbacks for the MediaUploadQueueManager
     */
    private void setupQueueCallbacks() {
        mMediaQueueManager.setMediaQueueCallback(new MediaUploadQueueManager.MediaQueueCallback() {
            @Override
            public void onMediaQueued(String requestId, String filePath, int mediaType) {
                Log.d(TAG, "Media queued: " + requestId + " (type: " + mediaType + ")");
                updateNotification("Media queued: " + requestId);
            }

            @Override
            public void onMediaUploaded(String requestId, String url, int mediaType) {
                Log.d(TAG, "Media uploaded: " + requestId + ", URL: " + url + " (type: " + mediaType + ")");
                mSuccessCount++;

                // Send status broadcast
                Intent statusIntent = new Intent(ACTION_UPLOAD_STATUS);
                statusIntent.putExtra(EXTRA_REQUEST_ID, requestId);
                statusIntent.putExtra(EXTRA_SUCCESS, true);
                statusIntent.putExtra(EXTRA_URL, url);
                statusIntent.putExtra(EXTRA_MEDIA_TYPE, mediaType);
                sendBroadcast(statusIntent); // Permission check might be needed here for some Android versions

                updateNotification("Media uploaded successfully");
            }

            @SuppressLint("MissingPermission")
            // Assuming internal broadcast, otherwise add permission check
            @Override
            public void onMediaUploadFailed(String requestId, String error, int mediaType) {
                Log.e(TAG, "Media upload failed: " + requestId + ", error: " + error + " (type: " + mediaType + ")");
                mFailureCount++;

                Intent statusIntent = new Intent(ACTION_UPLOAD_STATUS);
                statusIntent.putExtra(EXTRA_REQUEST_ID, requestId);
                statusIntent.putExtra(EXTRA_SUCCESS, false);
                statusIntent.putExtra(EXTRA_ERROR, error);
                statusIntent.putExtra(EXTRA_MEDIA_TYPE, mediaType);
                sendBroadcast(statusIntent);

                updateNotification("Media upload failed: " + error);
            }
        });
    }

    /**
     * Start the periodic queue processing
     */
    private void startQueueProcessing() {
        if (mQueueProcessingTimer != null) {
            mQueueProcessingTimer.cancel();
        }

        mQueueProcessingTimer = new Timer(true);
        mQueueProcessingTimer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                processQueueNow();
            }
        }, 0, QUEUE_PROCESSING_INTERVAL);

        // Acquire wake lock
        if (mWakeLock != null && !mWakeLock.isHeld()) {
            mWakeLock.acquire(24 * 60 * 60 * 1000L); // 24 hours max
        }

        updateNotification("Media upload service is running");
    }

    /**
     * Stop the periodic queue processing
     */
    private void stopQueueProcessing() {
        if (mQueueProcessingTimer != null) {
            mQueueProcessingTimer.cancel();
            mQueueProcessingTimer = null;
        }

        // Release wake lock if held
        if (mWakeLock != null && mWakeLock.isHeld()) {
            mWakeLock.release();
        }
    }

    /**
     * Process the queue now
     */
    private void processQueueNow() {
        // Only process if not already processing and there are queued media items
        if (mIsProcessing.compareAndSet(false, true)) {
            new Handler(Looper.getMainLooper()).post(() -> {
                updateNotification("Processing media upload queue...");
            });

            // If there are failed uploads, retry them
            mMediaQueueManager.retryFailedUploads(MAX_RETRY_COUNT);

            // Process the queue
            mMediaQueueManager.processQueue();

            // Reset processing flag
            mIsProcessing.set(false);
        }
    }

    /**
     * Handle upload status from intent
     */
    private void handleUploadStatus(Intent intent) {
        String requestId = intent.getStringExtra(EXTRA_REQUEST_ID);
        boolean success = intent.getBooleanExtra(EXTRA_SUCCESS, false);
        int mediaType = intent.getIntExtra(EXTRA_MEDIA_TYPE, MediaUploadQueueManager.MEDIA_TYPE_PHOTO);

        if (success) {
            String url = intent.getStringExtra(EXTRA_URL);
            Log.d(TAG, "Upload succeeded for request: " + requestId + ", URL: " + url + " (type: " + mediaType + ")");
            updateNotification("Media uploaded successfully: " + requestId);
        } else {
            String error = intent.getStringExtra(EXTRA_ERROR);
            Log.e(TAG, "Upload failed for request: " + requestId + ", error: " + error + " (type: " + mediaType + ")");
            updateNotification("Media upload failed: " + requestId + " (" + error + ")");
        }
    }

    /**
     * Get statistics about uploads and the queue
     */
    public JSONObject getStatistics() {
        JSONObject stats = new JSONObject();
        try {
            // Get queue stats
            JSONObject queueStats = mMediaQueueManager.getQueueStats();

            // Add our own tracking stats
            stats.put("queueStats", queueStats);
            stats.put("successCount", mSuccessCount);
            stats.put("failureCount", mFailureCount);
            stats.put("isProcessing", mIsProcessing.get());

        } catch (JSONException e) {
            Log.e(TAG, "Error creating statistics JSON", e);
        }

        return stats;
    }

    /**
     * Get the media queue manager instance
     */
    public MediaUploadQueueManager getMediaQueueManager() { // Updated return type
        return mMediaQueueManager;
    }
}
