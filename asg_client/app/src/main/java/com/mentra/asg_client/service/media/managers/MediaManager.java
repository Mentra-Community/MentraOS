package com.mentra.asg_client.service.media.managers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.streaming.events.StreamingCommand;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;

import org.greenrobot.eventbus.EventBus;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Manages all streaming operations (RTMP, video recording, etc.).
 * Follows Single Responsibility Principle by handling only streaming concerns.
 */
public class MediaManager implements IMediaManager {

    private static final String TAG = "StreamingManager";

    private final Context context;
    private final AsgClientServiceManager serviceManager;
    private final StreamingStatusCallback streamingStatusCallback;

    public MediaManager(Context context, AsgClientServiceManager serviceManager) {
        this.context = context;
        this.serviceManager = serviceManager;
        this.streamingStatusCallback = createStreamingStatusCallback();

        // Register the callback with the RTMP streaming service
        RtmpStreamingService.setStreamingStatusCallback(streamingStatusCallback);
    }

    @Override
    public void startRtmpStreaming() {
        try {
            Log.d(TAG, "Starting RTMP streaming service for testing");

            // Use the static convenience method to start streaming (callback already registered)
            RtmpStreamingService.startStreaming(
                    context,
                    "rtmp://10.0.0.22/s/streamKey"
            );

            Log.d(TAG, "RTMP streaming initialization complete");
        } catch (Exception e) {
            Log.e(TAG, "Error starting RTMP streaming service", e);
        }
    }

    @Override
    public void stopRtmpStreaming() {
        try {
            EventBus.getDefault().post(new StreamingCommand.Stop());
            RtmpStreamingService.stopStreaming(context);
        } catch (Exception e) {
            Log.e(TAG, "Error stopping RTMP streaming", e);
        }
    }

