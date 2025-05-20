package com.augmentos.asg_client.camera;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.channels.FileLock;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Renamed from PhotoUploadService to MediaUploadService
import com.augmentos.asg_client.camera.upload.MediaUploadService;

/**
 * Manages a queue of media (photos/videos) to be uploaded.
 * Provides persistence, retry mechanism, and robust error handling.
 */
public class MediaUploadQueueManager {
    private static final String TAG = "MediaUploadQueueManager"; // Renamed TAG

    // Directory and file names for persistence
    private static final String QUEUE_DIR_NAME = "media_queue"; // Renamed directory
    private static final String MANIFEST_FILENAME = "queue_manifest.json";

    // Media type constants
    public static final int MEDIA_TYPE_PHOTO = 1;
    public static final int MEDIA_TYPE_VIDEO = 2;

    // Status constants (remain the same)
    public static final String STATUS_QUEUED = "queued";
    public static final String STATUS_UPLOADING = "uploading";
    public static final String STATUS_COMPLETED = "completed";
    public static final String STATUS_FAILED = "failed";

    // File lock timeout (milliseconds)
    private static final long LOCK_TIMEOUT_MS = 5000;

    // Context and directories
    private final Context mContext;
    private final File mQueueDir;
    private final File mManifestFile;

    // Thread pool for async operations
    private final ExecutorService mExecutor;

    // Callbacks
    public interface MediaQueueCallback { // Renamed interface
        void onMediaQueued(String requestId, String filePath, int mediaType);

        void onMediaUploaded(String requestId, String url, int mediaType);

        void onMediaUploadFailed(String requestId, String error, int mediaType);
    }

    private MediaQueueCallback mCallback;

    /**
     * Constructor - initializes the queue directory and manifest file
     *
     * @param context Application context
     */
    public MediaUploadQueueManager(@NonNull Context context) {
        mContext = context.getApplicationContext();
        mQueueDir = new File(mContext.getExternalFilesDir(null), QUEUE_DIR_NAME);
        mManifestFile = new File(mQueueDir, MANIFEST_FILENAME);
        mExecutor = Executors.newSingleThreadExecutor();

        // Create queue directory if it doesn't exist
        if (!mQueueDir.exists()) {
            if (!mQueueDir.mkdirs()) {
                Log.e(TAG, "Failed to create queue directory: " + mQueueDir.getAbsolutePath());
            }
        }

        // Create manifest file if it doesn't exist
        if (!mManifestFile.exists()) {
            try {
                createEmptyManifest();
            } catch (IOException | JSONException e) {
                Log.e(TAG, "Failed to create manifest file", e);
            }
        } else {
            // Validate manifest file on startup
            try {
                validateManifest();
            } catch (IOException | JSONException e) {
                Log.e(TAG, "Failed to validate manifest file", e);
                // Create a new manifest if validation fails
                try {
                    createEmptyManifest();
                } catch (IOException | JSONException e2) {
                    Log.e(TAG, "Failed to recreate manifest file", e2);
                }
            }
        }
    }

    /**
     * Set a callback for queue events
     */
    public void setMediaQueueCallback(MediaQueueCallback callback) { // Renamed method
        mCallback = callback;
    }

    /**
     * Create an empty manifest file
     */
    private void createEmptyManifest() throws IOException, JSONException {
        JSONObject manifest = new JSONObject();
        JSONArray mediaItems = new JSONArray(); // Renamed from photos
        manifest.put("mediaItems", mediaItems); // Renamed field
        manifest.put("lastUpdated", System.currentTimeMillis());

        writeManifest(manifest);
    }

    /**
     * Validate the manifest file and ensure it's properly structured
     */
    private void validateManifest() throws IOException, JSONException {
        JSONObject manifest = readManifest();

        // Check for required fields
        if (!manifest.has("mediaItems") || !manifest.has("lastUpdated")) { // Updated field name
            throw new JSONException("Manifest file is missing required fields");
        }

        // Verify mediaItems array
        if (!(manifest.get("mediaItems") instanceof JSONArray)) { // Updated field name
            throw new JSONException("Manifest 'mediaItems' field is not an array");
        }

        // Validate timestamp
        if (!(manifest.get("lastUpdated") instanceof Long)) {
            throw new JSONException("Manifest 'lastUpdated' field is not a valid timestamp");
        }
    }

