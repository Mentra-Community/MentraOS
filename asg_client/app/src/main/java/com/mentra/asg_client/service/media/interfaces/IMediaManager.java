package com.mentra.asg_client.service.media.interfaces;

import org.json.JSONObject;

/**
 * Interface for media/streaming management.
 * Handles RTMP, SRT, and WHIP streaming status reporting over BLE.
 */
public interface IMediaManager {

    /**
     * Start streaming (test/dev helper — production starts via StreamCommandHandler)
     */
    void startStreaming();

    /**
     * Stop any active stream
     */
    void stopStreaming();

    /**
     * Send stream status response over BLE.
     * Wire type is "stream_status".
     * @param success Success flag
     * @param status  Status string (e.g. "streaming", "stopped", "error")
     * @param details Optional error detail string
     */
    void sendStreamStatusResponse(boolean success, String status, String details);

    /**
     * Send stream status response with a pre-built JSON object over BLE.
     * @param success      Success flag
     * @param statusObject Full status JSON object (must include "type" field)
     */
    void sendStreamStatusResponse(boolean success, JSONObject statusObject);

    /**
     * Send video recording status response
     */
    void sendVideoRecordingStatusResponse(boolean success, String status, String details);

    /**
     * Send video recording status response with JSON object
     */
    void sendVideoRecordingStatusResponse(boolean success, JSONObject statusObject);

    /**
     * Get the shared streaming status callback instance
     */
    com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback getStreamingStatusCallback();

    /**
     * Send keep-alive acknowledgment
     */
    void sendKeepAliveAck(String streamId, String ackId);

    /**
     * Clean up resources
     */
    void cleanup();
}
