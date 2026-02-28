package com.mentra.asg_client.utils;

import android.util.Log;
import com.mentra.asg_client.io.file.core.FileManager;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;

/**
 * Utility class for building gallery status information.
 * Shared by GalleryCommandHandler and MediaCaptureService to avoid code duplication.
 */
public class GalleryStatusHelper {
    private static final String TAG = "GalleryStatusHelper";

    /**
     * Build gallery status JSON from FileManager files.
     *
     * @param fileManager The FileManager instance to query for files
     * @return JSONObject containing gallery status information
     * @throws JSONException if JSON building fails
     */
    public static JSONObject buildGalleryStatus(FileManager fileManager) throws JSONException {
        if (fileManager == null) {
            throw new IllegalArgumentException("FileManager cannot be null");
        }

        // Get all files using FileManager
        List<FileManager.FileMetadata> allFiles = fileManager.listFiles(fileManager.getDefaultPackageName());

        int photoCount = 0;
        int videoCount = 0;
        long totalSize = 0;

        // Count photos and videos
        for (FileManager.FileMetadata metadata : allFiles) {
            String fileName = metadata.getFileName().toLowerCase();
            totalSize += metadata.getFileSize();

            if (isVideoFile(fileName)) {
                videoCount++;
            } else {
                photoCount++;  // Assume non-video files are photos
            }
        }

        // Build response JSON
        JSONObject response = new JSONObject();
        response.put("type", "gallery_status");
        response.put("photos", photoCount);
        response.put("videos", videoCount);
        response.put("total", photoCount + videoCount);
        response.put("total_size", totalSize);
        response.put("has_content", (photoCount + videoCount) > 0);

        Log.d(TAG, "Gallery status: " + photoCount + " photos, " + videoCount + " videos, " +
                   formatBytes(totalSize) + " total size");

        return response;
    }

    /**
     * Check if a file is a video based on extension.
     *
     * @param fileName The filename to check
     * @return true if the file is a video, false otherwise
     */
    public static boolean isVideoFile(String fileName) {
        String lowerName = fileName.toLowerCase();
        return lowerName.endsWith(".mp4") ||
               lowerName.endsWith(".mov") ||
               lowerName.endsWith(".avi") ||
               lowerName.endsWith(".mkv") ||
               lowerName.endsWith(".webm") ||
               lowerName.endsWith(".3gp");
    }

    /**
     * Format bytes to human readable string.
     *
     * @param bytes The number of bytes to format
     * @return Human-readable string representation of the byte size
     */
    public static String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        if (bytes < 1024 * 1024 * 1024) return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
        return String.format("%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }
}