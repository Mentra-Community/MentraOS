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
     * Called when a terminal streaming error occurs (no retry scheduled)
     *
     * @param error    Error message
     * @param streamId The stream ID, or null
     */
    default void onStreamError(String error, String streamId) {
        onStreamError(error, streamId, false);
    }

    /**
     * Called when a streaming error occurs
     *
     * @param error     Error message
     * @param streamId  The stream ID, or null
     * @param willRetry True when the service has already scheduled a reconnect for
     *                  this error, so the phone should not treat it as terminal
     */
    void onStreamError(String error, String streamId, boolean willRetry);

    /**
     * Called with current encoder and device telemetry while a stream is active.
     *
     * @param streamId The active stream ID, or null
     * @param bitrateBps Current video bitrate in bits per second
     * @param fps Current video frame rate
     * @param droppedFrames Current dropped-frame count
     * @param durationSeconds Seconds since the stream started
     * @param temperatureC CPU temperature in Celsius, or {@link Double#NaN} if unavailable
     */
    default void onStreamMetrics(
            String streamId,
            long bitrateBps,
            double fps,
            long droppedFrames,
            long durationSeconds,
            double temperatureC) {}
}
