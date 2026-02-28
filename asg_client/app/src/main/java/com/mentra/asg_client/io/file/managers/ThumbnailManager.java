package com.mentra.asg_client.io.file.managers;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;

import com.mentra.asg_client.logging.Logger;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Manages video thumbnail generation and caching.
 * Follows Single Responsibility Principle by handling only thumbnail operations.
 */
public class ThumbnailManager {
    
    private static final String TAG = "ThumbnailManager";
    private static final String THUMBNAIL_DIR = "thumbnails";
    private static final int THUMBNAIL_WIDTH = 320;
    private static final int THUMBNAIL_HEIGHT = 240;
    private static final int THUMBNAIL_QUALITY = 80;
    
    private final File baseDirectory;
    private final Logger logger;
    private final File thumbnailDirectory;
    
    public ThumbnailManager(File baseDirectory, Logger logger) {
        this.baseDirectory = baseDirectory;
        this.logger = logger;
        this.thumbnailDirectory = new File(baseDirectory, THUMBNAIL_DIR);
        
        // Ensure thumbnail directory exists
        if (!thumbnailDirectory.exists() && !thumbnailDirectory.mkdirs()) {
            logger.error(TAG, "Failed to create thumbnail directory: " + thumbnailDirectory.getAbsolutePath());
        }
        
        logger.info(TAG, "ThumbnailManager initialized with directory: " + thumbnailDirectory.getAbsolutePath());
    }
    
    /**
     * Get or create thumbnail for a video file
     * @param videoFile The video file
     * @return Thumbnail file or null if failed
     */
    public File getOrCreateThumbnail(File videoFile) {
        if (videoFile == null || !videoFile.exists()) {
            logger.warn(TAG, "Video file is null or doesn't exist");
            return null;
        }
        
        // Check if it's actually a video file
        if (!isVideoFile(videoFile.getName())) {
            logger.debug(TAG, "File is not a video: " + videoFile.getName());
            return null;
        }
        
        // Generate thumbnail filename
        String thumbnailFileName = generateThumbnailFileName(videoFile);
        File thumbnailFile = new File(thumbnailDirectory, thumbnailFileName);
        
        // Check if thumbnail already exists and is newer than video file
        if (thumbnailFile.exists() && thumbnailFile.lastModified() >= videoFile.lastModified()) {
            logger.debug(TAG, "Using existing thumbnail: " + thumbnailFileName);
            return thumbnailFile;
        }
        
        // Create new thumbnail
        logger.info(TAG, "Creating thumbnail for video: " + videoFile.getName());
        return createThumbnail(videoFile, thumbnailFile);
    }
    
    /**
     * Create a thumbnail for a video file
     * @param videoFile The video file
     * @param thumbnailFile The target thumbnail file
     * @return Thumbnail file or null if failed
     */
    private File createThumbnail(File videoFile, File thumbnailFile) {
        MediaMetadataRetriever retriever = null;
        
        try {
            retriever = new MediaMetadataRetriever();
            retriever.setDataSource(videoFile.getAbsolutePath());
            
            // Extract frame at 1 second or first available frame
            Bitmap bitmap = retriever.getFrameAtTime(1000000); // 1 second in microseconds
            if (bitmap == null) {
                // Try to get the first frame
                bitmap = retriever.getFrameAtTime();
            }
            
            if (bitmap == null) {
                logger.error(TAG, "Failed to extract frame from video: " + videoFile.getName());
                return null;
            }
            
            // Resize bitmap to thumbnail size
            Bitmap thumbnail = Bitmap.createScaledBitmap(bitmap, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, true);
            
            // Compress and save
            try (FileOutputStream fos = new FileOutputStream(thumbnailFile)) {
                thumbnail.compress(Bitmap.CompressFormat.JPEG, THUMBNAIL_QUALITY, fos);
            }
            
            // Clean up bitmaps
            if (bitmap != thumbnail) {
                bitmap.recycle();
            }
            thumbnail.recycle();
            
            logger.info(TAG, "Thumbnail created successfully: " + thumbnailFile.getName() + 
                           " (" + thumbnailFile.length() + " bytes)");
            return thumbnailFile;
            
        } catch (Exception e) {
            logger.error(TAG, "Error creating thumbnail for " + videoFile.getName() + ": " + e.getMessage(), e);
            return null;
        } finally {
            if (retriever != null) {
                try {
                    retriever.release();
                } catch (Exception e) {
                    logger.warn(TAG, "Error releasing MediaMetadataRetriever: " + e.getMessage());
                }
            }
        }
    }
    
