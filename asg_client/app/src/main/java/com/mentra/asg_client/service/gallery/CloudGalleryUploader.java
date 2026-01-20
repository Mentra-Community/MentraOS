package com.mentra.asg_client.service.gallery;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.preference.PreferenceManager;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.utils.ServerConfigUtil;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Cloud Gallery Uploader
 * Handles HTTP uploads of photos and videos to MentraOS Cloud
 * Supports pause/resume for conflict management with WiFi Direct sync
 */
public class CloudGalleryUploader {
    private static final String TAG = "CloudGalleryUploader";
    
    // SharedPreferences keys
    private static final String PREF_AUTH_TOKEN = "auth_token";
    private static final String PREF_UPLOAD_STATE = "cloud_upload_state";
    
    // Upload limits
    private static final int MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
    private static final long MAX_VIDEO_SIZE = 2L * 1024 * 1024 * 1024; // 2GB
    private static final int MAX_RETRY_ATTEMPTS = 3;
    
    // Timeouts
    private static final int CONNECT_TIMEOUT_SEC = 30;
    private static final int WRITE_TIMEOUT_SEC = 120; // 2 minutes for large files
    private static final int READ_TIMEOUT_SEC = 30;
    
    private final Context mContext;
    private final FileManager mFileManager;
    private final GalleryUploadQueue mUploadQueue;
    private final SharedPreferences mPrefs;
    private final Handler mHandler;
    private final OkHttpClient mHttpClient;
    
    // Upload state
    private final AtomicBoolean mIsUploading = new AtomicBoolean(false);
    private final AtomicBoolean mIsPaused = new AtomicBoolean(false);
    private Call mCurrentCall;
    private String mCurrentFileName;
    
    // Callbacks
    public interface UploadCallback {
        void onProgress(String filename, int filesUploaded, int totalFiles);
        void onComplete(int filesUploaded, int filesFailed);
        void onError(String filename, String error);
    }
    
    private UploadCallback mCallback;
    
    public CloudGalleryUploader(Context context, FileManager fileManager, GalleryUploadQueue uploadQueue) {
        this.mContext = context;
        this.mFileManager = fileManager;
        this.mUploadQueue = uploadQueue;
        this.mPrefs = PreferenceManager.getDefaultSharedPreferences(context);
        this.mHandler = new Handler(Looper.getMainLooper());
        
        // Create HTTP client with appropriate timeouts
        this.mHttpClient = new OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
            .writeTimeout(WRITE_TIMEOUT_SEC, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
            .build();
        
        Log.i(TAG, "☁️ CloudGalleryUploader initialized");
    }
    
    /**
     * Set upload progress callback
     */
    public void setCallback(UploadCallback callback) {
        this.mCallback = callback;
    }
    
    /**
     * Start uploading files from queue
     */
    public void startUpload() {
        if (mIsUploading.get()) {
            Log.d(TAG, "Already uploading");
            return;
        }
        
        mIsPaused.set(false);
        mIsUploading.set(true);
        
        Log.i(TAG, "🚀 Starting cloud upload");
        processNextFile();
    }
    
    /**
     * Pause the current upload
     */
    public void pauseUpload() {
        Log.i(TAG, "⏸️ Pausing cloud upload");
        mIsPaused.set(true);
        
        // Cancel current HTTP request if any
        if (mCurrentCall != null) {
            mCurrentCall.cancel();
            mCurrentCall = null;
        }
    }
    
    /**
     * Resume upload after pause
     */
    public void resumeUpload() {
        if (!mIsUploading.get()) {
            Log.w(TAG, "Cannot resume - no upload in progress");
            return;
        }
        
        Log.i(TAG, "▶️ Resuming cloud upload");
        mIsPaused.set(false);
        processNextFile();
    }
    
    /**
     * Wait for upload to pause (with timeout)
     * Returns true if successfully paused, false if timeout
     */
    public boolean waitForPause(long timeoutMs) {
        long startTime = System.currentTimeMillis();
        
        while (mIsUploading.get() && !mIsPaused.get()) {
            if (System.currentTimeMillis() - startTime > timeoutMs) {
                Log.w(TAG, "Timeout waiting for pause");
                return false;
            }
            
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                return false;
            }
        }
        
        return mIsPaused.get();
    }
    
    /**
     * Check if currently uploading
     */
    public boolean isUploading() {
        return mIsUploading.get();
    }
    
    /**
     * Check if paused
     */
    public boolean isPaused() {
        return mIsPaused.get();
    }
    
