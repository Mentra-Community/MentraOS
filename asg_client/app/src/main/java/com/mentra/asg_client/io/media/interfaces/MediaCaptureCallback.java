package com.mentra.asg_client.io.media.interfaces;

import java.io.File;

/**
 * Callback interface for media capture operations
 */
public interface MediaCaptureCallback {
    /**
     * Called when media capture starts
     * @param mediaType The type of media being captured (photo, video, audio)
     */
    void onCaptureStarted(String mediaType);
    
    /**
     * Called when media capture completes successfully
     * @param mediaType The type of media captured
     * @param file The captured media file
     */
    void onCaptureSuccess(String mediaType, File file);
    
    /**
     * Called when media capture fails
     * @param mediaType The type of media that failed to capture
     * @param error The error message
     */
    void onCaptureError(String mediaType, String error);
    
    /**
     * Called when media capture is cancelled
     * @param mediaType The type of media capture that was cancelled
     */
    void onCaptureCancelled(String mediaType);
    
    /**
     * Called during media capture progress
     * @param mediaType The type of media being captured
     * @param progress Progress percentage (0-100)
     */
    void onCaptureProgress(String mediaType, int progress);
} 