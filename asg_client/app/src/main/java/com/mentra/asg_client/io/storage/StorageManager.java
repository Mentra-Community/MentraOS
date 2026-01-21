package com.mentra.asg_client.io.storage;

import android.content.Context;
import android.os.Environment;
import android.os.StatFs;
import android.util.Log;

import java.io.File;

/**
 * Manages storage space for media capture operations.
 * Ensures sufficient space is available and reserves space for OTA updates.
 *
 * Uses singleton pattern to avoid repeated object creation during rapid photo capture.
 */
public class StorageManager {
    private static final String TAG = "StorageManager";

    // Singleton instance
    private static volatile StorageManager sInstance;

    // Reserve 4GB for OTA updates
    private static final long OTA_RESERVED_SPACE = 4L * 1024 * 1024 * 1024; // 4GB

    // Minimum space required for video recording
    private static final long MIN_VIDEO_SPACE = 500L * 1024 * 1024; // 500MB

    // Estimated size for a photo
    private static final long ESTIMATED_PHOTO_SIZE = 5L * 1024 * 1024; // 5MB

    // Maximum file size (4GB - 1 byte for FAT32 compatibility)
    private static final long MAX_FILE_SIZE = (4L * 1024 * 1024 * 1024) - 1;

    // Maximum video duration (30 minutes)
    private static final long MAX_VIDEO_DURATION_MS = 30 * 60 * 1000;

    private final Context context;

    /**
     * Get singleton instance of StorageManager.
     * @param context Application context
     * @return StorageManager instance
     */
    public static StorageManager getInstance(Context context) {
        if (sInstance == null) {
            synchronized (StorageManager.class) {
                if (sInstance == null) {
                    sInstance = new StorageManager(context);
                }
            }
        }
        return sInstance;
    }

    /**
     * @deprecated Use {@link #getInstance(Context)} instead to avoid repeated object creation.
     */
    @Deprecated
    public StorageManager(Context context) {
        this.context = context.getApplicationContext();
    }
    
    /**
     * Check if there's enough space to record a video
     * @return true if sufficient space is available
     */
    public boolean canRecordVideo() {
        long available = getAvailableSpace();
        boolean canRecord = available > (OTA_RESERVED_SPACE + MIN_VIDEO_SPACE);
        
        if (!canRecord) {
            Log.w(TAG, "Insufficient storage for video recording. Available: " + 
                      formatSize(available) + ", Required: " + 
                      formatSize(OTA_RESERVED_SPACE + MIN_VIDEO_SPACE));
        }
        
        return canRecord;
    }
    
    /**
     * Check if there's enough space to take a photo
     * @return true if sufficient space is available
     */
    public boolean canTakePhoto() {
        long available = getAvailableSpace();
        boolean canTake = available > (OTA_RESERVED_SPACE + ESTIMATED_PHOTO_SIZE);
        
        if (!canTake) {
            Log.w(TAG, "Insufficient storage for photo. Available: " + 
                      formatSize(available) + ", Required: " + 
                      formatSize(OTA_RESERVED_SPACE + ESTIMATED_PHOTO_SIZE));
        }
        
        return canTake;
    }
    
    /**
     * Get the maximum file size for video recording
     * @return maximum file size in bytes
     */
    public long getMaxVideoFileSize() {
        long available = getAvailableSpace();
        long usable = available - OTA_RESERVED_SPACE;
        
        // Cap at 4GB (FAT32 limit) or available space
        long maxSize = Math.min(usable, MAX_FILE_SIZE);
        
        Log.d(TAG, "Max video file size: " + formatSize(maxSize) + 
                  " (Available: " + formatSize(available) + ")");
        
        return maxSize;
    }
    
    /**
     * Calculate maximum video duration based on bitrate and available space
     * @param bitrate Video bitrate in bits per second
     * @return maximum duration in milliseconds
     */
    public int getMaxVideoDuration(int bitrate) {
        long maxFileSize = getMaxVideoFileSize();
        
        // Calculate duration: fileSize(bytes) * 8(bits/byte) * 1000(ms/s) / bitrate(bits/s)
        long maxDurationMs = (maxFileSize * 8 * 1000) / bitrate;
        
        // Cap at 30 minutes
        int duration = (int) Math.min(maxDurationMs, MAX_VIDEO_DURATION_MS);
        
        Log.d(TAG, "Max video duration: " + (duration / 1000) + " seconds at bitrate " + bitrate);
        
        return duration;
    }
    
    /**
     * Get available storage space
     * @return available space in bytes
     */
    public long getAvailableSpace() {
        try {
            File path = Environment.getExternalStorageDirectory();
            StatFs stat = new StatFs(path.getPath());
            return stat.getAvailableBytes();
        } catch (Exception e) {
            Log.e(TAG, "Error getting available space", e);
            return 0;
        }
    }
    
    /**
     * Get total storage space
     * @return total space in bytes
     */
    public long getTotalSpace() {
        try {
            File path = Environment.getExternalStorageDirectory();
            StatFs stat = new StatFs(path.getPath());
            return stat.getTotalBytes();
        } catch (Exception e) {
            Log.e(TAG, "Error getting total space", e);
            return 0;
        }
    }
    
    /**
     * Check if external storage is available
     * @return true if external storage is mounted and writable
     */
    public boolean isExternalStorageAvailable() {
        String state = Environment.getExternalStorageState();
        return Environment.MEDIA_MOUNTED.equals(state);
    }
    
    /**
     * Get storage status summary
     * @return human-readable storage status
     */
    public String getStorageStatus() {
        long available = getAvailableSpace();
        long total = getTotalSpace();
        
        return "Storage: " + formatSize(available) + " free of " + formatSize(total) + 
               " (OTA reserved: " + formatSize(OTA_RESERVED_SPACE) + ")";
    }
    
    /**
     * Format size in human-readable format
     * @param size Size in bytes
     * @return Formatted string (e.g., "1.5 GB")
     */
    private String formatSize(long size) {
        if (size < 1024) {
            return size + " B";
        } else if (size < 1024 * 1024) {
            return String.format("%.1f KB", size / 1024.0);
        } else if (size < 1024 * 1024 * 1024) {
            return String.format("%.1f MB", size / (1024.0 * 1024));
        } else {
            return String.format("%.2f GB", size / (1024.0 * 1024 * 1024));
        }
    }
}