    /**
     * Check if a file is a video file
     * @param fileName The file name
     * @return true if it's a video file
     */
    private boolean isVideoFile(String fileName) {
        if (fileName == null) return false;
        
        String lowerFileName = fileName.toLowerCase();
        return lowerFileName.endsWith(".mp4") || 
               lowerFileName.endsWith(".avi") || 
               lowerFileName.endsWith(".mov") || 
               lowerFileName.endsWith(".wmv") || 
               lowerFileName.endsWith(".flv") || 
               lowerFileName.endsWith(".webm") || 
               lowerFileName.endsWith(".mkv") || 
               lowerFileName.endsWith(".3gp");
    }
    
    /**
     * Generate a unique thumbnail filename based on video file
     * @param videoFile The video file
     * @return Thumbnail filename
     */
    private String generateThumbnailFileName(File videoFile) {
        try {
            // Create a hash of the video file path and modification time
            String hashInput = videoFile.getAbsolutePath() + "_" + videoFile.lastModified();
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] hash = digest.digest(hashInput.getBytes(StandardCharsets.UTF_8));
            
            // Convert to hex string
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) {
                    hexString.append('0');
                }
                hexString.append(hex);
            }
            
            return hexString.toString() + ".jpg";
        } catch (NoSuchAlgorithmException e) {
            logger.error(TAG, "MD5 algorithm not available, using fallback naming", e);
            // Fallback: use filename hash
            return videoFile.getName().hashCode() + ".jpg";
        }
    }
    
    /**
     * Clean up old thumbnails that are no longer needed
     * @param maxAgeMs Maximum age in milliseconds
     * @return Number of thumbnails cleaned up
     */
    public int cleanupOldThumbnails(long maxAgeMs) {
        if (!thumbnailDirectory.exists()) {
            return 0;
        }
        
        File[] thumbnailFiles = thumbnailDirectory.listFiles();
        if (thumbnailFiles == null) {
            return 0;
        }
        
        int cleanedCount = 0;
        long currentTime = System.currentTimeMillis();
        
        for (File thumbnailFile : thumbnailFiles) {
            if (thumbnailFile.isFile() && 
                (currentTime - thumbnailFile.lastModified()) > maxAgeMs) {
                if (thumbnailFile.delete()) {
                    cleanedCount++;
                    logger.debug(TAG, "Cleaned up old thumbnail: " + thumbnailFile.getName());
                } else {
                    logger.warn(TAG, "Failed to delete old thumbnail: " + thumbnailFile.getName());
                }
            }
        }
        
        logger.info(TAG, "Thumbnail cleanup completed: " + cleanedCount + " files removed");
        return cleanedCount;
    }
    
    /**
     * Get thumbnail directory
     * @return Thumbnail directory
     */
    public File getThumbnailDirectory() {
        return thumbnailDirectory;
    }
    
    /**
     * Get thumbnail directory size
     * @return Size in bytes
     */
    public long getThumbnailDirectorySize() {
        if (!thumbnailDirectory.exists()) {
            return 0;
        }
        
        File[] files = thumbnailDirectory.listFiles();
        if (files == null) {
            return 0;
        }
        
        long totalSize = 0;
        for (File file : files) {
            if (file.isFile()) {
                totalSize += file.length();
            }
        }
        
        return totalSize;
    }
    
    /**
     * Get number of thumbnails
     * @return Number of thumbnail files
     */
    public int getThumbnailCount() {
        if (!thumbnailDirectory.exists()) {
            return 0;
        }
        
        File[] files = thumbnailDirectory.listFiles();
        return files != null ? files.length : 0;
    }
    
    /**
     * Delete thumbnail for a specific video file
     * @param videoFile The video file whose thumbnail should be deleted
     * @return true if thumbnail was deleted or didn't exist, false if deletion failed
     */
    public boolean deleteThumbnailForVideo(File videoFile) {
        if (videoFile == null) {
            logger.warn(TAG, "Cannot delete thumbnail for null video file");
            return true; // Not an error if file is null
        }
        
        // Check if it's actually a video file
        if (!isVideoFile(videoFile.getName())) {
            logger.debug(TAG, "File is not a video, no thumbnail to delete: " + videoFile.getName());
            return true; // Not an error if not a video
        }
        
        // Generate the thumbnail filename for this video
        String thumbnailFileName = generateThumbnailFileName(videoFile);
        File thumbnailFile = new File(thumbnailDirectory, thumbnailFileName);
        
        // Check if thumbnail exists
        if (!thumbnailFile.exists()) {
            logger.debug(TAG, "Thumbnail doesn't exist for video: " + videoFile.getName());
            return true; // Success - thumbnail doesn't exist
        }
        
        // Try to delete the thumbnail
        boolean deleted = thumbnailFile.delete();
        if (deleted) {
            logger.info(TAG, "Deleted thumbnail for video: " + videoFile.getName() + 
                          " (thumbnail: " + thumbnailFileName + ")");
        } else {
            logger.error(TAG, "Failed to delete thumbnail for video: " + videoFile.getName() + 
                           " (thumbnail: " + thumbnailFileName + ")");
        }
        
        return deleted;
    }
} 