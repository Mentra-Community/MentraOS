package com.mentra.asg_client.service.gallery;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.preference.PreferenceManager;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
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
    private static final String PREF_AUTH_TOKEN = "core_token"; // Use same key as ConfigurationManager
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
    private final ICommunicationManager mCommunicationManager;
    private final SharedPreferences mPrefs;
    private final Handler mHandler;
    private final OkHttpClient mHttpClient;
    
    // Upload state
    private final AtomicBoolean mIsUploading = new AtomicBoolean(false);
    private final AtomicBoolean mIsPaused = new AtomicBoolean(false);
    private Call mCurrentCall;
    private String mCurrentFileName;
    private int mInitialTotalFiles = 0; // Track initial queue size for progress
    private int mCurrentBatchUploaded = 0; // Track files uploaded in current batch (not cumulative)
    
    // Callbacks
    public interface UploadCallback {
        void onProgress(String filename, int filesUploaded, int totalFiles);
        void onComplete(int filesUploaded, int filesFailed);
        void onError(String filename, String error);
    }
    
    private UploadCallback mCallback;
    
    public CloudGalleryUploader(Context context, FileManager fileManager, GalleryUploadQueue uploadQueue, ICommunicationManager communicationManager) {
        this.mContext = context;
        this.mFileManager = fileManager;
        this.mUploadQueue = uploadQueue;
        this.mCommunicationManager = communicationManager;
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
        Log.e(TAG, "🔴🔴🔴 START UPLOAD ENTRY POINT 🔴🔴🔴");
        try {
            Log.i(TAG, "🔵 startUpload() called - isUploading=" + mIsUploading.get() + ", isPaused=" + mIsPaused.get());
            
            if (mIsUploading.get()) {
                Log.w(TAG, "⚠️ Already uploading - returning early");
                return;
            }
            
            Log.i(TAG, "📋 Building upload queue...");
            // Build queue first (forced to ensure fresh state at upload time)
            mUploadQueue.buildQueue(true);
            mInitialTotalFiles = mUploadQueue.getTotalFiles();
            Log.i(TAG, "📋 Queue built - total files: " + mInitialTotalFiles);
        
        if (mInitialTotalFiles == 0) {
            Log.i(TAG, "📋 No files to upload - queue is empty");
            mIsUploading.set(false);
            if (mCallback != null) {
                mCallback.onComplete(0, 0);
            }
            return;
        }
        
        // Count photos vs videos for logging
        int photoCount = 0;
        int videoCount = 0;
        long totalSize = 0;
        // Note: We can't easily count here without accessing the queue internals
        // But we'll log it as we process each file
        
        mIsPaused.set(false);
        mIsUploading.set(true);
        mCurrentBatchUploaded = 0; // Reset counter for new batch
        
            Log.i(TAG, "═══════════════════════════════════════════════════════════");
            Log.i(TAG, "🚀 STARTING CLOUD GALLERY UPLOAD");
            Log.i(TAG, "═══════════════════════════════════════════════════════════");
            Log.i(TAG, "📊 Total files to upload: " + mInitialTotalFiles);
            Log.i(TAG, "═══════════════════════════════════════════════════════════");
            Log.i(TAG, "▶️ Calling processNextFile() to start processing...");
            processNextFile();
            Log.i(TAG, "▶️ processNextFile() returned");
        } catch (Exception e) {
            Log.e(TAG, "💥 Exception in startUpload()", e);
            mIsUploading.set(false);
        }
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
        try {
            Log.i(TAG, "🔄 processNextFile() called - isPaused=" + mIsPaused.get() + ", isUploading=" + mIsUploading.get());
            
            // Check if paused
            if (mIsPaused.get()) {
                Log.i(TAG, "⏸️ Upload paused - waiting for resume");
                return;
            }
            
            // Get next file from queue
            Log.i(TAG, "📋 Getting next file from queue...");
            FileManager.FileMetadata fileMetadata = mUploadQueue.getNextFile();
            Log.i(TAG, "📋 Got file from queue: " + (fileMetadata != null ? fileMetadata.getFileName() : "null"));
        
        if (fileMetadata == null) {
            // Queue complete
            mIsUploading.set(false);
            int failed = mUploadQueue.getFailedCount();
            
            Log.i(TAG, "");
            Log.i(TAG, "═══════════════════════════════════════════════════════════");
            Log.i(TAG, "✅ UPLOAD QUEUE COMPLETE");
            Log.i(TAG, "═══════════════════════════════════════════════════════════");
            Log.i(TAG, "📊 Upload Summary:");
            Log.i(TAG, "   ✅ Successfully uploaded: " + mCurrentBatchUploaded + " files");
            Log.i(TAG, "   ❌ Failed: " + failed + " files");
            Log.i(TAG, "   📦 Total processed: " + (mCurrentBatchUploaded + failed) + " files");
            if (mCurrentBatchUploaded + failed > 0) {
                Log.i(TAG, "   🎉 Success rate: " + (mCurrentBatchUploaded * 100 / (mCurrentBatchUploaded + failed)) + "%");
            }
            Log.i(TAG, "═══════════════════════════════════════════════════════════");
            Log.i(TAG, "");
            
            // Send gallery status update to phone after all uploads complete
            sendGalleryStatusUpdate();
            
            if (mCallback != null) {
                mCallback.onComplete(mCurrentBatchUploaded, failed);
            }
            
            // Reset for next sync
            mInitialTotalFiles = 0;
            mCurrentBatchUploaded = 0;
            return;
        }
        
        // Calculate current file number based on queue position
        // After getNextFile() is called, mCurrentIndex has been incremented, so it's 1-based
        int queueIndex = mUploadQueue.getCurrentIndex();
        int currentFileNumber = queueIndex; // Already 1-based after getNextFile() increments
        
        // Update total files in case queue changed (e.g., retried files added)
        int actualTotalFiles = mUploadQueue.getTotalFiles();
        if (actualTotalFiles != mInitialTotalFiles) {
            Log.d(TAG, "📊 Queue size changed: " + mInitialTotalFiles + " -> " + actualTotalFiles);
            mInitialTotalFiles = actualTotalFiles;
        }
        
        int failed = mUploadQueue.getFailedCount();
        
        // Get the actual file
        Log.d(TAG, "📁 Looking for file: " + fileMetadata.getFileName());
        File file = mFileManager.getFile(mFileManager.getDefaultPackageName(), fileMetadata.getFileName());
        if (file == null || !file.exists()) {
            Log.e(TAG, "❌ [" + currentFileNumber + "/" + mInitialTotalFiles + "] File not found: " + fileMetadata.getFileName());
            Log.e(TAG, "   File path: " + (file != null ? file.getAbsolutePath() : "null"));
            mUploadQueue.markAsFailed(fileMetadata.getFileName(), "File not found");
            processNextFile(); // Skip to next
            return;
        }
        Log.i(TAG, "✅ File found: " + file.getAbsolutePath() + " (" + formatBytes(file.length()) + ")");
        
        mCurrentFileName = fileMetadata.getFileName();
        
        // Determine if video or image
        boolean isVideo = isVideoFile(fileMetadata.getFileName());
        
        Log.i(TAG, "───────────────────────────────────────────────────────────────");
        Log.i(TAG, "📤 [" + currentFileNumber + "/" + mInitialTotalFiles + "] Processing: " + fileMetadata.getFileName());
        Log.i(TAG, "   Type: " + (isVideo ? "VIDEO" : "PHOTO"));
        Log.i(TAG, "   Size: " + formatBytes(fileMetadata.getFileSize()));
        Log.i(TAG, "   Progress: " + mCurrentBatchUploaded + " uploaded, " + failed + " failed");
        Log.i(TAG, "───────────────────────────────────────────────────────────────");
        
            if (isVideo) {
                Log.i(TAG, "▶️ Calling uploadVideo()...");
                uploadVideo(file, fileMetadata);
            } else {
                Log.i(TAG, "▶️ Calling uploadImage()...");
                uploadImage(file, fileMetadata);
            }
            Log.i(TAG, "▶️ uploadImage/uploadVideo() returned");
        } catch (Exception e) {
            Log.e(TAG, "💥 Exception in processNextFile()", e);
        }
    }
    
    /**
     * Upload image directly via multipart form data
     */
    private void uploadImage(File imageFile, FileManager.FileMetadata metadata) {
        // Use queue index for accurate file number (already 1-based after getNextFile())
        int currentFileNumber = mUploadQueue.getCurrentIndex();
        int uploaded = mUploadQueue.getUploadedCount();
        
        Log.i(TAG, "📸 [" + currentFileNumber + "/" + mInitialTotalFiles + "] Starting image upload: " + metadata.getFileName());
        Log.d(TAG, "   📏 File size: " + formatBytes(metadata.getFileSize()));
        Log.d(TAG, "   📍 Upload URL: " + ServerConfigUtil.getServerBaseUrl(mContext) + "/api/client/asg/gallery/upload");
        
        // Check size limit
        if (metadata.getFileSize() > MAX_IMAGE_SIZE) {
            Log.e(TAG, "❌ [" + currentFileNumber + "/" + mInitialTotalFiles + "] Image too large: " + formatBytes(metadata.getFileSize()) + " (max: " + formatBytes(MAX_IMAGE_SIZE) + ")");
            mUploadQueue.markAsFailed(metadata.getFileName(), "File too large");
            processNextFile();
            return;
        }
        
        try {
            // Get JWT token
            String token = mPrefs.getString(PREF_AUTH_TOKEN, null);
            if (token == null || token.isEmpty()) {
                Log.e(TAG, "❌ [" + currentFileNumber + "/" + mInitialTotalFiles + "] No auth token available");
                Log.e(TAG, "   🔴 Upload cannot proceed without JWT token from mobile app");
                Log.e(TAG, "   💡 Token should be sent via BLE command 'auth_token' from mobile app");
                Log.e(TAG, "   ⏸️ Pausing upload - will retry when token is available");
                mUploadQueue.markAsFailed(metadata.getFileName(), "No auth token");
                pauseUpload(); // Pause entire upload until token available
                return;
            }
            
            Log.d(TAG, "   🔐 Auth token found (length: " + token.length() + " chars)");
            
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
            long uploadStartTime = System.currentTimeMillis();
            Log.d(TAG, "   ⏳ Sending HTTP request...");
            
            mCurrentCall = mHttpClient.newCall(request);
            mCurrentCall.enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    int currentFileNumber = mUploadQueue.getCurrentIndex();
                    if (call.isCanceled()) {
                        Log.d(TAG, "⏸️ [" + currentFileNumber + "/" + mInitialTotalFiles + "] Upload cancelled: " + metadata.getFileName());
                        return;
                    }
                    
                    int uploaded = mUploadQueue.getUploadedCount();
                    long uploadDuration = System.currentTimeMillis() - uploadStartTime;
                    Log.e(TAG, "❌ [" + currentFileNumber + "/" + mInitialTotalFiles + "] Upload failed: " + metadata.getFileName());
                    Log.e(TAG, "   ⏱️ Duration: " + (uploadDuration / 1000.0) + "s");
                    Log.e(TAG, "   🔴 Error: " + e.getMessage());
                    handleUploadFailure(metadata.getFileName(), e.getMessage());
                }
                
                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    mCurrentCall = null;
                    long uploadDuration = System.currentTimeMillis() - uploadStartTime;
                    int uploadedBefore = mUploadQueue.getUploadedCount();
                    
                    if (response.isSuccessful()) {
                        mUploadQueue.markAsUploaded(metadata.getFileName());
                        mCurrentBatchUploaded++; // Increment current batch counter
                        int currentFileNumber = mUploadQueue.getCurrentIndex();
                        int percent = mInitialTotalFiles > 0 ? (mCurrentBatchUploaded * 100 / mInitialTotalFiles) : 0;
                        
                        Log.i(TAG, "✅ [" + currentFileNumber + "/" + mInitialTotalFiles + "] Upload successful: " + metadata.getFileName());
                        Log.i(TAG, "   ⏱️ Duration: " + (uploadDuration / 1000.0) + "s");
                        Log.i(TAG, "   📊 Progress: " + mCurrentBatchUploaded + "/" + mInitialTotalFiles + " (" + percent + "%)");
                        Log.i(TAG, "   📈 Speed: " + formatBytes(metadata.getFileSize() * 1000 / (uploadDuration > 0 ? uploadDuration : 1)) + "/s");
                        
                        // Delete file from glasses after successful upload
                        String packageName = mFileManager.getDefaultPackageName();
                        FileManager.FileOperationResult deleteResult = 
                            mFileManager.deleteFile(packageName, metadata.getFileName());
                        
                        if (deleteResult.isSuccess()) {
                            Log.i(TAG, "   🗑️ Deleted from glasses: " + metadata.getFileName());
                        } else {
                            Log.w(TAG, "   ⚠️ Failed to delete from glasses: " + metadata.getFileName() + " - " + deleteResult.getMessage());
                        }
                        
                        // Notify mobile app that a picture was uploaded to cloud
                        sendCloudUploadNotification(metadata.getFileName());
                        
                        if (mCallback != null) {
                            mHandler.post(() -> mCallback.onProgress(
                                metadata.getFileName(),
                                mCurrentBatchUploaded,
                                mInitialTotalFiles
                            ));
                        }
                        
                        // Process next file
                        mHandler.post(() -> processNextFile());
                    } else if (response.code() == 401) {
                        // Auth error - need new token
                        int currentFileNumber = mUploadQueue.getCurrentIndex();
                        int uploaded = mUploadQueue.getUploadedCount();
                        Log.e(TAG, "🔐 [" + currentFileNumber + "/" + mInitialTotalFiles + "] Authentication error - token may be expired");
                        Log.e(TAG, "   ⏱️ Duration: " + (uploadDuration / 1000.0) + "s");
                        handleAuthError(metadata.getFileName());
                    } else {
                        int currentFileNumber = mUploadQueue.getCurrentIndex();
                        int uploaded = mUploadQueue.getUploadedCount();
                        String errorBody = response.body() != null ? response.body().string() : "Unknown error";
                        Log.e(TAG, "❌ [" + currentFileNumber + "/" + mInitialTotalFiles + "] Upload failed with HTTP " + response.code());
                        Log.e(TAG, "   ⏱️ Duration: " + (uploadDuration / 1000.0) + "s");
                        Log.e(TAG, "   🔴 Error: " + errorBody);
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
    
    /**
     * Send notification to mobile app that a picture was uploaded to cloud
     */
    private void sendCloudUploadNotification(String filename) {
        if (mCommunicationManager == null) {
            Log.w(TAG, "⚠️ Cannot send cloud upload notification - CommunicationManager not available");
            return;
        }
        
        try {
            JSONObject notification = new JSONObject();
            notification.put("type", "cloud_upload_complete");
            notification.put("filename", filename);
            notification.put("timestamp", System.currentTimeMillis());
            
            boolean sent = mCommunicationManager.sendBluetoothResponse(notification);
            if (sent) {
                Log.d(TAG, "📱 Notified mobile app of cloud upload: " + filename);
            } else {
                Log.w(TAG, "⚠️ Failed to notify mobile app of cloud upload: " + filename);
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating cloud upload notification", e);
        }
    }
    
    /**
     * Send full gallery status update to phone after cloud uploads complete.
     * Uses GalleryStatusHelper to build consistent gallery status response.
     */
    private void sendGalleryStatusUpdate() {
        if (mCommunicationManager == null) {
            Log.w(TAG, "⚠️ Cannot send gallery status - CommunicationManager not available");
            return;
        }
        
        if (mFileManager == null) {
            Log.w(TAG, "⚠️ Cannot send gallery status - FileManager not available");
            return;
        }
        
        try {
            Log.i(TAG, "📊 Sending gallery status update to phone after cloud upload completion");
            
            // Build gallery status using shared utility
            JSONObject galleryStatus = com.mentra.asg_client.utils.GalleryStatusHelper.buildGalleryStatus(mFileManager);
            
            boolean sent = mCommunicationManager.sendBluetoothResponse(galleryStatus);
            if (sent) {
                Log.i(TAG, "📱 Gallery status sent to phone: " + galleryStatus.optInt("photos") + " photos, " + 
                          galleryStatus.optInt("videos") + " videos remaining");
            } else {
                Log.w(TAG, "⚠️ Failed to send gallery status to phone");
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending gallery status update", e);
        }
    }
}
