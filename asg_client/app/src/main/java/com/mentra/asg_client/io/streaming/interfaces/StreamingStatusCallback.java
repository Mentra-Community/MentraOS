package com.mentra.asg_client.io.streaming.interfaces;

/**
 * Callback interface for receiving streaming status updates.
 * Each method receives the streamId from the service that fired the event,
 * so the caller doesn't need to look up the active stream globally.
 */
public interface StreamingStatusCallback {

    /**
     * Called when streaming is starting (connecting)
     *
     * @param streamingUrl The URL being connected to
     * @param streamId     The stream ID assigned by the cloud, or null if not yet assigned
     */
    void onStreamStarting(String streamingUrl, String streamId);

    /**
     * Called when streaming has started successfully
     *
     * @param streamingUrl The URL connected to
     * @param streamId     The stream ID assigned by the cloud, or null if not yet assigned
     */
    void onStreamStarted(String streamingUrl, String streamId);

    /**
     * Called when streaming has stopped
     *
     * @param streamId The stream ID of the stopped stream, or null
     */
    void onStreamStopped(String streamId);

    /**
     * Called when a connection is lost and reconnection is being attempted
     *
     * @param attempt     Current reconnection attempt number
     * @param maxAttempts Maximum number of attempts that will be made
     * @param reason      Reason for reconnection
     * @param streamId    The stream ID, or null
     */
    void onReconnecting(int attempt, int maxAttempts, String reason, String streamId);

    /**
     * Called when reconnection was successful
     *
     * @param streamingUrl The URL reconnected to
     * @param attempt      The attempt number that succeeded
     * @param streamId     The stream ID, or null
     */
    void onReconnected(String streamingUrl, int attempt, String streamId);

    /**
     * Called when all reconnection attempts have failed
     *
     * @param maxAttempts The maximum number of attempts that were made
     * @param streamId    The stream ID, or null
     */
    void onReconnectFailed(int maxAttempts, String streamId);

    /**
     * Called when a streaming error occurs
     *
     * @param error    Error message
     * @param streamId The stream ID, or null
     */
    void onStreamError(String error, String streamId);
}
