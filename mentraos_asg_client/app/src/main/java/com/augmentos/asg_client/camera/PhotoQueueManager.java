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

import com.augmentos.augmentos_core.smarterglassesmanager.camera.PhotoUploadService;

/**
 * Manages a queue of photos to be uploaded to AugmentOS Cloud.
 * Provides persistence, retry mechanism, and robust error handling.
 */
public class PhotoQueueManager {
    private static final String TAG = "PhotoQueueManager";
    
    // Directory and file names for persistence
    private static final String QUEUE_DIR_NAME = "photo_queue";
    private static final String MANIFEST_FILENAME = "queue_manifest.json";
    
    // Photo status constants
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
    public interface QueueCallback {
        void onPhotoQueued(String requestId, String filePath);
        void onPhotoUploaded(String requestId, String url);
        void onPhotoUploadFailed(String requestId, String error);
    }
    
    private QueueCallback mCallback;
    
    /**
     * Constructor - initializes the queue directory and manifest file
     * 
     * @param context Application context
     */
    public PhotoQueueManager(@NonNull Context context) {
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
    public void setQueueCallback(QueueCallback callback) {
        mCallback = callback;
    }
    
    /**
     * Create an empty manifest file
     */
    private void createEmptyManifest() throws IOException, JSONException {
        JSONObject manifest = new JSONObject();
        JSONArray photos = new JSONArray();
        manifest.put("photos", photos);
        manifest.put("lastUpdated", System.currentTimeMillis());
        
        writeManifest(manifest);
    }
    
    /**
     * Validate the manifest file and ensure it's properly structured
     */
    private void validateManifest() throws IOException, JSONException {
        JSONObject manifest = readManifest();
        
        // Check for required fields
        if (!manifest.has("photos") || !manifest.has("lastUpdated")) {
            throw new JSONException("Manifest file is missing required fields");
        }
        
        // Verify photos array
        if (!(manifest.get("photos") instanceof JSONArray)) {
            throw new JSONException("Manifest 'photos' field is not an array");
        }
        
        // Validate timestamp
        if (!(manifest.get("lastUpdated") instanceof Long)) {
            throw new JSONException("Manifest 'lastUpdated' field is not a valid timestamp");
        }
    }
    
    /**
     * Queue a photo for upload
     * 
     * @param photoFilePath Path to the photo file
     * @param requestId Request ID associated with this photo
]     * @return true if successfully queued, false otherwise
     */
    public boolean queuePhoto(String photoFilePath, String requestId) {
        return queuePhoto(photoFilePath, requestId, "system");
    }
    
    /**
     * Queue a photo for upload with an app ID
     * 
     * @param photoFilePath Path to the photo file
     * @param requestId Request ID associated with this photo
     * @param appId App ID that requested the photo
     * @return true if successfully queued, false otherwise
     */
    public boolean queuePhoto(String photoFilePath, String requestId, String appId) {
        File photoFile = new File(photoFilePath);
        
        // Check if file exists
        if (!photoFile.exists()) {
            Log.e(TAG, "Failed to queue photo - file does not exist: " + photoFilePath);
            return false;
        }
        
        // Copy file to queue directory
        String queuedFilename = "photo_" + System.currentTimeMillis() + "_" + requestId + ".jpg";
        File queuedFile = new File(mQueueDir, queuedFilename);
        
        try {
            // Copy the file
            copyFile(photoFile, queuedFile);
            
            // Add to manifest
            JSONObject photoEntry = new JSONObject();
            photoEntry.put("requestId", requestId);
            photoEntry.put("appId", appId);
            photoEntry.put("originalPath", photoFilePath);
            photoEntry.put("queuedPath", queuedFile.getAbsolutePath());
            photoEntry.put("status", STATUS_QUEUED);
            photoEntry.put("queuedTime", System.currentTimeMillis());
            photoEntry.put("retryCount", 0);
            
            boolean added = addPhotoToManifest(photoEntry);
            
            if (added) {
                Log.d(TAG, "Photo queued successfully: " + requestId);
                
                // Notify callback
                if (mCallback != null) {
                    mCallback.onPhotoQueued(requestId, queuedFile.getAbsolutePath());
                }
                
                // Schedule upload
                processQueue();
                
                return true;
            } else {
                // Clean up copied file if adding to manifest failed
                queuedFile.delete();
                Log.e(TAG, "Failed to add photo to manifest: " + requestId);
                return false;
            }
            
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error queueing photo", e);
            
            // Clean up copied file if there was an error
            queuedFile.delete();
            
            return false;
        }
    }
    
    /**
     * Process the queue and upload any pending photos
     */
    public void processQueue() {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray photos = manifest.getJSONArray("photos");
                
                // Process each photo in the queue
                int processed = 0;
                for (int i = 0; i < photos.length(); i++) {
                    JSONObject photo = photos.getJSONObject(i);
                    String status = photo.getString("status");
                    
                    // Only process queued photos in this pass
                    if (STATUS_QUEUED.equals(status)) {
                        String requestId = photo.getString("requestId");
                        String appId = photo.getString("appId");
                        String queuedPath = photo.getString("queuedPath");
                        
                        // Update status to uploading
                        photo.put("status", STATUS_UPLOADING);
                        photo.put("uploadStartTime", System.currentTimeMillis());
                        updatePhotoInManifest(i, photo);
                        
                        // Attempt to upload the photo
                        uploadPhoto(queuedPath, requestId, appId, i);
                        
                        processed++;
                    }
                }
                
                if (processed > 0) {
                    Log.d(TAG, "Started uploading " + processed + " photos from queue");
                }
                
            } catch (IOException | JSONException e) {
                Log.e(TAG, "Error processing queue", e);
            }
        });
    }
    
    /**
     * Upload a photo from the queue
     */
    private void uploadPhoto(String queuedPath, String requestId, String appId, int index) {
        PhotoUploadService.uploadPhoto(
            mContext,
            queuedPath,
            requestId,
            new PhotoUploadService.UploadCallback() {
                @Override
                public void onSuccess(String url) {
                    handleUploadSuccess(requestId, url, index);
                }
                
                @Override
                public void onFailure(String errorMessage) {
                    handleUploadFailure(requestId, errorMessage, index);
                }
            }
        );
    }
    
    /**
     * Handle a successful photo upload
     */
    private void handleUploadSuccess(String requestId, String url, int index) {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray photos = manifest.getJSONArray("photos");
                
                // Make sure the index is still valid
                if (index >= 0 && index < photos.length()) {
                    JSONObject photo = photos.getJSONObject(index);
                    
                    // Verify this is the same photo (by requestId)
                    if (requestId.equals(photo.getString("requestId"))) {
                        // Update status and add URL
                        photo.put("status", STATUS_COMPLETED);
                        photo.put("photoUrl", url);
                        photo.put("completedTime", System.currentTimeMillis());
                        
                        // Update in manifest
                        boolean updated = updatePhotoInManifest(index, photo);
                        
                        if (updated) {
                            Log.d(TAG, "Photo upload successful: " + requestId + ", URL: " + url);
                            
                            // Delete the queued file
                            String queuedPath = photo.getString("queuedPath");
                            new File(queuedPath).delete();
                            
                            // Notify callback
                            if (mCallback != null) {
                                mCallback.onPhotoUploaded(requestId, url);
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
     * Handle a failed photo upload attempt
     */
    private void handleUploadFailure(String requestId, String errorMessage, int index) {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray photos = manifest.getJSONArray("photos");
                
                // Make sure the index is still valid
                if (index >= 0 && index < photos.length()) {
                    JSONObject photo = photos.getJSONObject(index);
                    
                    // Verify this is the same photo (by requestId)
                    if (requestId.equals(photo.getString("requestId"))) {
                        // Update retry count and status
                        int retryCount = photo.getInt("retryCount") + 1;
                        photo.put("retryCount", retryCount);
                        photo.put("status", STATUS_FAILED);
                        photo.put("lastError", errorMessage);
                        photo.put("failedTime", System.currentTimeMillis());
                        
                        // Update in manifest
                        boolean updated = updatePhotoInManifest(index, photo);
                        
                        if (updated) {
                            Log.d(TAG, "Photo upload failed: " + requestId + ", error: " + errorMessage);
                            
                            // Notify callback
                            if (mCallback != null) {
                                mCallback.onPhotoUploadFailed(requestId, errorMessage);
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
     * Clean up completed photos from the manifest
     */
    private void cleanupCompleted() {
        mExecutor.execute(() -> {
            try {
                JSONObject manifest = readManifest();
                JSONArray photos = manifest.getJSONArray("photos");
                
                // Create a new array without completed items
                JSONArray updatedPhotos = new JSONArray();
                int removed = 0;
                
                for (int i = 0; i < photos.length(); i++) {
                    JSONObject photo = photos.getJSONObject(i);
                    String status = photo.getString("status");
                    
                    // Keep all non-completed photos
                    if (!STATUS_COMPLETED.equals(status)) {
                        updatedPhotos.put(photo);
                    } else {
                        removed++;
                    }
                }
                
                // Update manifest with filtered list
                manifest.put("photos", updatedPhotos);
                manifest.put("lastUpdated", System.currentTimeMillis());
                
                writeManifest(manifest);
                
                if (removed > 0) {
                    Log.d(TAG, "Cleaned up " + removed + " completed photos from queue");
                }
                
            } catch (IOException | JSONException e) {
                Log.e(TAG, "Error cleaning up completed photos", e);
            }
        });
    }
    
    /**
     * Retry failed uploads
     * 
     * @param maxRetries Maximum retry count (photos with more retries will not be retried)
     * @return Number of photos that will be retried
     */
    public int retryFailedUploads(int maxRetries) {
        try {
            JSONObject manifest = readManifest();
            JSONArray photos = manifest.getJSONArray("photos");
            
            int retryCount = 0;
            
            // Find failed photos to retry
            for (int i = 0; i < photos.length(); i++) {
                JSONObject photo = photos.getJSONObject(i);
                String status = photo.getString("status");
                
                if (STATUS_FAILED.equals(status)) {
                    int attempts = photo.getInt("retryCount");
                    
                    // Only retry if under max retry count
                    if (attempts <= maxRetries) {
                        // Reset to queued status
                        photo.put("status", STATUS_QUEUED);
                        updatePhotoInManifest(i, photo);
                        retryCount++;
                    }
                }
            }
            
            // If any photos were marked for retry, process the queue
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
     * Get a list of queued photo information
     * 
     * @return List of photo information objects
     */
    public List<JSONObject> getQueuedPhotos() {
        List<JSONObject> queuedPhotos = new ArrayList<>();
        
        try {
            JSONObject manifest = readManifest();
            JSONArray photos = manifest.getJSONArray("photos");
            
            for (int i = 0; i < photos.length(); i++) {
                queuedPhotos.add(photos.getJSONObject(i));
            }
            
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error getting queued photos", e);
        }
        
        return queuedPhotos;
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
            JSONArray photos = manifest.getJSONArray("photos");
            
            int totalCount = photos.length();
            int queuedCount = 0;
            int uploadingCount = 0;
            int completedCount = 0;
            int failedCount = 0;
            
            for (int i = 0; i < photos.length(); i++) {
                JSONObject photo = photos.getJSONObject(i);
                String status = photo.getString("status");
                
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
            JSONArray photos = new JSONArray();
            
            // List all files in the queue directory
            File[] files = mQueueDir.listFiles((dir, name) -> 
                    name.startsWith("photo_") && name.endsWith(".jpg"));
            
            if (files != null) {
                // Process each photo file
                for (File file : files) {
                    String filename = file.getName();
                    
                    // Try to extract requestId from filename (format: photo_timestamp_requestId.jpg)
                    String[] parts = filename.split("_", 3);
                    String requestId = "unknown";
                    long timestamp = System.currentTimeMillis();
                    
                    if (parts.length >= 3) {
                        // Extract timestamp
                        try {
                            timestamp = Long.parseLong(parts[1]);
                        } catch (NumberFormatException e) {
                            // Use current time if parsing fails
                        }
                        
                        // Extract requestId (remove .jpg extension)
                        requestId = parts[2].substring(0, parts[2].length() - 4);
                    }
                    
                    // Create a new entry for this file
                    JSONObject photoEntry = new JSONObject();
                    photoEntry.put("requestId", requestId);
                    photoEntry.put("appId", "system");
                    photoEntry.put("originalPath", "");
                    photoEntry.put("queuedPath", file.getAbsolutePath());
                    photoEntry.put("status", STATUS_QUEUED);
                    photoEntry.put("queuedTime", timestamp);
                    photoEntry.put("retryCount", 0);
                    
                    photos.put(photoEntry);
                }
            }
            
            // Save the new manifest
            manifest.put("photos", photos);
            manifest.put("lastUpdated", System.currentTimeMillis());
            
            writeManifest(manifest);
            
            Log.d(TAG, "Manifest rebuilt with " + (files != null ? files.length : 0) + " photos");
            return true;
            
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Failed to rebuild manifest", e);
            return false;
        }
    }
    
    /**
     * Add a photo entry to the manifest
     * 
     * @param photoEntry JSON object with photo information
     * @return true if successful, false otherwise
     */
    private boolean addPhotoToManifest(JSONObject photoEntry) throws IOException, JSONException {
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
            JSONArray photos = manifest.getJSONArray("photos");
            
            // Add the new photo entry
            photos.put(photoEntry);
            
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
     * Update a photo entry in the manifest
     * 
     * @param index Index of the photo to update
     * @param photoEntry Updated JSON object with photo information
     * @return true if successful, false otherwise
     */
    private boolean updatePhotoInManifest(int index, JSONObject photoEntry) throws IOException, JSONException {
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
            JSONArray photos = manifest.getJSONArray("photos");
            
            // Validate index
            if (index < 0 || index >= photos.length()) {
                throw new IndexOutOfBoundsException("Invalid photo index: " + index);
            }
            
            // Update the photo entry at the specified index
            photos.put(index, photoEntry);
            
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
            JSONArray photos = manifest.getJSONArray("photos");
            return photos.length() == 0;
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Error checking if queue is empty", e);
            return true;
        }
    }
    
    /**
     * Remove all photos from the queue
     * 
     * @return Number of photos removed
     */
    public int clearQueue() {
        try {
            JSONObject manifest = readManifest();
            JSONArray photos = manifest.getJSONArray("photos");
            int count = photos.length();
            
            // Delete all queued files
            for (int i = 0; i < photos.length(); i++) {
                JSONObject photo = photos.getJSONObject(i);
                String filePath = photo.getString("queuedPath");
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