    /**
     * Process next file in queue
     */
    private void processNextFile() {
        // Check if paused
        if (mIsPaused.get()) {
            Log.d(TAG, "Upload paused - waiting for resume");
            return;
        }
        
        // Get next file from queue
        FileManager.FileMetadata fileMetadata = mUploadQueue.getNextFile();
        
        if (fileMetadata == null) {
            // Queue complete
            Log.i(TAG, "✅ All files uploaded");
            mIsUploading.set(false);
            
            if (mCallback != null) {
                int uploaded = mUploadQueue.getUploadedCount();
                int failed = mUploadQueue.getFailedCount();
                mCallback.onComplete(uploaded, failed);
            }
            return;
        }
        
        // Get the actual file
        File file = mFileManager.getFile(mFileManager.getDefaultPackageName(), fileMetadata.getFileName());
        if (file == null || !file.exists()) {
            Log.e(TAG, "File not found: " + fileMetadata.getFileName());
            mUploadQueue.markAsFailed(fileMetadata.getFileName(), "File not found");
            processNextFile(); // Skip to next
            return;
        }
        
        mCurrentFileName = fileMetadata.getFileName();
        
        // Determine if video or image
        boolean isVideo = isVideoFile(fileMetadata.getFileName());
        
        if (isVideo) {
            uploadVideo(file, fileMetadata);
        } else {
            uploadImage(file, fileMetadata);
        }
    }
    
    /**
     * Upload image directly via multipart form data
     */
    private void uploadImage(File imageFile, FileManager.FileMetadata metadata) {
        Log.i(TAG, "📤 Uploading image: " + metadata.getFileName() + " (" + formatBytes(metadata.getFileSize()) + ")");
        
        // Check size limit
        if (metadata.getFileSize() > MAX_IMAGE_SIZE) {
            Log.e(TAG, "Image too large: " + metadata.getFileSize() + " bytes (max: " + MAX_IMAGE_SIZE + ")");
            mUploadQueue.markAsFailed(metadata.getFileName(), "File too large");
            processNextFile();
            return;
        }
        
        try {
            // Get JWT token
            String token = mPrefs.getString(PREF_AUTH_TOKEN, null);
            if (token == null || token.isEmpty()) {
                Log.e(TAG, "No auth token available");
                mUploadQueue.markAsFailed(metadata.getFileName(), "No auth token");
                pauseUpload(); // Pause entire upload until token available
                return;
            }
            
            // Build URL
            String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
            String uploadUrl = baseUrl + "/api/client/asg/gallery/upload";
            
            // Determine MIME type
            String mimeType = getMimeType(metadata.getFileName());
            
            // Build multipart request
            MultipartBody body = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", metadata.getFileName(),
                    RequestBody.create(imageFile, MediaType.parse(mimeType)))
                .addFormDataPart("filename", metadata.getFileName())
                .addFormDataPart("capturedAt", String.valueOf(metadata.getLastModified()))
                .addFormDataPart("deviceId", getDeviceId())
                .build();
            
            Request request = new Request.Builder()
                .url(uploadUrl)
                .addHeader("Authorization", "Bearer " + token)
                .post(body)
                .build();
            
            // Execute async
            mCurrentCall = mHttpClient.newCall(request);
            mCurrentCall.enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    if (call.isCanceled()) {
                        Log.d(TAG, "Upload cancelled: " + metadata.getFileName());
                        return;
                    }
                    
                    Log.e(TAG, "Upload failed: " + metadata.getFileName(), e);
                    handleUploadFailure(metadata.getFileName(), e.getMessage());
                }
                
                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    mCurrentCall = null;
                    
                    if (response.isSuccessful()) {
                        Log.i(TAG, "✅ Upload successful: " + metadata.getFileName());
                        mUploadQueue.markAsUploaded(metadata.getFileName());
                        
                        if (mCallback != null) {
                            mHandler.post(() -> mCallback.onProgress(
                                metadata.getFileName(),
                                mUploadQueue.getUploadedCount(),
                                mUploadQueue.getTotalFiles()
                            ));
                        }
                        
                        // Process next file
                        mHandler.post(() -> processNextFile());
                    } else if (response.code() == 401) {
                        // Auth error - need new token
                        Log.e(TAG, "Authentication error - token may be expired");
                        handleAuthError(metadata.getFileName());
                    } else {
                        String errorBody = response.body() != null ? response.body().string() : "Unknown error";
                        Log.e(TAG, "Upload failed with code " + response.code() + ": " + errorBody);
                        handleUploadFailure(metadata.getFileName(), "HTTP " + response.code());
                    }
                    
