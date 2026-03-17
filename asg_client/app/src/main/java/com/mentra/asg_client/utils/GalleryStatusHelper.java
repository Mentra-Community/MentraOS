package com.mentra.asg_client.utils;

import android.util.Log;
import com.mentra.asg_client.io.file.core.FileManager;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

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

        // Group files by capture ID to count captures, not individual files
        Set<String> countedCaptures = new HashSet<>();

        for (FileManager.FileMetadata metadata : allFiles) {
            String fileName = metadata.getFileName();
            totalSize += metadata.getFileSize();

            // Skip auxiliary files that aren't standalone media
            if (isAuxiliaryFile(fileName)) {
                continue;
            }

            // Derive capture ID to group related files
            String captureId = deriveCaptureId(fileName);

            // Only count each capture once
            if (countedCaptures.contains(captureId)) {
                continue;
            }
            countedCaptures.add(captureId);

            if (isVideoFile(fileName.toLowerCase())) {
                videoCount++;
            } else {
                photoCount++;
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
     * Check if a file is an auxiliary/sidecar file that shouldn't be counted
     * as a standalone media item. Includes HDR brackets and IMU sidecars.
     *
     * @param fileName The filename to check
     * @return true if the file is auxiliary, false if it's a standalone media item
     */
    public static boolean isAuxiliaryFile(String fileName) {
        if (fileName == null) return false;
        String lower = fileName.toLowerCase();

        // Get leaf filename for folder-based paths
        String leaf = lower.contains("/") ? lower.substring(lower.lastIndexOf('/') + 1) : lower;

        // IMU sidecar files (imu.json inside capture folder)
        if (leaf.equals("imu.json")) return true;
        // HDR bracket files (ev-2.jpg, ev0.jpg, ev2.jpg)
        if (leaf.matches("ev-?\\d+\\.jpe?g$")) return true;
        return false;
    }

    /**
     * Derive a capture ID from a filename to group related files.
     */
    private static String deriveCaptureId(String name) {
        if (name == null) return "unknown";

        // Folder-based: take everything before the first '/'
        if (name.contains("/")) {
            return name.substring(0, name.indexOf('/'));
        }

        // Legacy flat file: strip extension and known suffixes
        String stem = name;
        if (stem.toLowerCase().endsWith(".imu.json")) {
            return stem.substring(0, stem.length() - ".imu.json".length());
        }
        int dotIdx = stem.lastIndexOf('.');
        if (dotIdx > 0) {
            stem = stem.substring(0, dotIdx);
        }
        stem = stem.replaceAll("_ev-?\\d+$", "");
        return stem;
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