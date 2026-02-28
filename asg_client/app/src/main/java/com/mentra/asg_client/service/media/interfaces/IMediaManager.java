package com.mentra.asg_client.service.media.interfaces;

import org.json.JSONObject;

/**
 * Interface for streaming management (RTMP, video recording, etc.).
 * Follows Interface Segregation Principle by providing focused streaming methods.
 */
public interface IMediaManager {

    /**
     * Start RTMP streaming
     */
    void startRtmpStreaming();

    /**
     * Stop RTMP streaming
     */
    void stopRtmpStreaming();

    /**
     * Send RTMP status response
     * @param success Success status
     * @param status Status message
     * @param details Additional details
     */
    void sendRtmpStatusResponse(boolean success, String status, String details);

    /**
     * Send RTMP status response with JSON object
     * @param success Success status
     * @param statusObject Status JSON object
     */
    void sendRtmpStatusResponse(boolean success, JSONObject statusObject);

    /**
     * Send video recording status response
     * @param success Success status
     * @param status Status message
     * @param details Additional details
     */
    void sendVideoRecordingStatusResponse(boolean success, String status, String details);

    /**
     * Send video recording status response with JSON object
     * @param success Success status
     * @param statusObject Status JSON object
     */
    void sendVideoRecordingStatusResponse(boolean success, JSONObject statusObject);

    /**
     * Send buffer status response
     * @param success Success status
     * @param status Status message
     * @param details Additional details
     */
    void sendBufferStatusResponse(boolean success, String status, String details);

    /**
     * Send buffer status response with JSON object
     * @param success Success status
     * @param statusObject Status JSON object
     */
    void sendBufferStatusResponse(boolean success, JSONObject statusObject);

    /**
     * Get streaming status callback
     * @return Streaming status callback
     */
    com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback getStreamingStatusCallback();

    /**
     * Send keep-alive acknowledgment
     * @param streamId Stream ID
     * @param ackId Acknowledgment ID
     */
    void sendKeepAliveAck(String streamId, String ackId);

    /**
     * Clean up resources when the MediaManager is being destroyed
     */
    void cleanup();
}