                    response.close();
                }
            });
            
        } catch (Exception e) {
            Log.e(TAG, "Error preparing upload", e);
            handleUploadFailure(metadata.getFileName(), e.getMessage());
        }
    }
    
    /**
     * Upload video via presigned URL (two-phase upload)
     */
    private void uploadVideo(File videoFile, FileManager.FileMetadata metadata) {
        Log.i(TAG, "📤 Uploading video: " + metadata.getFileName() + " (" + formatBytes(metadata.getFileSize()) + ")");
        
        // Check size limit
        if (metadata.getFileSize() > MAX_VIDEO_SIZE) {
            Log.e(TAG, "Video too large: " + metadata.getFileSize() + " bytes (max: " + MAX_VIDEO_SIZE + ")");
            mUploadQueue.markAsFailed(metadata.getFileName(), "File too large");
            processNextFile();
            return;
        }
        
        // TODO: Implement video upload via presigned URL
        // Phase 1: Request presigned URL from POST /api/client/asg/gallery/video-upload-url
        // Phase 2: Upload directly to R2/OSS using presigned URL
        // Phase 3: Confirm completion via POST /api/client/asg/gallery/video-upload-complete
        
        // For now, mark as not implemented
        Log.w(TAG, "⚠️ Video upload not yet implemented - skipping " + metadata.getFileName());
        mUploadQueue.markAsFailed(metadata.getFileName(), "Video upload not yet implemented");
        processNextFile();
    }
    
    /**
     * Handle upload failure with retry logic
     */
    private void handleUploadFailure(String filename, String error) {
        int attempts = mUploadQueue.getAttempts(filename);
        
        if (attempts < MAX_RETRY_ATTEMPTS) {
            // Retry with exponential backoff
            long delayMs = (long) Math.pow(2, attempts) * 1000; // 1s, 2s, 4s
            Log.w(TAG, "Retrying upload in " + delayMs + "ms (attempt " + (attempts + 1) + "/" + MAX_RETRY_ATTEMPTS + ")");
            
            mUploadQueue.incrementAttempts(filename);
            
            mHandler.postDelayed(() -> {
                if (!mIsPaused.get()) {
                    processNextFile();
                }
            }, delayMs);
        } else {
            // Max retries exceeded
            Log.e(TAG, "❌ Max retries exceeded for " + filename);
            mUploadQueue.markAsFailed(filename, error);
            
            if (mCallback != null) {
                mHandler.post(() -> mCallback.onError(filename, error));
            }
            
            // Continue with next file
            processNextFile();
        }
    }
    
    /**
     * Handle authentication error (token expired)
     */
    private void handleAuthError(String filename) {
        Log.e(TAG, "🔐 Authentication error - pausing upload");
        
        // Pause upload and wait for new token
        mIsPaused.set(true);
        mIsUploading.set(false);
        
        // TODO: Send BLE command to mobile requesting new token
        // For now, just log and stop
        Log.e(TAG, "Need to request new auth token from mobile");
        
        if (mCallback != null) {
            mHandler.post(() -> mCallback.onError(filename, "Authentication failed - token may be expired"));
        }
    }
    
    /**
     * Get JWT token from SharedPreferences
     */
    private String getAuthToken() {
        return mPrefs.getString(PREF_AUTH_TOKEN, null);
    }
    
    /**
     * Get device ID for tracking uploads
     */
    private String getDeviceId() {
        // Use Android ID as device identifier
        return android.provider.Settings.Secure.getString(
            mContext.getContentResolver(),
            android.provider.Settings.Secure.ANDROID_ID
        );
    }
    
    /**
     * Determine MIME type from filename
     */
    private String getMimeType(String filename) {
        String lower = filename.toLowerCase();
        
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return "image/jpeg";
        } else if (lower.endsWith(".png")) {
            return "image/png";
        } else if (lower.endsWith(".heic") || lower.endsWith(".heif")) {
            return "image/heic";
        } else if (lower.endsWith(".mp4")) {
            return "video/mp4";
        } else if (lower.endsWith(".mov")) {
            return "video/quicktime";
        }
        
        // Default
        return "application/octet-stream";
    }
    
    /**
     * Check if file is a video
     */
    private boolean isVideoFile(String filename) {
        String lower = filename.toLowerCase();
        return lower.endsWith(".mp4") || 
               lower.endsWith(".mov") || 
               lower.endsWith(".avi") ||
               lower.endsWith(".mkv") ||
               lower.endsWith(".webm") ||
               lower.endsWith(".3gp");
    }
    
    /**
     * Format bytes to human readable string
     */
    private String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        if (bytes < 1024 * 1024 * 1024) return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
        return String.format("%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }
}
