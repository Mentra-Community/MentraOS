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

import java.io.FileInputStream;

import okio.BufferedSink;
import okio.Okio;
import okio.Source;

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
     * Request permission from cloud to start upload
     * Returns true if allowed, false if denied or unreachable
     */
    public boolean requestUploadPermission() {
        String token = getAuthToken();
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "⚠️ Cannot request upload permission - no auth token");
            return false;
        }
        
        String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
        String endpoint = baseUrl + "/api/client/asg/gallery/request-upload";
        
        Log.d(TAG, "🔐 Requesting upload permission from: " + endpoint);
        Log.d(TAG, "   Token length: " + (token != null ? token.length() : 0) + " chars");
        
        try {
            Request request = new Request.Builder()
                .url(endpoint)
                .addHeader("Authorization", "Bearer " + token)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create("{}", MediaType.parse("application/json")))
                .build();
            
            // Use synchronous call with timeout for permission check
            OkHttpClient permissionClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .writeTimeout(10, TimeUnit.SECONDS)
                .build();
            
            Log.d(TAG, "   Executing permission request...");
            try (Response response = permissionClient.newCall(request).execute()) {
                Log.d(TAG, "   Response code: " + response.code());
                if (response.isSuccessful()) {
                    String responseBody = response.body() != null ? response.body().string() : "{}";
                    Log.d(TAG, "   Response body: " + responseBody);
                    JSONObject jsonResponse = new JSONObject(responseBody);
                    
                    if (jsonResponse.has("success") && jsonResponse.getBoolean("success")) {
                        if (jsonResponse.has("data")) {
                            JSONObject data = jsonResponse.getJSONObject("data");
                            boolean allowed = data.getBoolean("allowed");
                            
                            if (allowed) {
                                Log.i(TAG, "✅ Upload permission granted by cloud");
                                return true;
                            } else {
                                String reason = data.has("reason") ? data.getString("reason") : "Unknown reason";
                                Log.w(TAG, "❌ Upload permission denied by cloud: " + reason);
                                return false;
                            }
                        }
                    }
                    
                    Log.w(TAG, "⚠️ Invalid response format from permission endpoint");
                    return false;
                } else {
                    Log.w(TAG, "⚠️ Cloud returned error for permission request: " + response.code());
                    // Treat error as denial (fail-safe)
                    return false;
                }
            }
        } catch (java.net.SocketTimeoutException e) {
            Log.w(TAG, "⏱️ Upload permission request timed out (cloud unreachable or slow)");
            // Treat timeout as denial (fail-safe - block operation if cloud unreachable)
            return false;
        } catch (java.net.UnknownHostException e) {
            Log.w(TAG, "🌐 Upload permission request failed - unknown host (cloud unreachable): " + baseUrl);
            // Treat unknown host as denial (fail-safe)
            return false;
        } catch (java.net.ConnectException e) {
            String errorMsg = e.getMessage();
            if (errorMsg == null || errorMsg.isEmpty()) {
                errorMsg = "Connection refused";
            }
            Log.w(TAG, "📡 Upload permission request failed - connection refused: " + errorMsg);
            // Treat connection error as denial (fail-safe)
            return false;
        } catch (java.io.IOException e) {
            String errorMsg = e.getMessage();
            if (errorMsg == null || errorMsg.isEmpty()) {
                errorMsg = e.getClass().getSimpleName();
            }
            Log.w(TAG, "📡 Upload permission request failed - network error: " + errorMsg);
            // Treat network error as denial (fail-safe)
            return false;
        } catch (org.json.JSONException e) {
            Log.e(TAG, "💥 Error parsing permission response: " + e.getMessage());
            // Treat parse error as denial (fail-safe)
            return false;
        } catch (Exception e) {
            String errorMsg = e.getMessage();
            if (errorMsg == null || errorMsg.isEmpty()) {
                errorMsg = e.getClass().getSimpleName();
            }
            Log.e(TAG, "💥 Unexpected error requesting upload permission: " + errorMsg, e);
            // Treat any exception as denial (fail-safe - block operation if cloud unreachable)
            return false;
        }
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
            
            // Request permission from cloud before starting upload (must run on background thread)
            Log.i(TAG, "🔐 Requesting upload permission from cloud...");
            
            // Run permission check on background thread to avoid NetworkOnMainThreadException
            new Thread(() -> {
                boolean permissionGranted = requestUploadPermission();
                
                // Post continuation to main thread handler
                mHandler.post(() -> {
                    if (!permissionGranted) {
                        Log.w(TAG, "❌ Upload permission denied or cloud unreachable - blocking upload");
                        mIsUploading.set(false);
                        if (mCallback != null) {
                            mCallback.onError("", "Upload permission denied by cloud");
                        }
                        return;
                    }
                    
                    // Permission granted - continue with upload
                    continueStartUpload();
                });
            }).start();
            
            return; // Exit early, continuation will happen in handler
        } catch (Exception e) {
            Log.e(TAG, "💥 Exception in startUpload()", e);
            mIsUploading.set(false);
        }
    }
    
    /**
     * Continue upload after permission is granted (runs on main thread)
     */
    private void continueStartUpload() {
        try {
            
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
            
            // Notify cloud that upload batch has started
            notifyCloudUploadStarted(mInitialTotalFiles);
            
            Log.i(TAG, "▶️ Calling processNextFile() to start processing...");
            processNextFile();
            Log.i(TAG, "▶️ processNextFile() returned");
        } catch (Exception e) {
            Log.e(TAG, "💥 Exception in continueStartUpload()", e);
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
     * Cancel the current upload completely (stops upload and clears state)
     */
    public void cancelUpload() {
        Log.i(TAG, "🛑 Cancelling cloud upload");
        
        // Set flags first to stop any processing loops
        mIsPaused.set(true);
        mIsUploading.set(false);
        
        // Cancel current HTTP request if any (this will stop the active upload immediately)
        if (mCurrentCall != null) {
            Log.i(TAG, "🛑 Cancelling active HTTP request");
            mCurrentCall.cancel();
            mCurrentCall = null;
        }
        
        // Clear current file name
        mCurrentFileName = null;
        
        // Reset progress tracking
        mInitialTotalFiles = 0;
        mCurrentBatchUploaded = 0;
        
        // Notify cloud that upload was cancelled (runs on background thread to avoid NetworkOnMainThreadException)
        new Thread(() -> {
            notifyCloudUploadCancelled();
        }).start();
        
        Log.i(TAG, "✅ Cloud upload cancelled - all state cleared");
    }
    
    /**
     * Notify cloud that upload was cancelled
     */
    private void notifyCloudUploadCancelled() {
        String token = getAuthToken();
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "⚠️ Cannot notify cloud of cancellation - no auth token");
            return;
        }
        
        String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
        String endpoint = baseUrl + "/api/client/asg/gallery/cancel-upload";
        
        try {
            Request request = new Request.Builder()
                .url(endpoint)
                .addHeader("Authorization", "Bearer " + token)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create("{}", MediaType.parse("application/json")))
                .build();
            
            Response response = mHttpClient.newCall(request).execute();
            if (response.isSuccessful()) {
                Log.i(TAG, "✅ Notified cloud that upload was cancelled");
            } else {
                Log.w(TAG, "⚠️ Cloud returned error for cancel-upload: " + response.code());
            }
            response.close();
        } catch (Exception e) {
            Log.w(TAG, "⚠️ Failed to notify cloud of upload cancellation: " + e.getMessage());
            // Non-fatal - upload is cancelled locally regardless
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
            
            // Check if upload was cancelled or paused
            if (!mIsUploading.get()) {
                Log.i(TAG, "🛑 Upload cancelled - stopping processing");
                return;
            }
            
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
            
            // Notify cloud that upload batch is complete - cloud will send WebSocket event to phone
            notifyCloudUploadComplete();
            
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
                    // Check if upload was cancelled - don't process if cancelled
                    if (!mIsUploading.get()) {
                        Log.d(TAG, "🛑 Upload cancelled - ignoring failure callback");
                        return;
                    }

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
                    // Check if upload was cancelled - don't process if cancelled
                    if (!mIsUploading.get()) {
                        Log.d(TAG, "🛑 Upload cancelled - ignoring response callback");
                        response.close(); // Close response to free resources
                        return;
                    }
                    
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
                        
                        // Send updated gallery status to phone after each successful upload
                        // This ensures the phone knows the current gallery state after each file is deleted
                        mHandler.post(() -> sendGalleryStatusUpdate());
                        
                        // Cloud automatically sends WebSocket event to phone when file uploads
                        // This provides real-time upload progress via WebSocket
                        
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
     * Upload video via presigned URL (four-phase upload)
     * Phase 1: Request presigned URL from backend (get uploadId)
     * Phase 1b: Upload thumbnail using uploadId (synchronous, before video)
     * Phase 2: Upload video directly to storage (R2/OSS) via presigned URL
     * Phase 3: Confirm upload completion with backend
     */
    private void uploadVideo(File videoFile, FileManager.FileMetadata metadata) {
        int currentFileNumber = mUploadQueue.getCurrentIndex();
        long uploadStartTime = System.currentTimeMillis();
        
        Log.i(TAG, "▶️ ═══════════════════════════════════════════════════════════");
        Log.i(TAG, "▶️ [" + currentFileNumber + "/" + mInitialTotalFiles + "] VIDEO UPLOAD: " + metadata.getFileName());
        Log.i(TAG, "▶️ ═══════════════════════════════════════════════════════════");
        Log.i(TAG, "   📁 Size: " + formatBytes(metadata.getFileSize()));
        
        // Check size limit
        if (metadata.getFileSize() > MAX_VIDEO_SIZE) {
            Log.e(TAG, "❌ Video too large: " + formatBytes(metadata.getFileSize()) + " (max: " + formatBytes(MAX_VIDEO_SIZE) + ")");
            mUploadQueue.markAsFailed(metadata.getFileName(), "File too large");
            processNextFile();
            return;
        }
        
        // Get auth token
        String token = getAuthToken();
        if (token == null || token.isEmpty()) {
            Log.e(TAG, "❌ No auth token available for video upload");
            handleAuthError(metadata.getFileName());
            return;
        }
        
        Log.d(TAG, "   🔐 Auth token found (length: " + token.length() + " chars)");
        
        // Build URL for Phase 1: Request presigned URL
        String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
        String videoUploadUrlEndpoint = baseUrl + "/api/client/asg/gallery/video-upload-url";
        
        // Build request body for Phase 1
        String mimeType = getMimeType(metadata.getFileName());
        JSONObject requestBody = new JSONObject();
        try {
            requestBody.put("filename", metadata.getFileName());
            requestBody.put("mimeType", mimeType);
            requestBody.put("sizeBytes", metadata.getFileSize());
            requestBody.put("capturedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
                .format(new java.util.Date(metadata.getLastModified())));
            requestBody.put("deviceId", getDeviceId());
        } catch (JSONException e) {
            Log.e(TAG, "❌ Error building video upload request", e);
            handleUploadFailure(metadata.getFileName(), "Failed to build request");
            return;
        }
        
        Log.i(TAG, "   📡 Phase 1: Requesting presigned URL...");
        
        // Phase 1: Request presigned URL
        Request phase1Request = new Request.Builder()
            .url(videoUploadUrlEndpoint)
            .addHeader("Authorization", "Bearer " + token)
            .addHeader("Content-Type", "application/json")
            .post(RequestBody.create(requestBody.toString(), MediaType.parse("application/json")))
            .build();
        
        mCurrentCall = mHttpClient.newCall(phase1Request);
        mCurrentCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                if (call.isCanceled()) {
                    Log.d(TAG, "⏸️ Video upload cancelled: " + metadata.getFileName());
                    return;
                }
                Log.e(TAG, "❌ Phase 1 failed: " + e.getMessage());
                handleUploadFailure(metadata.getFileName(), "Failed to get upload URL: " + e.getMessage());
            }
            
            @Override
            public void onResponse(Call call, Response response) throws IOException {
                mCurrentCall = null;
                
                if (!response.isSuccessful()) {
                    String errorBody = response.body() != null ? response.body().string() : "Unknown error";
                    Log.e(TAG, "❌ Phase 1 HTTP " + response.code() + ": " + errorBody);
                    
                    if (response.code() == 401) {
                        handleAuthError(metadata.getFileName());
                    } else {
                        handleUploadFailure(metadata.getFileName(), "HTTP " + response.code());
                    }
                    response.close();
                    return;
                }
                
                try {
                    String responseBody = response.body().string();
                    response.close();
                    
                    JSONObject json = new JSONObject(responseBody);
                    if (!json.optBoolean("success", false)) {
                        Log.e(TAG, "❌ Phase 1 returned success=false");
                        handleUploadFailure(metadata.getFileName(), "Server returned error");
                        return;
                    }
                    
                    JSONObject data = json.getJSONObject("data");
                    String uploadId = data.getString("id");
                    String presignedUrl = data.getString("uploadUrl");
                    
                    Log.i(TAG, "   ✅ Phase 1 complete - got presigned URL (id: " + uploadId + ")");
                    
                    // Phase 1b: Upload thumbnail BEFORE video (synchronous)
                    // This ensures mobile app has thumbnail when it polls for pending items
                    uploadVideoThumbnailSync(videoFile, uploadId, token);
                    
                    // Phase 2: Upload video to presigned URL
                    uploadVideoToPresignedUrl(videoFile, metadata, presignedUrl, uploadId, uploadStartTime);
                    
                } catch (JSONException e) {
                    Log.e(TAG, "❌ Phase 1 JSON parse error", e);
                    handleUploadFailure(metadata.getFileName(), "Invalid server response");
                }
            }
        });
    }
    
    /**
     * Phase 2: Upload video bytes directly to presigned URL (streaming)
     */
    private void uploadVideoToPresignedUrl(File videoFile, FileManager.FileMetadata metadata, 
                                            String presignedUrl, String uploadId, long uploadStartTime) {
        int currentFileNumber = mUploadQueue.getCurrentIndex();
        Log.i(TAG, "   📡 Phase 2: Uploading video to storage...");
        
        String mimeType = getMimeType(metadata.getFileName());
        
        // Create streaming request body to avoid loading entire video into memory
        RequestBody streamingBody = new RequestBody() {
            @Override
            public MediaType contentType() {
                return MediaType.parse(mimeType);
            }
            
            @Override
            public long contentLength() {
                return metadata.getFileSize();
            }
            
            @Override
            public void writeTo(BufferedSink sink) throws IOException {
                try (Source source = Okio.source(videoFile)) {
                    long totalBytes = metadata.getFileSize();
                    long bytesWritten = 0;
                    long lastLoggedPercent = -1;
                    
                    // Read in chunks and write to sink
                    long read;
                    okio.Buffer buffer = new okio.Buffer();
                    while ((read = source.read(buffer, 8192)) != -1) {
                        sink.write(buffer, read);
                        bytesWritten += read;
                        
                        // Log progress every 10%
                        long percent = (bytesWritten * 100) / totalBytes;
                        if (percent / 10 > lastLoggedPercent / 10) {
                            lastLoggedPercent = percent;
                            Log.d(TAG, "   📊 Upload progress: " + percent + "% (" + formatBytes(bytesWritten) + " / " + formatBytes(totalBytes) + ")");
                        }
                    }
                }
            }
        };
        
        // PUT to presigned URL (presigned URLs require PUT, not POST)
        Request phase2Request = new Request.Builder()
            .url(presignedUrl)
            .put(streamingBody)
            .build();
        
        // Use a separate client with longer timeout for video uploads
        OkHttpClient videoClient = mHttpClient.newBuilder()
            .writeTimeout(30, TimeUnit.MINUTES) // 30 minutes for large videos
            .readTimeout(5, TimeUnit.MINUTES)
            .build();
        
        mCurrentCall = videoClient.newCall(phase2Request);
        mCurrentCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                if (call.isCanceled()) {
                    Log.d(TAG, "⏸️ Video upload cancelled: " + metadata.getFileName());
                    return;
                }
                Log.e(TAG, "❌ Phase 2 failed: " + e.getMessage());
                handleUploadFailure(metadata.getFileName(), "Upload to storage failed: " + e.getMessage());
            }
            
            @Override
            public void onResponse(Call call, Response response) throws IOException {
                mCurrentCall = null;
                
                if (!response.isSuccessful()) {
                    String errorBody = response.body() != null ? response.body().string() : "Unknown error";
                    Log.e(TAG, "❌ Phase 2 HTTP " + response.code() + ": " + errorBody);
                    handleUploadFailure(metadata.getFileName(), "Storage returned HTTP " + response.code());
                    response.close();
                    return;
                }
                
                response.close();
                Log.i(TAG, "   ✅ Phase 2 complete - video uploaded to storage");
                
                // Phase 3: Confirm upload completion
                confirmVideoUpload(metadata, uploadId, uploadStartTime);
            }
        });
    }
    
    /**
     * Phase 3: Confirm video upload completion with backend
     */
    private void confirmVideoUpload(FileManager.FileMetadata metadata, String uploadId, long uploadStartTime) {
        int currentFileNumber = mUploadQueue.getCurrentIndex();
        Log.i(TAG, "   📡 Phase 3: Confirming upload completion...");
        
        String token = getAuthToken();
        if (token == null || token.isEmpty()) {
            Log.e(TAG, "❌ No auth token for confirmation");
            handleAuthError(metadata.getFileName());
            return;
        }
        
        String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
        String confirmEndpoint = baseUrl + "/api/client/asg/gallery/video-upload-complete";
        
        JSONObject requestBody = new JSONObject();
        try {
            requestBody.put("id", uploadId);
        } catch (JSONException e) {
            Log.e(TAG, "❌ Error building confirmation request", e);
            handleUploadFailure(metadata.getFileName(), "Failed to build confirmation request");
            return;
        }
        
        Request phase3Request = new Request.Builder()
            .url(confirmEndpoint)
            .addHeader("Authorization", "Bearer " + token)
            .addHeader("Content-Type", "application/json")
            .post(RequestBody.create(requestBody.toString(), MediaType.parse("application/json")))
            .build();
        
        mCurrentCall = mHttpClient.newCall(phase3Request);
        mCurrentCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                if (call.isCanceled()) {
                    Log.d(TAG, "⏸️ Video confirmation cancelled: " + metadata.getFileName());
                    return;
                }
                Log.e(TAG, "❌ Phase 3 failed: " + e.getMessage());
                // Note: Video is already in storage, so this is a partial success
                // We still mark as failed so it gets retried
                handleUploadFailure(metadata.getFileName(), "Confirmation failed: " + e.getMessage());
            }
            
            @Override
            public void onResponse(Call call, Response response) throws IOException {
                mCurrentCall = null;
                long uploadDuration = System.currentTimeMillis() - uploadStartTime;
                int currentFileNumber = mUploadQueue.getCurrentIndex();
                
                if (!response.isSuccessful()) {
                    String errorBody = response.body() != null ? response.body().string() : "Unknown error";
                    Log.e(TAG, "❌ Phase 3 HTTP " + response.code() + ": " + errorBody);
                    
                    if (response.code() == 401) {
                        handleAuthError(metadata.getFileName());
                    } else {
                        handleUploadFailure(metadata.getFileName(), "Confirmation HTTP " + response.code());
                    }
                    response.close();
                    return;
                }
                
                response.close();
                
                // ✅ Video upload complete!
                mUploadQueue.markAsUploaded(metadata.getFileName());
                mCurrentBatchUploaded++;
                int percent = mInitialTotalFiles > 0 ? (mCurrentBatchUploaded * 100 / mInitialTotalFiles) : 0;
                
                Log.i(TAG, "✅ [" + currentFileNumber + "/" + mInitialTotalFiles + "] VIDEO UPLOAD SUCCESSFUL: " + metadata.getFileName());
                Log.i(TAG, "   ⏱️ Duration: " + (uploadDuration / 1000.0) + "s");
                Log.i(TAG, "   📊 Progress: " + mCurrentBatchUploaded + "/" + mInitialTotalFiles + " (" + percent + "%)");
                Log.i(TAG, "   📈 Speed: " + formatBytes(metadata.getFileSize() * 1000 / (uploadDuration > 0 ? uploadDuration : 1)) + "/s");
                
                // Delete video from glasses after successful upload
                String packageName = mFileManager.getDefaultPackageName();
                FileManager.FileOperationResult deleteResult = 
                    mFileManager.deleteFile(packageName, metadata.getFileName());
                
                if (deleteResult.isSuccess()) {
                    Log.i(TAG, "   🗑️ Deleted from glasses: " + metadata.getFileName());
                } else {
                    Log.w(TAG, "   ⚠️ Failed to delete from glasses: " + metadata.getFileName() + " - " + deleteResult.getMessage());
                }
                
                // Send updated gallery status to phone after each successful upload
                // This ensures the phone knows the current gallery state after each file is deleted
                mHandler.post(() -> sendGalleryStatusUpdate());
                
                // Cloud automatically sends WebSocket event to phone when video uploads
                // This provides real-time upload progress via WebSocket
                
                if (mCallback != null) {
                    mHandler.post(() -> mCallback.onProgress(
                        metadata.getFileName(),
                        mCurrentBatchUploaded,
                        mInitialTotalFiles
                    ));
                }
                
                // Process next file
                mHandler.post(() -> processNextFile());
            }
        });
    }
    
    /**
     * Phase 1b: Upload video thumbnail BEFORE the video upload (synchronous, best effort)
     * This is called after getting presigned URL but before uploading video bytes.
     * Ensures mobile app has thumbnail URL when polling for pending items.
     * Failures don't block the video upload process.
     */
    private void uploadVideoThumbnailSync(File videoFile, String videoId, String token) {
        Log.i(TAG, "   🖼️ Phase 1b: Generating and uploading video thumbnail...");
        
        // Get thumbnail from ThumbnailManager
        File thumbnailFile = mFileManager.getThumbnailManager().getOrCreateThumbnail(videoFile);
        if (thumbnailFile == null || !thumbnailFile.exists()) {
            Log.w(TAG, "   ⚠️ Could not generate thumbnail for video: " + videoFile.getName());
            return;
        }
        
        Log.d(TAG, "   📸 Thumbnail ready: " + thumbnailFile.getName() + " (" + formatBytes(thumbnailFile.length()) + ")");
        
        String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
        String thumbnailEndpoint = baseUrl + "/api/client/asg/gallery/video-thumbnail";
        
        try {
            // Build multipart request
            MultipartBody body = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", thumbnailFile.getName(),
                    RequestBody.create(thumbnailFile, MediaType.parse("image/jpeg")))
                .addFormDataPart("videoId", videoId)
                .build();
            
            Request request = new Request.Builder()
                .url(thumbnailEndpoint)
                .addHeader("Authorization", "Bearer " + token)
                .post(body)
                .build();
            
            // Execute synchronously - wait for thumbnail to upload before video
            // This is intentionally blocking to ensure thumbnail is available when mobile polls
            Response response = mHttpClient.newCall(request).execute();
            if (response.isSuccessful()) {
                Log.i(TAG, "   ✅ Thumbnail uploaded successfully (before video upload)");
            } else {
                Log.w(TAG, "   ⚠️ Thumbnail upload failed with HTTP " + response.code());
            }
            response.close();
        } catch (Exception e) {
            Log.w(TAG, "   ⚠️ Thumbnail upload failed: " + e.getMessage());
            // Continue with video upload even if thumbnail fails
        }
    }
    
    /**
     * Handle upload failure with retry logic
     */
    private void handleUploadFailure(String filename, String error) {
        int attempts = mUploadQueue.getAttempts(filename);
        
        // Check if this looks like a network error (WiFi disconnect)
        boolean isNetworkError = error != null && (
            error.contains("Unable to resolve host") ||
            error.contains("Network is unreachable") ||
            error.contains("Failed to connect") ||
            error.contains("Connection refused") ||
            error.contains("timeout") ||
            error.contains("ENETUNREACH") ||
            error.contains("ECONNREFUSED")
        );
        
        if (isNetworkError) {
            Log.e(TAG, "🌐 Network error detected - WiFi may have disconnected");
            // Send gallery status immediately so phone knows uploads stopped
            sendGalleryStatusUpdate();
            // Send BLE notification to phone (fallback when can't reach cloud)
            // Phone will notify cloud and start downloading available items
            sendCloudUploadFailedNotification("network_error");
        }
        
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
            
            // Send gallery status so phone knows there are still files remaining
            sendGalleryStatusUpdate();
            
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
        
        // Send gallery status so phone knows uploads stopped and files remain
        sendGalleryStatusUpdate();
        
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
     * Notify cloud that upload batch has started (HTTP POST)
     * Cloud will send WebSocket event to phone
     */
    private void notifyCloudUploadStarted(int totalFiles) {
        String token = getAuthToken();
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "⚠️ Cannot notify cloud - no auth token");
            return;
        }
        
        String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
        String endpoint = baseUrl + "/api/client/asg/gallery/upload-started";
        
        try {
            JSONObject body = new JSONObject();
            body.put("totalFiles", totalFiles);
            
            Request request = new Request.Builder()
                .url(endpoint)
                .addHeader("Authorization", "Bearer " + token)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create(body.toString(), MediaType.parse("application/json")))
                .build();
            
            mHttpClient.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.w(TAG, "⚠️ Failed to notify cloud of upload start: " + e.getMessage());
                }
                
                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    if (response.isSuccessful()) {
                        Log.i(TAG, "✅ Notified cloud that upload started: " + totalFiles + " files");
                    } else {
                        Log.w(TAG, "⚠️ Cloud returned error for upload-started: " + response.code());
                    }
                    response.close();
                }
            });
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating upload-started request", e);
        }
    }
    
    /**
     * Notify cloud that upload batch has completed (HTTP POST)
     * Cloud will send WebSocket event to phone
     */
    private void notifyCloudUploadComplete() {
        String token = getAuthToken();
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "⚠️ Cannot notify cloud - no auth token");
            return;
        }
        
        String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
        String endpoint = baseUrl + "/api/client/asg/gallery/upload-complete";
        
        try {
            Request request = new Request.Builder()
                .url(endpoint)
                .addHeader("Authorization", "Bearer " + token)
                .addHeader("Content-Type", "application/json")
                .post(RequestBody.create("{}", MediaType.parse("application/json")))
                .build();
            
            mHttpClient.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.w(TAG, "⚠️ Failed to notify cloud of upload complete: " + e.getMessage());
                }
                
                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    if (response.isSuccessful()) {
                        Log.i(TAG, "✅ Notified cloud that upload batch completed");
                    } else {
                        Log.w(TAG, "⚠️ Cloud returned error for upload-complete: " + response.code());
                    }
                    response.close();
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "💥 Error creating upload-complete request", e);
        }
    }
    
    /**
     * Send BLE message to phone when upload fails (fallback when WiFi dies, can't reach cloud)
     * Phone will notify cloud and start downloading available items
     */
    private void sendCloudUploadFailedNotification(String reason) {
        if (mCommunicationManager == null) {
            Log.w(TAG, "⚠️ Cannot send cloud upload failed notification - CommunicationManager not available");
            return;
        }
        
        try {
            JSONObject notification = new JSONObject();
            notification.put("type", "cloud_upload_failed");
            notification.put("reason", reason);
            notification.put("timestamp", System.currentTimeMillis());
            
            boolean sent = mCommunicationManager.sendBluetoothResponse(notification);
            if (sent) {
                Log.i(TAG, "📱 Notified phone via BLE that cloud upload failed: " + reason);
            } else {
                Log.w(TAG, "⚠️ Failed to notify phone that cloud upload failed");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating cloud upload failed notification", e);
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