    /**
     * Queue a media file for upload with an app ID
     *
     * @param mediaFilePath Path to the media file
     * @param requestId     Request ID associated with this media
     * @param mediaType     Type of media (PHOTO or VIDEO)
     * @return true if successfully queued, false otherwise
     */
    public boolean queueMedia(String mediaFilePath, String requestId, int mediaType) {
        File mediaFile = new File(mediaFilePath);

        // Check if file exists
        if (!mediaFile.exists()) {
            Log.e(TAG, "Failed to queue media - file does not exist: " + mediaFilePath);
            return false;
        }

        // Generate filename based on media type
        String extension = (mediaType == MEDIA_TYPE_PHOTO) ? ".jpg" : ".mp4";
        String queuedFilename = "media_" + System.currentTimeMillis() + "_" + requestId + extension;
        File queuedFile = new File(mQueueDir, queuedFilename);

        try {
            // Copy the file
            copyFile(mediaFile, queuedFile);

            // Add to manifest
            JSONObject mediaEntry = new JSONObject();
            mediaEntry.put("requestId", requestId);
            mediaEntry.put("originalPath", mediaFilePath);
            mediaEntry.put("queuedPath", queuedFile.getAbsolutePath());
            mediaEntry.put("mediaType", mediaType); // Added mediaType field
            mediaEntry.put("status", STATUS_QUEUED);
            mediaEntry.put("queuedTime", System.currentTimeMillis());
            mediaEntry.put("retryCount", 0);

            boolean added = addMediaToManifest(mediaEntry);

            if (added) {
                Log.d(TAG, "Media queued successfully: " + requestId + " (type: " + mediaType + ")");

                // Notify callback
                if (mCallback != null) {
                    mCallback.onMediaQueued(requestId, queuedFile.getAbsolutePath(), mediaType);
                }

                // Schedule upload
                processQueue();

                return true;
            } else {
                // Clean up copied file if adding to manifest failed
                queuedFile.delete();
                Log.e(TAG, "Failed to add media to manifest: " + requestId);
                return false;
            }

        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error queueing media", e);

            // Clean up copied file if there was an error
            queuedFile.delete();

            return false;
        }
    }