        @Override
    public void sendRtmpStatusResponse(boolean success, String status, String details) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
            serviceManager.getBluetoothManager().isConnected()) {
            try {
                // Create properly formatted message for cloud
                JSONObject response = new JSONObject();
                response.put("type", "rtmp_stream_status");
                response.put("status", status);
                if (details != null) {
                    response.put("errorDetails", details);
                }
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "📤 Sending RTMP status response: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());

            } catch (JSONException e) {
                Log.e(TAG, "Error creating RTMP status response", e);
            }
        } else {
            Log.w(TAG, "Cannot send RTMP status response - not connected to BLE device");
        }
    }

        @Override
    public void sendRtmpStatusResponse(boolean success, JSONObject statusObject) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
            serviceManager.getBluetoothManager().isConnected()) {
            // The statusObject already contains the type and all necessary fields
            // ❌ REMOVED: timestamp not used by cloud (cloud generates its own)
            // if (!statusObject.has("timestamp")) {
            //     statusObject.put("timestamp", System.currentTimeMillis());
            // }

            String jsonString = statusObject.toString();
            Log.d(TAG, "📤 Sending RTMP status response: " + jsonString);
            serviceManager.getBluetoothManager().sendData(jsonString.getBytes());

        } else {
            Log.w(TAG, "Cannot send RTMP status response - not connected to BLE device");
        }
    }

    @Override
    public void sendVideoRecordingStatusResponse(boolean success, String status, String details) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
            serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject response = new JSONObject();
                response.put("type", "video_recording_status");
                response.put("success", success);
                response.put("status", status);
                response.put("details", details);
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "📤 Sending video recording status response: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());

            } catch (JSONException e) {
                Log.e(TAG, "Error creating video recording status response", e);
            }
        } else {
            Log.w(TAG, "Cannot send video recording status response - not connected to BLE device");
        }
    }

    @Override
    public void sendVideoRecordingStatusResponse(boolean success, JSONObject statusObject) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
            serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject response = new JSONObject();
                response.put("type", "video_recording_status");
                response.put("success", success);
                response.put("data", statusObject);
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "📤 Sending video recording status response: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());

            } catch (JSONException e) {
                Log.e(TAG, "Error creating video recording status response", e);
            }
        } else {
            Log.w(TAG, "Cannot send video recording status response - not connected to BLE device");
        }
    }

    @Override
    public void sendBufferStatusResponse(boolean success, String status, String details) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
            serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject response = new JSONObject();
                response.put("type", "buffer_status");
                response.put("success", success);
                response.put("status", status);
                if (details != null) {
                    response.put("details", details);
                }
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "📤 Sending buffer status response: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());

            } catch (JSONException e) {
                Log.e(TAG, "Error creating buffer status response", e);
            }
        } else {
            Log.w(TAG, "Cannot send buffer status response - not connected to BLE device");
        }
    }

    @Override
    public void sendBufferStatusResponse(boolean success, JSONObject statusObject) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
            serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject response = new JSONObject();
                response.put("type", "buffer_status");
                response.put("success", success);

                // Merge the status object fields into the response
                if (statusObject != null) {
                    java.util.Iterator<String> keys = statusObject.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        response.put(key, statusObject.get(key));
                    }
                }
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "📤 Sending buffer status response: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());

            } catch (JSONException e) {
                Log.e(TAG, "Error creating buffer status response", e);
            }
        } else {
            Log.w(TAG, "Cannot send buffer status response - not connected to BLE device");
        }
    }

    @Override
    public StreamingStatusCallback getStreamingStatusCallback() {
        return streamingStatusCallback;
    }

    /**
     * Clean up resources when the MediaManager is being destroyed
     */
    public void cleanup() {
        // Unregister the callback from the RTMP streaming service
        RtmpStreamingService.setStreamingStatusCallback(null);
        Log.d(TAG, "MediaManager cleanup completed - callback unregistered");
    }

    @Override
    public void sendKeepAliveAck(String streamId, String ackId) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
            serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject response = new JSONObject();
                response.put("type", "keep_alive_ack");
                response.put("streamId", streamId);
                response.put("ackId", ackId);
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "📤 Sending keep-alive ACK: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());

            } catch (JSONException e) {
                Log.e(TAG, "Error creating keep-alive ACK response", e);
            }
        } else {
            Log.w(TAG, "Cannot send keep-alive ACK - not connected to BLE device (streamId=" + streamId + ", ackId=" + ackId + ")");
            // Retry once after a short delay to tolerate transient BLE gaps
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (serviceManager != null && serviceManager.getBluetoothManager() != null && serviceManager.getBluetoothManager().isConnected()) {
                    try {
                        JSONObject response = new JSONObject();
                        response.put("type", "keep_alive_ack");
                        response.put("streamId", streamId);
                        response.put("ackId", ackId);
                        response.put("timestamp", System.currentTimeMillis());
                        String jsonString = response.toString();
                        Log.d(TAG, "📤 Retrying keep-alive ACK send after BLE reconnect: " + jsonString);
                        serviceManager.getBluetoothManager().sendData(jsonString.getBytes());
                    } catch (JSONException e) {
                        Log.e(TAG, "Error creating keep-alive ACK response on retry", e);
                    }
                } else {
                    Log.w(TAG, "Retry failed - BLE still not connected (streamId=" + streamId + ", ackId=" + ackId + ")");
                }
            }, 1500);
        }
    }

    /**
     * Create streaming status callback
     */
    private StreamingStatusCallback createStreamingStatusCallback() {
        return new StreamingStatusCallback() {
            @Override
            public void onStreamStarting(String rtmpUrl) {
                Log.d(TAG, "RTMP Stream starting to: " + rtmpUrl);

                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "rtmp_stream_status");
                    status.put("status", "initializing");
                    String streamId = RtmpStreamingService.getCurrentStreamId();
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }
                    sendRtmpStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating RTMP initializing status", e);
                }
            }

            @Override
            public void onStreamStarted(String rtmpUrl) {
                Log.d(TAG, "RTMP Stream successfully started to: " + rtmpUrl);

                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "rtmp_stream_status");
                    status.put("status", "streaming");
                    // ❌ REMOVED: rtmpUrl not used by cloud (cloud already has it from initial request)
                    // status.put("rtmpUrl", rtmpUrl);
                    String streamId = RtmpStreamingService.getCurrentStreamId();
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }

                    // ❌ REMOVED: stats not used by cloud (neither managed nor unmanaged read these)
                    // JSONObject stats = new JSONObject();
                    // stats.put("bitrate", 1500000);
                    // stats.put("fps", 30);
                    // stats.put("droppedFrames", 0);
                    // status.put("stats", stats);

                    sendRtmpStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating RTMP started status", e);
                }
            }

            @Override
            public void onStreamStopped() {
                Log.d(TAG, "RTMP Stream stopped");

                // Check if we're reconnecting - if so, don't send "stopped" status
                if (RtmpStreamingService.isReconnecting()) {
                    Log.d(TAG, "Stream stopped for reconnection - not sending stopped status to TPA");
                    return; // Skip status update during reconnection
                }

                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "rtmp_stream_status");
                    status.put("status", "stopped");
                    // CRITICAL FIX: Always include streamId for terminal status
                    String streamId = RtmpStreamingService.getCurrentStreamId();
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }
                    // ❌ REMOVED: timestamp not used by cloud (cloud generates its own)
                    // status.put("timestamp", System.currentTimeMillis());

                    sendRtmpStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating RTMP stopped status", e);
                }
            }

            @Override
            public void onReconnecting(int attempt, int maxAttempts, String reason) {
                Log.d(TAG, "RTMP Stream reconnecting: attempt " + attempt + "/" + maxAttempts + " - " + reason);

                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "rtmp_stream_status");
                    status.put("status", "reconnecting");
                    status.put("attempt", attempt);
                    status.put("maxAttempts", maxAttempts);
                    status.put("reason", reason);
                    // Include streamId for all status updates
                    String streamId = RtmpStreamingService.getCurrentStreamId();
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }
                    // ❌ REMOVED: timestamp not used by cloud (cloud generates its own)
                    // status.put("timestamp", System.currentTimeMillis());

                    sendRtmpStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating RTMP reconnecting status", e);
                }
            }

            @Override
            public void onReconnected(String rtmpUrl, int attempt) {
                Log.d(TAG, "RTMP Stream reconnected to: " + rtmpUrl + " on attempt " + attempt);

                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "rtmp_stream_status");
                    status.put("status", "reconnected");
                    // ❌ REMOVED: rtmpUrl not used by cloud (cloud already has it)
                    // status.put("rtmpUrl", rtmpUrl);
                    status.put("attempt", attempt);
                    // Include streamId for all status updates
                    String streamId = RtmpStreamingService.getCurrentStreamId();
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }
                    // ❌ REMOVED: timestamp not used by cloud (cloud generates its own)
                    // status.put("timestamp", System.currentTimeMillis());

                    sendRtmpStatusResponse(true, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating RTMP reconnected status", e);
                }
            }

            @Override
            public void onReconnectFailed(int maxAttempts) {
                Log.d(TAG, "RTMP Stream reconnect failed after " + maxAttempts + " attempts");

                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "rtmp_stream_status");
                    status.put("status", "reconnect_failed");
                    status.put("maxAttempts", maxAttempts);
                    // CRITICAL FIX: Always include streamId for terminal status
                    String streamId = RtmpStreamingService.getCurrentStreamId();
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }
                    // ❌ REMOVED: timestamp not used by cloud (cloud generates its own)
                    // status.put("timestamp", System.currentTimeMillis());

                    sendRtmpStatusResponse(false, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating RTMP reconnect failed status", e);
                }
            }

            @Override
            public void onStreamError(String error) {
                Log.e(TAG, "RTMP Stream error: " + error);

                try {
                    JSONObject status = new JSONObject();
                    status.put("type", "rtmp_stream_status");
                    status.put("status", "error");
                    // FIX: Use correct key name that cloud expects
                    status.put("errorDetails", error);
                    // CRITICAL FIX: Always include streamId for terminal status
                    String streamId = RtmpStreamingService.getCurrentStreamId();
                    if (streamId != null && !streamId.isEmpty()) {
                        status.put("streamId", streamId);
                    }
                    // ❌ REMOVED: timestamp not used by cloud (cloud generates its own)
                    // status.put("timestamp", System.currentTimeMillis());

                    sendRtmpStatusResponse(false, status);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating RTMP error status", e);
                }
            }
        };
    }
}