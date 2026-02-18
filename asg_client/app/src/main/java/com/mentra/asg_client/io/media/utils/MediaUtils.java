package com.mentra.asg_client.io.media.utils;

import android.content.Context;
import android.media.MediaScannerConnection;
import android.os.Environment;
import android.util.Log;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Utility class for media-related operations.
 * Provides common functionality for photo, video, and audio operations.
 */
public class MediaUtils {
    private static final String TAG = "MediaUtils";
    
    // Media type constants
    public static final int MEDIA_TYPE_PHOTO = 1;
    public static final int MEDIA_TYPE_VIDEO = 2;
    public static final int MEDIA_TYPE_AUDIO = 3;
    
    // File extensions
    public static final String PHOTO_EXTENSION = ".jpg";
    public static final String VIDEO_EXTENSION = ".mp4";
    public static final String AUDIO_EXTENSION = ".wav";
    
    // Directory names
    public static final String PHOTOS_DIR = "photos";
    public static final String VIDEOS_DIR = "videos";
    public static final String AUDIO_DIR = "audio";
    public static final String TEMP_DIR = "temp";
    
    /**
     * Get the appropriate directory for a media type
     * 
     * @param context Application context
     * @param mediaType The type of media (PHOTO, VIDEO, AUDIO)
     * @return File object representing the directory
     */
    public static File getMediaDirectory(Context context, int mediaType) {
        String dirName;
        switch (mediaType) {
            case MEDIA_TYPE_PHOTO:
                dirName = PHOTOS_DIR;
                break;
            case MEDIA_TYPE_VIDEO:
                dirName = VIDEOS_DIR;
                break;
            case MEDIA_TYPE_AUDIO:
                dirName = AUDIO_DIR;
                break;
            default:
                dirName = TEMP_DIR;
                break;
        }
        
        File mediaDir = new File(context.getExternalFilesDir(null), dirName);
        if (!mediaDir.exists()) {
            if (!mediaDir.mkdirs()) {
                Log.e(TAG, "Failed to create media directory: " + mediaDir.getAbsolutePath());
            }
        }
        
        return mediaDir;
    }
    
    /**
     * Generate a unique filename for media capture
     * 
     * @param mediaType The type of media
     * @param prefix Optional prefix for the filename
     * @return A unique filename with timestamp
     */
    public static String generateMediaFilename(int mediaType, String prefix) {
        SimpleDateFormat dateFormat = new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US);
        String timestamp = dateFormat.format(new Date());
        
        String extension;
        switch (mediaType) {
            case MEDIA_TYPE_PHOTO:
                extension = PHOTO_EXTENSION;
                break;
            case MEDIA_TYPE_VIDEO:
                extension = VIDEO_EXTENSION;
                break;
            case MEDIA_TYPE_AUDIO:
                extension = AUDIO_EXTENSION;
                break;
            default:
                extension = ".tmp";
                break;
        }
        
        if (prefix != null && !prefix.isEmpty()) {
            return prefix + "_" + timestamp + extension;
        } else {
            return timestamp + extension;
        }
    }
    
    /**
     * Create a media file with the given parameters
     * 
     * @param context Application context
     * @param mediaType The type of media
     * @param filename The filename to use
     * @return File object representing the media file
     */
    public static File createMediaFile(Context context, int mediaType, String filename) {
        File mediaDir = getMediaDirectory(context, mediaType);
        return new File(mediaDir, filename);
    }
    
    /**
     * Check if external storage is available for media operations
     * 
     * @return true if external storage is available, false otherwise
     */
    public static boolean isExternalStorageAvailable() {
        String state = Environment.getExternalStorageState();
        return Environment.MEDIA_MOUNTED.equals(state);
    }
    
    /**
     * Get the available storage space in bytes
     * 
     * @param context Application context
     * @return Available storage space in bytes, or -1 if not available
     */
    public static long getAvailableStorageSpace(Context context) {
        if (!isExternalStorageAvailable()) {
            return -1;
        }
        
        File externalDir = context.getExternalFilesDir(null);
        if (externalDir == null) {
            return -1;
        }
        
        return externalDir.getFreeSpace();
    }
    
    /**
     * Check if there's enough storage space for media operations
     * 
     * @param context Application context
     * @param requiredBytes Required space in bytes
     * @return true if enough space is available, false otherwise
     */
    public static boolean hasEnoughStorageSpace(Context context, long requiredBytes) {
        long availableSpace = getAvailableStorageSpace(context);
        return availableSpace >= requiredBytes;
    }
    
    /**
     * Scan a media file to make it visible in the gallery/media apps
     * 
     * @param context Application context
     * @param filePath Path to the media file
     */
    public static void scanMediaFile(Context context, String filePath) {
        MediaScannerConnection.scanFile(
            context,
            new String[]{filePath},
            null,
            new MediaScannerConnection.OnScanCompletedListener() {
                @Override
                public void onScanCompleted(String path, android.net.Uri uri) {
                    Log.d(TAG, "Media file scanned: " + path);
                }
            }
        );
    }
    
    /**
     * Delete a media file and clean up resources
     * 
     * @param filePath Path to the media file
     * @return true if deletion was successful, false otherwise
     */
    public static boolean deleteMediaFile(String filePath) {
        try {
            File file = new File(filePath);
            if (file.exists()) {
                boolean deleted = file.delete();
                if (deleted) {
                    Log.d(TAG, "Media file deleted: " + filePath);
                } else {
                    Log.e(TAG, "Failed to delete media file: " + filePath);
                }
                return deleted;
            } else {
                Log.w(TAG, "Media file does not exist: " + filePath);
                return true; // Consider it "deleted" if it doesn't exist
            }
        } catch (Exception e) {
            Log.e(TAG, "Error deleting media file: " + filePath, e);
            return false;
        }
    }
    
    /**
     * Get the file size of a media file
     * 
     * @param filePath Path to the media file
     * @return File size in bytes, or -1 if error
     */
    public static long getMediaFileSize(String filePath) {
        try {
            File file = new File(filePath);
            if (file.exists()) {
                return file.length();
            } else {
                return -1;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting file size: " + filePath, e);
            return -1;
        }
    }
    
    /**
     * Format file size for human-readable display
     * 
     * @param bytes File size in bytes
     * @return Formatted string representation
     */
    public static String formatFileSize(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        } else if (bytes < 1024 * 1024) {
            return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        } else if (bytes < 1024 * 1024 * 1024) {
            return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
        } else {
            return String.format(Locale.US, "%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
        }
    }
    
    /**
     * Clean up temporary media files
     * 
     * @param context Application context
     * @return Number of files cleaned up
     */
    public static int cleanupTempFiles(Context context) {
        File tempDir = getMediaDirectory(context, -1); // TEMP_DIR
        if (!tempDir.exists()) {
            return 0;
        }
        
        int cleanedCount = 0;
        File[] tempFiles = tempDir.listFiles();
        if (tempFiles != null) {
            for (File file : tempFiles) {
                if (file.isFile()) {
                    if (deleteMediaFile(file.getAbsolutePath())) {
                        cleanedCount++;
                    }
                }
            }
        }
        
        Log.d(TAG, "Cleaned up " + cleanedCount + " temporary files");
        return cleanedCount;
    }
} 