    /**
     * Process the queue and upload any pending media items
     */
    public void processQueue() {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray mediaItems = manifest.getJSONArray("mediaItems");

                // Process each media item in the queue
                int processed = 0;
                for (int i = 0; i < mediaItems.length(); i++) {
                    JSONObject media = mediaItems.getJSONObject(i);
                    String status = media.getString("status");

                    // Only process queued media in this pass
                    if (STATUS_QUEUED.equals(status)) {
                        String requestId = media.getString("requestId");
                        String appId = media.getString("appId");
                        String queuedPath = media.getString("queuedPath");
                        int mediaType = media.getInt("mediaType"); // Get mediaType

                        // Update status to uploading
                        media.put("status", STATUS_UPLOADING);
                        media.put("uploadStartTime", System.currentTimeMillis());
                        updateMediaInManifest(i, media);

                        // Attempt to upload the media
                        uploadMedia(queuedPath, requestId, appId, mediaType, i);

                        processed++;
                    }
                }

                if (processed > 0) {
                    Log.d(TAG, "Started uploading " + processed + " media items from queue");
                }

            } catch (IOException | JSONException e) {
                Log.e(TAG, "Error processing queue", e);
            }
        });
    }

    /**
     * Upload a media item from the queue
     */
    private void uploadMedia(String queuedPath, String requestId, String appId, int mediaType, int index) {
        MediaUploadService.uploadMedia(
                mContext,
                queuedPath,
                requestId,
                mediaType, // Pass mediaType
                new MediaUploadService.UploadCallback() {
                    @Override
                    public void onSuccess(String url) {
                        handleUploadSuccess(requestId, url, mediaType, index);
                    }

                    @Override
                    public void onFailure(String errorMessage) {
                        handleUploadFailure(requestId, errorMessage, mediaType, index);
                    }
                }
        );
    }

    /**
     * Handle a successful media upload
     */
    private void handleUploadSuccess(String requestId, String url, int mediaType, int index) {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray mediaItems = manifest.getJSONArray("mediaItems");

                // Make sure the index is still valid
                if (index >= 0 && index < mediaItems.length()) {
                    JSONObject media = mediaItems.getJSONObject(index);

                    // Verify this is the same media item (by requestId)
                    if (requestId.equals(media.getString("requestId"))) {
                        // Update status and add URL
                        media.put("status", STATUS_COMPLETED);
                        media.put("mediaUrl", url); // Changed from photoUrl
                        media.put("completedTime", System.currentTimeMillis());

                        // Update in manifest
                        boolean updated = updateMediaInManifest(index, media);

                        if (updated) {
                            Log.d(TAG, "Media upload successful: " + requestId + ", URL: " + url);

                            // Delete the queued file
                            String queuedPath = media.getString("queuedPath");
                            new File(queuedPath).delete();

                            // Notify callback
                            if (mCallback != null) {
                                mCallback.onMediaUploaded(requestId, url, mediaType);
                            }

                            // Schedule cleanup of completed items
                            cleanupCompleted();
                        }
                    }
                }

            } catch (IOException | JSONException e) {
                Log.e(TAG, "Error handling upload success", e);
            }
        });
    }

    /**
     * Handle a failed media upload attempt
     */
    private void handleUploadFailure(String requestId, String errorMessage, int mediaType, int index) {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray mediaItems = manifest.getJSONArray("mediaItems");

                // Make sure the index is still valid
                if (index >= 0 && index < mediaItems.length()) {
                    JSONObject media = mediaItems.getJSONObject(index);

                    // Verify this is the same media item (by requestId)
                    if (requestId.equals(media.getString("requestId"))) {
                        // Update retry count and status
                        int retryCount = media.getInt("retryCount") + 1;
                        media.put("retryCount", retryCount);
                        media.put("status", STATUS_FAILED);
                        media.put("lastError", errorMessage);
                        media.put("failedTime", System.currentTimeMillis());

                        // Update in manifest
                        boolean updated = updateMediaInManifest(index, media);

                        if (updated) {
                            Log.d(TAG, "Media upload failed: " + requestId + ", error: " + errorMessage);

                            // Notify callback
                            if (mCallback != null) {
                                mCallback.onMediaUploadFailed(requestId, errorMessage, mediaType);
                            }
                        }
                    }
                }

            } catch (IOException | JSONException e) {
                Log.e(TAG, "Error handling upload failure", e);
            }
        });
    }

    /**
     * Clean up completed media items from the manifest
     */
    private void cleanupCompleted() {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray mediaItems = manifest.getJSONArray("mediaItems");

                // Create a new array without completed items
                JSONArray updatedMediaItems = new JSONArray();
                int removed = 0;

                for (int i = 0; i < mediaItems.length(); i++) {
                    JSONObject media = mediaItems.getJSONObject(i);
                    String status = media.getString("status");

                    // Keep all non-completed media
                    if (!STATUS_COMPLETED.equals(status)) {
                        updatedMediaItems.put(media);
                    } else {
                        removed++;
                    }
                }

                // Update manifest with filtered list
                manifest.put("mediaItems", updatedMediaItems);
                manifest.put("lastUpdated", System.currentTimeMillis());

                writeManifest(manifest);

                if (removed > 0) {
                    Log.d(TAG, "Cleaned up " + removed + " completed media items from queue");
                }

            } catch (IOException | JSONException e) {
                Log.e(TAG, "Error cleaning up completed media", e);
            }
        });
    }

    /**
     * Retry failed uploads
     *
     * @param maxRetries Maximum retry count (media items with more retries will not be retried)
     * @return Number of media items that will be retried
     */
    public int retryFailedUploads(int maxRetries) {
        try {
            JSONObject manifest = readManifest();
            JSONArray mediaItems = manifest.getJSONArray("mediaItems");

            int retryCount = 0;

            // Find failed media to retry
            for (int i = 0; i < mediaItems.length(); i++) {
                JSONObject media = mediaItems.getJSONObject(i);
                String status = media.getString("status");

                if (STATUS_FAILED.equals(status)) {
                    int attempts = media.getInt("retryCount");

                    // Only retry if under max retry count
                    if (attempts <= maxRetries) {
                        // Reset to queued status
                        media.put("status", STATUS_QUEUED);
                        updateMediaInManifest(i, media);
                        retryCount++;
                    }
                }
            }

            // If any media were marked for retry, process the queue
            if (retryCount > 0) {
                processQueue();
            }

            return retryCount;

        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error retrying failed uploads", e);
            return 0;
        }
    }

    /**
     * Get a list of queued media information
     *
     * @return List of media information objects
     */
    public List<JSONObject> getQueuedMedia() { // Renamed method
        List<JSONObject> queuedMedia = new ArrayList<>();

        try {
            JSONObject manifest = readManifest();
            JSONArray mediaItems = manifest.getJSONArray("mediaItems");

            for (int i = 0; i < mediaItems.length(); i++) {
                queuedMedia.add(mediaItems.getJSONObject(i));
            }

        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error getting queued media", e);
        }

        return queuedMedia;
    }

    /**
     * Get statistics about the queue
     *
     * @return JSONObject with queue statistics
     */
    public JSONObject getQueueStats() {
        JSONObject stats = new JSONObject();

        try {
            JSONObject manifest = readManifest();
            JSONArray mediaItems = manifest.getJSONArray("mediaItems");

            int totalCount = mediaItems.length();
            int queuedCount = 0;
            int uploadingCount = 0;
            int completedCount = 0;
            int failedCount = 0;

            for (int i = 0; i < mediaItems.length(); i++) {
                JSONObject media = mediaItems.getJSONObject(i);
                String status = media.getString("status");

                switch (status) {
                    case STATUS_QUEUED:
                        queuedCount++;
                        break;
                    case STATUS_UPLOADING:
                        uploadingCount++;
                        break;
                    case STATUS_COMPLETED:
                        completedCount++;
                        break;
                    case STATUS_FAILED:
                        failedCount++;
                        break;
                }
            }

            stats.put("totalCount", totalCount);
            stats.put("queuedCount", queuedCount);
            stats.put("uploadingCount", uploadingCount);
            stats.put("completedCount", completedCount);
            stats.put("failedCount", failedCount);
            stats.put("lastUpdated", manifest.getLong("lastUpdated"));

        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error getting queue stats", e);
        }

        return stats;
    }

    /**
     * Rebuild the manifest file by scanning the queue directory
     * This can be used to recover from manifest corruption
     *
     * @return true if successful, false otherwise
     */
    public boolean rebuildManifest() {
        try {
            // Create a new manifest
            JSONObject manifest = new JSONObject();
            JSONArray mediaItems = new JSONArray();

            // List all files in the queue directory
            File[] files = mQueueDir.listFiles((dir, name) ->
                    (name.startsWith("media_") && name.endsWith(".jpg")) ||
                            (name.startsWith("media_") && name.endsWith(".mp4")));

            if (files != null) {
                // Process each media file
                for (File file : files) {
                    String filename = file.getName();

                    // Try to extract requestId from filename (format: media_timestamp_requestId.ext)
                    String[] parts = filename.split("_", 3);
                    String requestId = "unknown";
                    long timestamp = System.currentTimeMillis();
                    int mediaType = MEDIA_TYPE_PHOTO; // Default to photo

                    if (parts.length >= 3) {
                        // Extract timestamp
                        try {
                            timestamp = Long.parseLong(parts[1]);
                        } catch (NumberFormatException e) {
                            // Use current time if parsing fails
                        }

                        // Extract requestId (remove extension)
                        int extensionIndex = parts[2].lastIndexOf('.');
                        if (extensionIndex > 0) {
                            requestId = parts[2].substring(0, extensionIndex);
                            String extension = parts[2].substring(extensionIndex);
                            if (".mp4".equalsIgnoreCase(extension)) {
                                mediaType = MEDIA_TYPE_VIDEO;
                            }
                        } else {
                            requestId = parts[2]; // No extension found
                        }
                    }

                    // Create a new entry for this file
                    JSONObject mediaEntry = new JSONObject();
                    mediaEntry.put("requestId", requestId);
                    mediaEntry.put("appId", "system");
                    mediaEntry.put("originalPath", "");
                    mediaEntry.put("queuedPath", file.getAbsolutePath());
                    mediaEntry.put("mediaType", mediaType);
                    mediaEntry.put("status", STATUS_QUEUED);
                    mediaEntry.put("queuedTime", timestamp);
                    mediaEntry.put("retryCount", 0);

                    mediaItems.put(mediaEntry);
                }
            }

            // Save the new manifest
            manifest.put("mediaItems", mediaItems);
            manifest.put("lastUpdated", System.currentTimeMillis());

            writeManifest(manifest);

            Log.d(TAG, "Manifest rebuilt with " + (files != null ? files.length : 0) + " media items");
            return true;

        } catch (IOException | JSONException e) {
            Log.e(TAG, "Failed to rebuild manifest", e);
            return false;
        }
    }

    /**
     * Add a media entry to the manifest
     *
     * @param mediaEntry JSON object with media information
     * @return true if successful, false otherwise
     */
    private boolean addMediaToManifest(JSONObject mediaEntry) throws IOException, JSONException {
        // Lock the manifest file
        FileOutputStream lockStream = new FileOutputStream(mManifestFile, true);
        FileLock lock = null;

        try {
            // Try to acquire lock with timeout
            long startTime = System.currentTimeMillis();
            while (lock == null && System.currentTimeMillis() - startTime < LOCK_TIMEOUT_MS) {
                try {
                    lock = lockStream.getChannel().tryLock();
                } catch (IOException e) {
                    // Failed to lock, wait and retry
                    try {
                        Thread.sleep(50);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new IOException("Interrupted while waiting for manifest lock", ie);
                    }
                }
            }

            if (lock == null) {
                throw new IOException("Failed to acquire manifest lock within timeout");
            }

            // Read current manifest
            JSONObject manifest = readManifest();
            JSONArray mediaItems = manifest.getJSONArray("mediaItems");

            // Add the new media entry
            mediaItems.put(mediaEntry);

            // Update timestamp
            manifest.put("lastUpdated", System.currentTimeMillis());

            // Write updated manifest
            writeManifest(manifest);

            return true;

        } finally {
            // Release lock and close stream
            if (lock != null) {
                lock.release();
            }
            lockStream.close();
        }
    }

    /**
     * Update a media entry in the manifest
     *
     * @param index      Index of the media item to update
     * @param mediaEntry Updated JSON object with media information
     * @return true if successful, false otherwise
     */
    private boolean updateMediaInManifest(int index, JSONObject mediaEntry) throws IOException, JSONException {
        // Lock the manifest file
        FileOutputStream lockStream = new FileOutputStream(mManifestFile, true);
        FileLock lock = null;

        try {
            // Try to acquire lock with timeout
            long startTime = System.currentTimeMillis();
            while (lock == null && System.currentTimeMillis() - startTime < LOCK_TIMEOUT_MS) {
                try {
                    lock = lockStream.getChannel().tryLock();
                } catch (IOException e) {
                    // Failed to lock, wait and retry
                    try {
                        Thread.sleep(50);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new IOException("Interrupted while waiting for manifest lock", ie);
                    }
                }
            }

            if (lock == null) {
                throw new IOException("Failed to acquire manifest lock within timeout");
            }

            // Read current manifest
            JSONObject manifest = readManifest();
            JSONArray mediaItems = manifest.getJSONArray("mediaItems");

            // Validate index
            if (index < 0 || index >= mediaItems.length()) {
                throw new IndexOutOfBoundsException("Invalid media index: " + index);
            }

            // Update the media entry at the specified index
            mediaItems.put(index, mediaEntry);

            // Update timestamp
            manifest.put("lastUpdated", System.currentTimeMillis());

            // Write updated manifest
            writeManifest(manifest);

            return true;

        } finally {
            // Release lock and close stream
            if (lock != null) {
                lock.release();
            }
            lockStream.close();
        }
    }

    /**
     * Read the manifest file
     *
     * @return JSONObject with manifest contents
     */
    private JSONObject readManifest() throws IOException, JSONException {
        if (!mManifestFile.exists()) {
            // If manifest doesn't exist, create an empty one
            createEmptyManifest();
        }

        // Read the manifest file
        StringBuilder jsonString = new StringBuilder();
        try (FileInputStream input = new FileInputStream(mManifestFile)) {
            byte[] buffer = new byte[1024];
            int bytesRead;

            while ((bytesRead = input.read(buffer)) != -1) {
                jsonString.append(new String(buffer, 0, bytesRead));
            }
        }

        return new JSONObject(jsonString.toString());
    }

    /**
     * Write manifest to file
     *
     * @param manifest JSONObject to write
     */
    private void writeManifest(JSONObject manifest) throws IOException {
        // Ensure the directory exists
        if (!mQueueDir.exists()) {
            if (!mQueueDir.mkdirs()) {
                throw new IOException("Failed to create queue directory");
            }
        }

        // Write to temporary file first
        File tempFile = new File(mQueueDir, MANIFEST_FILENAME + ".tmp");
        try (FileOutputStream output = new FileOutputStream(tempFile)) {
            byte[] jsonBytes = manifest.toString(2).getBytes();
            output.write(jsonBytes);
            output.getFD().sync(); // Ensure data is written to disk
        } catch (JSONException e) {
            throw new RuntimeException(e);
        }

        // Atomic rename to ensure consistency
        if (!tempFile.renameTo(mManifestFile)) {
            throw new IOException("Failed to update manifest file (rename failed)");
        }
    }

    /**
     * Copy a file from source to destination
     */
    private void copyFile(File source, File destination) throws IOException {
        try (FileInputStream in = new FileInputStream(source);
             FileOutputStream out = new FileOutputStream(destination)) {

            byte[] buffer = new byte[8192];
            int bytesRead;

            while ((bytesRead = in.read(buffer)) != -1) {
                out.write(buffer, 0, bytesRead);
            }

            out.getFD().sync(); // Ensure all data is written to disk
        }
    }

    /**
     * Check if the queue is empty
     *
     * @return true if the queue is empty, false otherwise
     */
    public boolean isQueueEmpty() {
        try {
            JSONObject manifest = readManifest();
            JSONArray mediaItems = manifest.getJSONArray("mediaItems");
            return mediaItems.length() == 0;
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error checking if queue is empty", e);
            return true;
        }
    }

    /**
     * Remove all media items from the queue
     *
     * @return Number of media items removed
     */
    public int clearQueue() {
        try {
            JSONObject manifest = readManifest();
            JSONArray mediaItems = manifest.getJSONArray("mediaItems");
            int count = mediaItems.length();

            // Delete all queued files
            for (int i = 0; i < mediaItems.length(); i++) {
                JSONObject media = mediaItems.getJSONObject(i);
                String filePath = media.getString("queuedPath");
                new File(filePath).delete();
            }

            // Create new empty manifest
            createEmptyManifest();

            return count;
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error clearing queue", e);
            return 0;
        }
    }

    /**
     * Get the path to the queue directory
     *
     * @return File object representing the queue directory
     */
    public File getQueueDirectory() {
        return mQueueDir;
    }
}
