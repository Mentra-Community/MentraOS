package com.mentra.asg_client.io.streaming.utils;

import android.content.Context;
import android.util.Log;

/**
 * Utility class for streaming operations.
 * Provides common functionality used across different streaming implementations.
 */
public class StreamingUtils {
    private static final String TAG = "StreamingUtils";
    
    /**
     * Validate RTMP URL format
     * @param rtmpUrl The RTMP URL to validate
     * @return true if valid, false otherwise
     */
    public static boolean isValidRtmpUrl(String rtmpUrl) {
        if (rtmpUrl == null || rtmpUrl.trim().isEmpty()) {
            return false;
        }
        
        // Basic RTMP URL validation
        String trimmedUrl = rtmpUrl.trim();
        return trimmedUrl.startsWith("rtmp://") || 
               trimmedUrl.startsWith("rtmps://") ||
               trimmedUrl.startsWith("rtmpt://");
    }
    
    /**
     * Extract stream key from RTMP URL
     * @param rtmpUrl The RTMP URL
     * @return The stream key or null if not found
     */
    public static String extractStreamKey(String rtmpUrl) {
        if (!isValidRtmpUrl(rtmpUrl)) {
            return null;
        }
        
        try {
            // Find the last slash and extract everything after it
            int lastSlashIndex = rtmpUrl.lastIndexOf('/');
            if (lastSlashIndex != -1 && lastSlashIndex < rtmpUrl.length() - 1) {
                return rtmpUrl.substring(lastSlashIndex + 1);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error extracting stream key from URL: " + rtmpUrl, e);
        }
        
        return null;
    }
    
    /**
     * Extract server URL from RTMP URL
     * @param rtmpUrl The RTMP URL
     * @return The server URL or null if not found
     */
    public static String extractServerUrl(String rtmpUrl) {
        if (!isValidRtmpUrl(rtmpUrl)) {
            return null;
        }
        
        try {
            // Find the last slash and extract everything before it
            int lastSlashIndex = rtmpUrl.lastIndexOf('/');
            if (lastSlashIndex != -1) {
                return rtmpUrl.substring(0, lastSlashIndex);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error extracting server URL from URL: " + rtmpUrl, e);
        }
        
        return null;
    }
    
    /**
     * Format duration in milliseconds to human readable string
     * @param durationMs Duration in milliseconds
     * @return Formatted duration string
     */
    public static String formatDuration(long durationMs) {
        if (durationMs < 0) {
            return "00:00";
        }
        
        long seconds = durationMs / 1000;
        long minutes = seconds / 60;
        long hours = minutes / 60;
        
        seconds = seconds % 60;
        minutes = minutes % 60;
        
        if (hours > 0) {
            return String.format("%02d:%02d:%02d", hours, minutes, seconds);
        } else {
            return String.format("%02d:%02d", minutes, seconds);
        }
    }
    
    /**
     * Format bitrate to human readable string
     * @param bitrateBits Bitrate in bits per second
     * @return Formatted bitrate string
     */
    public static String formatBitrate(int bitrateBits) {
        if (bitrateBits < 1000) {
            return bitrateBits + " bps";
        } else if (bitrateBits < 1000000) {
            return String.format("%.1f kbps", bitrateBits / 1000.0);
        } else {
            return String.format("%.1f Mbps", bitrateBits / 1000000.0);
        }
    }
    
    /**
     * Format file size in bytes to human readable string
     * @param bytes File size in bytes
     * @return Formatted file size string
     */
    public static String formatFileSize(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        } else if (bytes < 1024 * 1024) {
            return String.format("%.1f KB", bytes / 1024.0);
        } else if (bytes < 1024 * 1024 * 1024) {
            return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
        } else {
            return String.format("%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
        }
    }
    
    /**
     * Check if device has sufficient resources for streaming
     * @param context Application context
     * @return true if device can stream, false otherwise
     */
    public static boolean canDeviceStream(Context context) {
        // Basic checks for streaming capability
        // This could be expanded with more sophisticated checks
        
        try {
            // Check available memory
            Runtime runtime = Runtime.getRuntime();
            long maxMemory = runtime.maxMemory();
            long availableMemory = maxMemory - runtime.totalMemory() + runtime.freeMemory();
            
            // Require at least 100MB available memory
            long minRequiredMemory = 100 * 1024 * 1024; // 100MB
            
            if (availableMemory < minRequiredMemory) {
                Log.w(TAG, "Insufficient memory for streaming. Available: " + 
                      formatFileSize(availableMemory) + ", Required: " + 
                      formatFileSize(minRequiredMemory));
                return false;
            }
            
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error checking device streaming capability", e);
            return false;
        }
    }
    
    /**
     * Generate a unique stream ID
     * @return Unique stream ID
     */
    public static String generateStreamId() {
        return "stream_" + System.currentTimeMillis() + "_" + 
               (int)(Math.random() * 10000);
    }
} 