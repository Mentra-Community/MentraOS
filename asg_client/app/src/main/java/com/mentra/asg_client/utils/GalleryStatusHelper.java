package com.mentra.asg_client.utils;

import android.util.Log;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManager.FileMetadata;
import com.mentra.asg_client.io.file.core.FileManager.FileOperationResult;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.Map;

/**
 * Utility class for building gallery status information.
 * Shared by GalleryCommandHandler and MediaCaptureService to avoid code duplication.
 */
public class GalleryStatusHelper {
    private static final String TAG = "GalleryStatusHelper";

    private static volatile long lastOrphanCleanupMs = 0L;

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

        String packageName = fileManager.getDefaultPackageName();
        List<FileMetadata> allFiles = fileManager.listFiles(packageName);

        boolean hadDeletes = maybeDeleteStaleOrphanCaptures(fileManager, packageName, allFiles);
        if (hadDeletes) {
            allFiles = fileManager.listFiles(packageName);
        }

        int photoCount = 0;
        int videoCount = 0;
        long totalSize = 0;

        Map<String, List<FileMetadata>> groups = CaptureGalleryRules.groupByCaptureId(allFiles);
        for (Map.Entry<String, List<FileMetadata>> e : groups.entrySet()) {
            List<FileMetadata> g = e.getValue();
            if (!CaptureGalleryRules.isValidCapture(g)) {
                continue;
            }
            for (FileMetadata m : g) {
                totalSize += m.getFileSize();
            }
            CaptureGalleryRules.CaptureMediaKind kind = CaptureGalleryRules.classifyValidCaptureKind(g);
            if (kind == CaptureGalleryRules.CaptureMediaKind.VIDEO) {
                videoCount++;
            } else {
                photoCount++;
            }
        }

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
     * Deletes stale capture folders that never received base.jpg / base.mp4. Throttled; safe for HDR in progress
     * when {@link CaptureGalleryRules#STALE_ORPHAN_MS} is conservative.
     */
    static boolean maybeDeleteStaleOrphanCaptures(
            FileManager fileManager,
            String packageName,
            List<FileMetadata> allFiles) {
        long now = System.currentTimeMillis();
        if (now - lastOrphanCleanupMs < CaptureGalleryRules.CLEANUP_THROTTLE_MS) {
            return false;
        }
        lastOrphanCleanupMs = now;

        Map<String, List<FileMetadata>> groups = CaptureGalleryRules.groupByCaptureId(allFiles);
        boolean anyDeleted = false;
        for (Map.Entry<String, List<FileMetadata>> e : groups.entrySet()) {
            String captureId = e.getKey();
            List<FileMetadata> g = e.getValue();
            if (CaptureGalleryRules.isValidCapture(g)) {
                continue;
            }
            if (!CaptureGalleryRules.isDirectoryStyleCapture(g)) {
                continue;
            }
            if (!CaptureGalleryRules.isOrphanAutoDeleteCaptureId(captureId)) {
                continue;
            }
            long maxM = CaptureGalleryRules.maxLastModified(g);
            if (now - maxM < CaptureGalleryRules.STALE_ORPHAN_MS) {
                continue;
            }
            FileOperationResult r = fileManager.deleteCaptureDirectory(packageName, captureId);
            if (r.isSuccess()) {
                anyDeleted = true;
                Log.d(TAG, "Removed stale orphan capture directory: " + captureId);
            } else {
                Log.w(TAG, "Failed to remove orphan capture " + captureId + ": " + r.getMessage());
            }
        }
        return anyDeleted;
    }

    private static String formatBytes(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return String.format("%.1f KB", bytes / 1024.0);
        }
        if (bytes < 1024 * 1024 * 1024) {
            return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
        }
        return String.format("%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }
}
