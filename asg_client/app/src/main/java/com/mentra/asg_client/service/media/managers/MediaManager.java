package com.mentra.asg_client.service.media.managers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.streaming.events.StreamingCommand;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import org.greenrobot.eventbus.EventBus;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Manages all streaming operations (RTMP, SRT, WHIP, video recording, etc.). Translates streaming
 * lifecycle events into BLE messages sent to the phone.
 *
 * <p>Wire protocol note: all stream status messages use {@code "type": "stream_status"}.
 */
public class MediaManager implements IMediaManager {

    private static final String TAG = "MediaManager";

    private final Context context;
    private final AsgClientServiceManager serviceManager;
    private final StreamingStatusCallback streamingStatusCallback;

    public MediaManager(Context context, AsgClientServiceManager serviceManager) {
        this.context = context;
        this.serviceManager = serviceManager;
        this.streamingStatusCallback = createStreamingStatusCallback();

        // Register the shared callback with all three streaming services
        RtmpStreamingService.setStreamingStatusCallback(streamingStatusCallback);
        SrtStreamingService.setStreamingStatusCallback(streamingStatusCallback);
        WhipStreamingService.setStatusCallback(streamingStatusCallback);
    }

    // -------------------------------------------------------------------------
    // IMediaManager — start / stop (dev/test helpers)
    // -------------------------------------------------------------------------

    @Override
    public void startStreaming() {
        try {
            Log.d(TAG, "Starting RTMP streaming service for testing");
            RtmpStreamingService.startStreaming(context, "rtmp://10.0.0.22/s/streamKey");
            Log.d(TAG, "RTMP streaming initialization complete");
        } catch (Exception e) {
            Log.e(TAG, "Error starting RTMP streaming service", e);
        }
    }

    @Override
    public void stopStreaming() {
        try {
            EventBus.getDefault().post(new StreamingCommand.Stop());
            if (RtmpStreamingService.isStreaming()) RtmpStreamingService.stopStreaming(context);
            if (SrtStreamingService.isStreaming()) SrtStreamingService.stopStreaming(context);
            if (WhipStreamingService.isStreaming()) WhipStreamingService.stopStreaming(context);
        } catch (Exception e) {
            Log.e(TAG, "Error stopping streaming", e);
        }
    }

    // -------------------------------------------------------------------------
    // IMediaManager — status responses over BLE
    // -------------------------------------------------------------------------

    @Override
    public void sendStreamStatusResponse(boolean success, String status, String details) {
        if (!isBleConnected()) {
            Log.w(TAG, "Cannot send stream status response - not connected to BLE device");
            return;
        }
        try {
            JSONObject response = new JSONObject();
            response.put("type", "stream_status");
            response.put("status", status);
            if (details != null) {
                response.put("errorDetails", details);
            }
            attachResolvedStreamConfig(response);
            response.put("timestamp", System.currentTimeMillis());
            String jsonString = response.toString();
            Log.d(TAG, "📤 Sending stream status response: " + jsonString);
            serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
        } catch (JSONException e) {
            Log.e(TAG, "Error creating stream status response", e);
        }
    }

