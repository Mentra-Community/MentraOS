package com.mentra.asg_client.io.streaming.interfaces;

import android.content.Context;

/**
 * Core interface for streaming services that provides unified streaming operations
 * across different streaming protocols and implementations.
 */
public interface IStreamingService {
    
    /**
     * Initialize the streaming service
     * @param context Application context
     */
    void initialize(Context context);
    
    /**
     * Set the streaming URL (RTMP, WebRTC, etc.)
     * @param url The streaming URL
     */
    void setStreamingUrl(String url);
    
    /**
     * Get the current streaming URL
     * @return The current streaming URL or null if not set
     */
    String getStreamingUrl();
    
    /**
     * Start streaming
     * @return true if streaming started successfully, false otherwise
     */
    boolean startStreaming();
    
    /**
     * Stop streaming
     * @return true if streaming stopped successfully, false otherwise
     */
    boolean stopStreaming();
    
    /**
     * Check if currently streaming
     * @return true if streaming, false otherwise
     */
    boolean isStreaming();
    
    /**
     * Check if currently reconnecting
     * @return true if reconnecting, false otherwise
     */
    boolean isReconnecting();
    
    /**
     * Get current reconnection attempt number
     * @return Current reconnection attempt number
     */
    int getReconnectionAttempt();
    
    /**
     * Set streaming status callback
     * @param callback The callback to receive streaming status updates
     */
    void setStreamingStatusCallback(StreamingStatusCallback callback);
    
    /**
     * Remove streaming status callback
     */
    void removeStreamingStatusCallback();
    
    /**
     * Get streaming statistics
     * @return Streaming statistics or null if not available
     */
    StreamingStatistics getStatistics();
    
    /**
     * Cleanup resources when service is no longer needed
     */
    void shutdown();
    
    /**
     * Streaming statistics interface
     */
    interface StreamingStatistics {
        /**
         * Get bytes sent
         * @return Number of bytes sent
         */
        long getBytesSent();
        
        /**
         * Get frames sent
         * @return Number of frames sent
         */
        long getFramesSent();
        
        /**
         * Get current bitrate
         * @return Current bitrate in bits per second
         */
        int getCurrentBitrate();
        
        /**
         * Get average bitrate
         * @return Average bitrate in bits per second
         */
        int getAverageBitrate();
        
        /**
         * Get stream duration
         * @return Stream duration in milliseconds
         */
        long getStreamDuration();
    }
} 