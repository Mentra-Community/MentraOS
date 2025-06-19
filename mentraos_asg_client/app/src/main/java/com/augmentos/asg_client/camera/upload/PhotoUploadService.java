package com.augmentos.asg_client.camera.upload;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.atomic.AtomicBoolean;

import com.augmentos.asg_client.MainActivity;
import com.augmentos.asg_client.R;
import com.augmentos.asg_client.camera.PhotoQueueManager;
import com.augmentos.augmentos_core.smarterglassesmanager.camera.PhotoUploadService.UploadCallback;

/**
 * Foreground service that manages photo uploads in the background.
 * Handles processing the photo upload queue, retry logic, and user notifications.
 */
public class PhotoUploadService extends Service {

    private static final String TAG = "PhotoUploadService";
    
    // Notification constants
    private static final String CHANNEL_ID = "photo_upload_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final String NOTIFICATION_CHANNEL_NAME = "Photo Uploads";
    private static final String NOTIFICATION_CHANNEL_DESC = "Notifications about photo uploads";
    
    // Actions
    public static final String ACTION_START_SERVICE = "com.augmentos.asg_client.action.START_UPLOAD_SERVICE";
    public static final String ACTION_STOP_SERVICE = "com.augmentos.asg_client.action.STOP_UPLOAD_SERVICE";
    public static final String ACTION_PROCESS_QUEUE = "com.augmentos.asg_client.action.PROCESS_QUEUE";
    public static final String ACTION_UPLOAD_STATUS = "com.augmentos.asg_client.action.UPLOAD_STATUS";
    public static final String EXTRA_REQUEST_ID = "request_id";
    public static final String EXTRA_SUCCESS = "success";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_ERROR = "error";
    
    // Queue processing settings
    private static final long QUEUE_PROCESSING_INTERVAL = 60000; // 1 minute
    private static final int MAX_RETRY_COUNT = 3;
    
    // Binder for clients
    private final IBinder mBinder = new LocalBinder();
    
    // Service state
    private AtomicBoolean mIsProcessing = new AtomicBoolean(false);
    private PhotoQueueManager mPhotoQueueManager;
    private Timer mQueueProcessingTimer;
    private int mSuccessCount = 0;
    private int mFailureCount = 0;
    private PowerManager.WakeLock mWakeLock;
    
    /**
     * Class for clients to access the service
     */
    public class LocalBinder extends Binder {
        public PhotoUploadService getService() {
            return PhotoUploadService.this;
        }
    }
    
    /**
     * Factory method to start the service with appropriate action
     * 
     * @param context Application context
     */
    public static void startService(Context context) {
        Intent intent = new Intent(context, PhotoUploadService.class);
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
        Intent intent = new Intent(context, PhotoUploadService.class);
        intent.setAction(ACTION_STOP_SERVICE);
        context.startService(intent);
    }
    
    /**
     * Factory method to trigger queue processing manually
     * 
     * @param context Application context
     */
    public static void processQueue(Context context) {
        Intent intent = new Intent(context, PhotoUploadService.class);
        intent.setAction(ACTION_PROCESS_QUEUE);
        context.startService(intent);
    }
    
    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "Service created");
        
        // Initialize the PhotoQueueManager
        mPhotoQueueManager = new PhotoQueueManager(getApplicationContext());
        
        // Set up queue callback
        setupQueueCallbacks();
        
        // Create notification channel
        createNotificationChannel();
        
        // Acquire wake lock to ensure service keeps running
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        mWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                "AugmentOS:PhotoUploadWakeLock");
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
                startForeground(NOTIFICATION_ID, createNotification("Starting photo upload service..."));
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
        JSONObject stats = mPhotoQueueManager.getQueueStats();
        int totalCount = stats.optInt("totalCount", 0);
        int queuedCount = stats.optInt("queuedCount", 0);
        int uploadingCount = stats.optInt("uploadingCount", 0);
        int failedCount = stats.optInt("failedCount", 0);
        
        String statusContent;
        if (totalCount == 0) {
            statusContent = "No photos in queue";
        } else {
            statusContent = String.format("Queue: %d photos (%d waiting, %d in progress, %d failed)", 
                    totalCount, queuedCount, uploadingCount, failedCount);
        }
        
        // Create the notification
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Photo Upload Service")
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
     * Set up callbacks for the PhotoQueueManager
     */
    private void setupQueueCallbacks() {
        mPhotoQueueManager.setQueueCallback(new PhotoQueueManager.QueueCallback() {
            @Override
            public void onPhotoQueued(String requestId, String filePath) {
                Log.d(TAG, "Photo queued: " + requestId);
                updateNotification("Photo queued: " + requestId);
            }
            
            @Override
            public void onPhotoUploaded(String requestId, String url) {
                Log.d(TAG, "Photo uploaded: " + requestId + ", URL: " + url);
                mSuccessCount++;
                
                // Send status broadcast
                Intent statusIntent = new Intent(ACTION_UPLOAD_STATUS);
                statusIntent.putExtra(EXTRA_REQUEST_ID, requestId);
                statusIntent.putExtra(EXTRA_SUCCESS, true);
                statusIntent.putExtra(EXTRA_URL, url);
                sendBroadcast(statusIntent);
                
                updateNotification("Photo uploaded successfully");
            }
            
            @Override
            public void onPhotoUploadFailed(String requestId, String error) {
                Log.e(TAG, "Photo upload failed: " + requestId + ", error: " + error);
                mFailureCount++;
                
                // Send status broadcast
                Intent statusIntent = new Intent(ACTION_UPLOAD_STATUS);
                statusIntent.putExtra(EXTRA_REQUEST_ID, requestId);
                statusIntent.putExtra(EXTRA_SUCCESS, false);
                statusIntent.putExtra(EXTRA_ERROR, error);
                sendBroadcast(statusIntent);
                
                updateNotification("Photo upload failed: " + error);
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
        
        updateNotification("Photo upload service is running");
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
        // Only process if not already processing and there are queued photos
        if (mIsProcessing.compareAndSet(false, true)) {
            new Handler(Looper.getMainLooper()).post(() -> {
                updateNotification("Processing photo upload queue...");
            });
            
            // If there are failed uploads, retry them
            mPhotoQueueManager.retryFailedUploads(MAX_RETRY_COUNT);
            
            // Process the queue
            mPhotoQueueManager.processQueue();
            
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
        
        if (success) {
            String url = intent.getStringExtra(EXTRA_URL);
            Log.d(TAG, "Upload succeeded for request: " + requestId + ", URL: " + url);
            updateNotification("Photo uploaded successfully: " + requestId);
        } else {
            String error = intent.getStringExtra(EXTRA_ERROR);
            Log.e(TAG, "Upload failed for request: " + requestId + ", error: " + error);
            updateNotification("Photo upload failed: " + requestId + " (" + error + ")");
        }
    }
    
    /**
     * Get statistics about uploads and the queue
     */
    public JSONObject getStatistics() {
        JSONObject stats = new JSONObject();
        try {
            // Get queue stats
            JSONObject queueStats = mPhotoQueueManager.getQueueStats();
            
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
     * Get the photo queue manager instance
     */
    public PhotoQueueManager getPhotoQueueManager() {
        return mPhotoQueueManager;
    }
}