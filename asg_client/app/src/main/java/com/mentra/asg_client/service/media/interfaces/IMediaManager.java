package com.mentra.asg_client.service.media.interfaces;

import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import org.json.JSONObject;

/**
 * Interface for media/streaming management. Handles RTMP, SRT, and WHIP streaming status reporting
 * over BLE.
 */
public interface IMediaManager {

    /** Begin authoritative state tracking before dispatching a stream start. */
    void beginStreamSession(String streamId);

    /** Return retained stream state, including terminal events missed while disconnected. */
    JSONObject getStreamSnapshot();

    /** Observe accepted publisher state; the consumer must dispatch onto its lifecycle owner. */
    void setStreamStatusListener(java.util.function.Consumer<JSONObject> listener);

    /** Start streaming (test/dev helper — production starts via StreamCommandHandler) */
    void startStreaming();

    /** Stop any active stream */
    void stopStreaming();

    /**
     * Send stream status response over BLE. Wire type is "stream_status".
     *
     * @param success Success flag
     * @param status Status string (e.g. "streaming", "stopped", "error")
     * @param details Optional error detail string
     */
    void sendStreamStatusResponse(boolean success, String status, String details);

    /**
     * Send stream status response with a pre-built JSON object over BLE.
     *
     * @param success Success flag
     * @param statusObject Full status JSON object (must include "type" field)
     */
    void sendStreamStatusResponse(boolean success, JSONObject statusObject);

    /** Send video recording status response */
    void sendVideoRecordingStatusResponse(boolean success, String status, String details);

    /** Send video recording status response correlated to a command request. */
    default void sendVideoRecordingStatusResponse(
            String requestId, boolean success, String status, String details) {
        sendVideoRecordingStatusResponse(success, status, details);
    }

    /** Send video recording status response with JSON object */
    void sendVideoRecordingStatusResponse(boolean success, JSONObject statusObject);

    /** Send video recording status response with JSON object correlated to a command request. */
    default void sendVideoRecordingStatusResponse(
            String requestId, boolean success, JSONObject statusObject) {
        sendVideoRecordingStatusResponse(success, statusObject);
    }

    /** Get the shared streaming status callback instance */
    StreamingStatusCallback getStreamingStatusCallback();

    /** Send keep-alive acknowledgment */
    void sendKeepAliveAck(String streamId, String ackId);

    /** Clean up resources */
    void cleanup();
}
