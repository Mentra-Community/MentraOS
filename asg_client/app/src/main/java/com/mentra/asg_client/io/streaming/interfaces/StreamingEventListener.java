package com.mentra.asg_client.io.streaming.interfaces;

/**
 * Interface for listening to streaming events.
 * Provides a unified way to handle streaming events across different implementations.
 */
public interface StreamingEventListener {
    
    /**
     * Called when the streamer is ready to be used
     */
    void onStreamerReady();
    
    /**
     * Called when the preview is successfully attached
     */
    void onPreviewAttached();
    
    /**
     * Called when stream is initializing (before connection)
     */
    void onStreamInitializing();
    
    /**
     * Called when streaming starts
     */
    void onStreamStarted();
    
    /**
     * Called when streaming stops
     */
    void onStreamStopped();
    
    /**
     * Called when connection is established
     */
    void onConnected();
    
    /**
     * Called when connection fails
     * @param message Error message
     */
    void onConnectionFailed(String message);
    
    /**
     * Called when connection is disconnected
     */
    void onDisconnected();
    
    /**
     * Called when an error occurs
     * @param message Error message
     */
    void onError(String message);
} 