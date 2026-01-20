package com.mentra.asg_client.service.gallery;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.preference.PreferenceManager;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManager.FileMetadata;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Gallery Upload Queue
 * Manages the queue of files to upload to cloud
 * Tracks upload state, failures, and retries
 */
public class GalleryUploadQueue {
    private static final String TAG = "GalleryUploadQueue";
    
    // SharedPreferences keys
    private static final String PREF_LAST_SYNC_TIMESTAMP = "cloud_last_sync_timestamp";
    private static final String PREF_UPLOADED_FILES = "cloud_uploaded_files";
    private static final String PREF_FAILED_UPLOADS = "cloud_failed_uploads";
    private static final String PREF_UPLOAD_ATTEMPTS = "cloud_upload_attempts";
    
    private final Context mContext;
    private final FileManager mFileManager;
    private final SharedPreferences mPrefs;
    
    // In-memory queue state
    private List<FileMetadata> mPendingFiles;
    private int mCurrentIndex;
    private Set<String> mUploadedFiles;
    private Map<String, String> mFailedUploads;
    private Map<String, Integer> mUploadAttempts;
    
    public GalleryUploadQueue(Context context, FileManager fileManager) {
        this.mContext = context;
        this.mFileManager = fileManager;
        this.mPrefs = PreferenceManager.getDefaultSharedPreferences(context);
        
        // Load persisted state
        loadState();
        
        Log.i(TAG, "📋 GalleryUploadQueue initialized");
    }
    
    /**
     * Load queue state from SharedPreferences
     */
    private void loadState() {
        // Load uploaded files set
        mUploadedFiles = new HashSet<>();
        try {
            String uploadedJson = mPrefs.getString(PREF_UPLOADED_FILES, "[]");
            JSONArray uploadedArray = new JSONArray(uploadedJson);
            for (int i = 0; i < uploadedArray.length(); i++) {
                mUploadedFiles.add(uploadedArray.getString(i));
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error loading uploaded files", e);
        }
        
        // Load failed uploads map
        mFailedUploads = new HashMap<>();
        try {
            String failedJson = mPrefs.getString(PREF_FAILED_UPLOADS, "{}");
            JSONObject failedObj = new JSONObject(failedJson);
            JSONArray names = failedObj.names();
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String key = names.getString(i);
                    mFailedUploads.put(key, failedObj.getString(key));
                }
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error loading failed uploads", e);
        }
        
        // Load upload attempts map
        mUploadAttempts = new HashMap<>();
        try {
            String attemptsJson = mPrefs.getString(PREF_UPLOAD_ATTEMPTS, "{}");
            JSONObject attemptsObj = new JSONObject(attemptsJson);
            JSONArray names = attemptsObj.names();
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String key = names.getString(i);
                    mUploadAttempts.put(key, attemptsObj.getInt(key));
                }
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error loading upload attempts", e);
        }
        