    @Override
    public void sendStreamStatusResponse(boolean success, JSONObject statusObject) {
        if (!isBleConnected()) {
            Log.w(TAG, "Cannot send stream status response - not connected to BLE device");
            return;
        }
        try {
            if (!statusObject.has("type")) {
                statusObject.put("type", "stream_status");
            }
            attachResolvedStreamConfig(statusObject);
            if (!statusObject.has("timestamp")) {
                statusObject.put("timestamp", System.currentTimeMillis());
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error normalizing stream status response", e);
            return;
        }
        String jsonString = statusObject.toString();
        Log.d(TAG, "📤 Sending stream status response: " + jsonString);
        serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
    }

    private void attachResolvedStreamConfig(JSONObject statusObject) throws JSONException {
        if (statusObject.has("resolvedConfig")) {
            return;
        }

        JSONObject resolvedConfig = getCurrentResolvedStreamConfig();
        if (resolvedConfig != null) {
            statusObject.put("resolvedConfig", resolvedConfig);
        }
    }

    private JSONObject getCurrentResolvedStreamConfig() {
        if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
            return RtmpStreamingService.getCurrentResolvedConfig();
        }
        if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
            return SrtStreamingService.getCurrentResolvedConfig();
        }
        if (WhipStreamingService.isStreaming() || WhipStreamingService.isReconnecting()) {
            return WhipStreamingService.getCurrentResolvedConfig();
        }
        return null;
    }

    @Override
    public void sendVideoRecordingStatusResponse(boolean success, String status, String details) {
        sendVideoRecordingStatusResponse(null, success, status, details);
    }

    @Override
    public void sendVideoRecordingStatusResponse(
            String requestId, boolean success, String status, String details) {
        if (!isBleConnected()) {
            Log.w(TAG, "Cannot send video recording status response - not connected to BLE device");
            return;
        }
        try {
            JSONObject response = new JSONObject();
            response.put("type", "video_recording_status");
            if (requestId != null && !requestId.isEmpty()) {
                response.put("requestId", requestId);
            }
            response.put("success", success);
            response.put("status", status);
            response.put("details", details);
            response.put("timestamp", System.currentTimeMillis());
            String jsonString = response.toString();
            Log.d(TAG, "📤 Sending video recording status response: " + jsonString);
            serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
        } catch (JSONException e) {
            Log.e(TAG, "Error creating video recording status response", e);
        }
    }

    @Override
    public void sendVideoRecordingStatusResponse(boolean success, JSONObject statusObject) {
        sendVideoRecordingStatusResponse(null, success, statusObject);
    }

    @Override
    public void sendVideoRecordingStatusResponse(
            String requestId, boolean success, JSONObject statusObject) {
        if (!isBleConnected()) {
            Log.w(TAG, "Cannot send video recording status response - not connected to BLE device");
            return;
        }
        try {
            JSONObject response = new JSONObject();
            response.put("type", "video_recording_status");
            if (requestId != null && !requestId.isEmpty()) {
                response.put("requestId", requestId);
            }
            response.put("success", success);
            String status = statusObject.optString("status", "");
            if (!status.isEmpty()) {
                response.put("status", status);
            }
            response.put("data", statusObject);
            response.put("timestamp", System.currentTimeMillis());
            String jsonString = response.toString();
            Log.d(TAG, "📤 Sending video recording status response: " + jsonString);
            serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
        } catch (JSONException e) {
            Log.e(TAG, "Error creating video recording status response", e);
        }
    }

    @Override
    public StreamingStatusCallback getStreamingStatusCallback() {
        return streamingStatusCallback;
    }

    @Override
    public void cleanup() {
        RtmpStreamingService.setStreamingStatusCallback(null);
        SrtStreamingService.setStreamingStatusCallback(null);
        WhipStreamingService.setStatusCallback(null);
        Log.d(TAG, "MediaManager cleanup completed - callbacks unregistered");
    }

    @Override
    public void sendKeepAliveAck(String streamId, String ackId) {
        if (!isBleConnected()) {
            Log.w(
                    TAG,
                    "Cannot send keep-alive ACK - not connected to BLE device (streamId="
                            + streamId
                            + ", ackId="
                            + ackId
                            + ")");
            // Retry once after a short delay to tolerate transient BLE gaps
            new android.os.Handler(android.os.Looper.getMainLooper())
                    .postDelayed(
                            () -> {
                                if (isBleConnected()) {
                                    sendKeepAliveAckInternal(streamId, ackId, true);
                                } else {
                                    Log.w(
                                            TAG,
                                            "Retry failed - BLE still not connected (streamId="
                                                    + streamId
                                                    + ", ackId="
                                                    + ackId
                                                    + ")");
                                }
                            },
                            1500);
            return;
        }
        sendKeepAliveAckInternal(streamId, ackId, false);
    }

    private void sendKeepAliveAckInternal(String streamId, String ackId, boolean isRetry) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "keep_alive_ack");
            response.put("streamId", streamId);
            response.put("ackId", ackId);
            response.put("timestamp", System.currentTimeMillis());
            String jsonString = response.toString();
            Log.d(
                    TAG,
                    "📤 " + (isRetry ? "Retrying" : "Sending") + " keep-alive ACK: " + jsonString);
            serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
        } catch (JSONException e) {
            Log.e(TAG, "Error creating keep-alive ACK response", e);
        }
    }

    // -------------------------------------------------------------------------
    // Streaming status callback — shared across RTMP, SRT, and WHIP services
    // -------------------------------------------------------------------------

    private StreamingStatusCallback createStreamingStatusCallback() {
        return new StreamingStatusCallback() {
            @Override
            public void onStreamStarting(String streamUrl, String streamId) {
                Log.d(TAG, "Stream starting to: " + streamUrl);
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "initializing");
                    if (streamId != null && !streamId.isEmpty()) status.put("streamId", streamId);
                    sendStreamStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream initializing status", e);
                }
            }

            @Override
            public void onStreamStarted(String streamUrl, String streamId) {
                Log.d(TAG, "Stream successfully started to: " + streamUrl);
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "streaming");
                    if (streamId != null && !streamId.isEmpty()) status.put("streamId", streamId);
                    sendStreamStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream started status", e);
                }
            }

            @Override
            public void onStreamStopped(String streamId) {
                Log.d(TAG, "Stream stopped");
                // Don't send "stopped" if we're mid-reconnect
                if (RtmpStreamingService.isReconnecting()
                        || SrtStreamingService.isReconnecting()
                        || WhipStreamingService.isReconnecting()) {
                    Log.d(TAG, "Stream stopped for reconnection - skipping stopped status");
                    return;
                }
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "stopped");
                    if (streamId != null && !streamId.isEmpty()) status.put("streamId", streamId);
                    sendStreamStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream stopped status", e);
                }
            }

            @Override
            public void onReconnecting(
                    int attempt, int maxAttempts, String reason, String streamId) {
                Log.d(
                        TAG,
                        "Stream reconnecting: attempt "
                                + attempt
                                + "/"
                                + maxAttempts
                                + " - "
                                + reason);
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "reconnecting");
                    status.put("attempt", attempt);
                    status.put("maxAttempts", maxAttempts);
                    status.put("reason", reason);
                    if (streamId != null && !streamId.isEmpty()) status.put("streamId", streamId);
                    sendStreamStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream reconnecting status", e);
                }
            }

            @Override
            public void onReconnected(String streamUrl, int attempt, String streamId) {
                Log.d(TAG, "Stream reconnected to: " + streamUrl + " on attempt " + attempt);
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "reconnected");
                    status.put("attempt", attempt);
                    if (streamId != null && !streamId.isEmpty()) status.put("streamId", streamId);
                    sendStreamStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream reconnected status", e);
                }
            }

            @Override
            public void onReconnectFailed(int maxAttempts, String streamId) {
                Log.d(TAG, "Stream reconnect failed after " + maxAttempts + " attempts");
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "reconnect_failed");
                    status.put("maxAttempts", maxAttempts);
                    if (streamId != null && !streamId.isEmpty()) status.put("streamId", streamId);
                    sendStreamStatusResponse(false, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream reconnect failed status", e);
                }
            }

            @Override
            public void onStreamError(String error, String streamId, boolean willRetry) {
                Log.e(TAG, "Stream error: " + error + (willRetry ? " (will retry)" : ""));
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "error");
                    status.put("errorDetails", error);
                    if (streamId != null && !streamId.isEmpty()) status.put("streamId", streamId);
                    // Additive field: the phone treats an id-carrying error as terminal
                    // unless the glasses flag that a reconnect is already scheduled.
                    if (willRetry) status.put("willRetry", true);
                    sendStreamStatusResponse(false, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream error status", e);
                }
            }

            @Override
            public void onStreamMetrics(
                    String streamId,
                    long bitrateBps,
                    double fps,
                    long droppedFrames,
                    long durationSeconds,
                    double temperatureC) {
                if (!AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY) {
                    return;
                }
                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "stream_status");
                    status.put("status", "streaming");
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }

                    JSONObject stats = new JSONObject();
                    stats.put("bitrate", bitrateBps);
                    stats.put("fps", fps);
                    stats.put("droppedFrames", droppedFrames);
                    stats.put("duration", durationSeconds);
                    if (Double.isFinite(temperatureC)) {
                        stats.put("temperatureC", Math.round(temperatureC * 10d) / 10d);
                    }
                    status.put("stats", stats);
                    sendStreamStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating stream metrics status", e);
                }
            }
        };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private boolean isBleConnected() {
        return serviceManager != null
                && serviceManager.getBluetoothManager() != null
                && serviceManager.getBluetoothManager().isConnected();
    }
}
