package com.mentra.asg_client.io.streaming.interfaces;

/**
 * Callback interface for receiving streaming status updates.
 * Extracted from RtmpStreamingService for better separation of concerns.
 */
public interface StreamingStatusCallback {
    
    /**
     * Called when streaming is starting (connecting)
     *
     * @param streamingUrl The URL being connected to
     */
    void onStreamStarting(String streamingUrl);

    /**
     * Called when streaming has started successfully
     *
     * @param streamingUrl The URL connected to
     */
    void onStreamStarted(String streamingUrl);

    /**
     * Called when streaming has stopped
     */
    void onStreamStopped();

    /**
     * Called when a connection is lost and reconnection is being attempted
     *
     * @param attempt     Current reconnection attempt number
     * @param maxAttempts Maximum number of attempts that will be made
     * @param reason      Reason for reconnection
     */
    void onReconnecting(int attempt, int maxAttempts, String reason);

    /**
     * Called when reconnection was successful
     *
     * @param streamingUrl The URL reconnected to
     * @param attempt      The attempt number that succeeded
     */
    void onReconnected(String streamingUrl, int attempt);

    /**
     * Called when all reconnection attempts have failed
     *
     * @param maxAttempts The maximum number of attempts that were made
     */
    void onReconnectFailed(int maxAttempts);

    /**
     * Called when a streaming error occurs
     *
     * @param error Error message
     */
    void onStreamError(String error);
} 