        Log.d(TAG, "📋 Loaded state: " + mUploadedFiles.size() + " uploaded, " + 
                  mFailedUploads.size() + " failed");
    }
    
    /**
     * Build the upload queue from FileManager
     * Filters out already-uploaded files and sorts by capture time
     */
    public void buildQueue() {
        Log.i(TAG, "🔨 Building upload queue");
        
        // Get all files from FileManager
        List<FileMetadata> allFiles = mFileManager.listFiles(mFileManager.getDefaultPackageName());
        
        // Get last sync timestamp
        long lastSyncTime = mPrefs.getLong(PREF_LAST_SYNC_TIMESTAMP, 0);
        
        // Filter files
        mPendingFiles = new ArrayList<>();
        for (FileMetadata file : allFiles) {
            // Skip if already uploaded
            if (mUploadedFiles.contains(file.getFileName())) {
                continue;
            }
            
            // Skip if failed too many times (will be in failed uploads map)
            if (mFailedUploads.containsKey(file.getFileName())) {
                continue;
            }
            
            // Skip if modified before last sync (should have been synced already)
            // Allow 10 second buffer for clock skew
            if (file.getLastModified() < lastSyncTime - 10000) {
                continue;
            }
            
            mPendingFiles.add(file);
        }
        
        // Sort by capture time (oldest first)
        Collections.sort(mPendingFiles, new Comparator<FileMetadata>() {
            @Override
            public int compare(FileMetadata f1, FileMetadata f2) {
                return Long.compare(f1.getLastModified(), f2.getLastModified());
            }
        });
        
        mCurrentIndex = 0;
        
        Log.i(TAG, "📋 Queue built: " + mPendingFiles.size() + " files to upload");
        
        // Log summary
        int photoCount = 0;
        int videoCount = 0;
        long totalSize = 0;
        
        for (FileMetadata file : mPendingFiles) {
            if (isVideoFile(file.getFileName())) {
                videoCount++;
            } else {
                photoCount++;
            }
            totalSize += file.getFileSize();
        }
        
        Log.i(TAG, "📊 Queue summary: " + photoCount + " photos, " + videoCount + " videos, " + 
                  formatBytes(totalSize) + " total");
    }
    
    /**
     * Get next file to upload
     */
    public FileMetadata getNextFile() {
        if (mPendingFiles == null || mCurrentIndex >= mPendingFiles.size()) {
            return null;
        }
        
        FileMetadata file = mPendingFiles.get(mCurrentIndex);
        mCurrentIndex++;
        return file;
    }
    
    /**
     * Mark file as successfully uploaded
     */
    public void markAsUploaded(String filename) {
        mUploadedFiles.add(filename);
        
        // Remove from attempts tracking
        mUploadAttempts.remove(filename);
        
        // Persist to SharedPreferences
        saveUploadedFiles();
        saveUploadAttempts();
        
        Log.d(TAG, "✅ Marked as uploaded: " + filename);
    }
    
    /**
     * Mark file as failed
     */
    public void markAsFailed(String filename, String error) {
        mFailedUploads.put(filename, error);
        
        // Remove from attempts tracking
        mUploadAttempts.remove(filename);
        
        // Persist to SharedPreferences
        saveFailedUploads();
        saveUploadAttempts();
        
        Log.e(TAG, "❌ Marked as failed: " + filename + " - " + error);
    }
    
    /**
     * Get number of upload attempts for a file
     */
    public int getAttempts(String filename) {
        return mUploadAttempts.getOrDefault(filename, 0);
    }
    
    /**
     * Increment upload attempts for a file
     */
    public void incrementAttempts(String filename) {
        int current = mUploadAttempts.getOrDefault(filename, 0);
        mUploadAttempts.put(filename, current + 1);
        saveUploadAttempts();
    }
    
    /**
     * Get count of uploaded files
     */
    public int getUploadedCount() {
        return mUploadedFiles.size();
    }
    
    /**
     * Get count of failed files
     */
    public int getFailedCount() {
        return mFailedUploads.size();
    }
    
    /**
     * Get total files in queue
     */
    public int getTotalFiles() {
        return mPendingFiles != null ? mPendingFiles.size() : 0;
    }
    
    /**
     * Clear uploaded files history (after successful sync)
     */
    public void clearUploaded() {
        mUploadedFiles.clear();
        saveUploadedFiles();
        Log.d(TAG, "🧹 Cleared uploaded files history");
    }
    
    /**
     * Clear failed uploads (for retry)
     */
    public void clearFailed() {
        mFailedUploads.clear();
        saveFailedUploads();
        Log.d(TAG, "🧹 Cleared failed uploads");
    }
    
    /**
     * Update last sync timestamp
     */
    public void updateLastSyncTime() {
        mPrefs.edit()
            .putLong(PREF_LAST_SYNC_TIMESTAMP, System.currentTimeMillis())
            .apply();
        Log.d(TAG, "⏰ Updated last sync timestamp");
    }
    
    // Persistence methods
    
    private void saveUploadedFiles() {
        try {
            JSONArray array = new JSONArray(mUploadedFiles);
            mPrefs.edit()
                .putString(PREF_UPLOADED_FILES, array.toString())
                .apply();
        } catch (Exception e) {
            Log.e(TAG, "Error saving uploaded files", e);
        }
    }
    
    private void saveFailedUploads() {
        try {
            JSONObject obj = new JSONObject(mFailedUploads);
            mPrefs.edit()
                .putString(PREF_FAILED_UPLOADS, obj.toString())
                .apply();
        } catch (Exception e) {
            Log.e(TAG, "Error saving failed uploads", e);
        }
    }
    
    private void saveUploadAttempts() {
        try {
            JSONObject obj = new JSONObject(mUploadAttempts);
            mPrefs.edit()
                .putString(PREF_UPLOAD_ATTEMPTS, obj.toString())
                .apply();
        } catch (Exception e) {
            Log.e(TAG, "Error saving upload attempts", e);
        }
    }
    
    // Helper methods
    
    private boolean isVideoFile(String filename) {
        String lower = filename.toLowerCase();
        return lower.endsWith(".mp4") || 
               lower.endsWith(".mov") || 
               lower.endsWith(".avi") ||
               lower.endsWith(".mkv") ||
               lower.endsWith(".webm") ||
               lower.endsWith(".3gp");
    }
    
    private String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        if (bytes < 1024 * 1024 * 1024) return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
        return String.format("%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }
}
