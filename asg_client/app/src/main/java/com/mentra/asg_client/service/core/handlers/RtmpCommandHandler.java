package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.streaming.config.RtmpStreamConfig;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.utils.ServiceConstants;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for RTMP streaming commands.
 * Follows Single Responsibility Principle by handling only RTMP streaming commands.
 */
public class RtmpCommandHandler implements ICommandHandler {
    private static final String TAG = "RtmpCommandHandler";

    private final Context context;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;

    public RtmpCommandHandler(Context context, IStateManager stateManager, IMediaManager streamingManager) {
        this.context = context;
        this.stateManager = stateManager;
        this.streamingManager = streamingManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("start_rtmp_stream", "stop_rtmp_stream", "get_rtmp_status", "keep_rtmp_stream_alive");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "start_rtmp_stream":
                    return handleStartRtmpStream(data);
                case "stop_rtmp_stream":
                    return handleStopCommand();
                case "get_rtmp_status":
                    return handleStatusCommand();
                case "keep_rtmp_stream_alive":
                    return handleKeepAliveCommand(data);
                default:
                    Log.e(TAG, "Unsupported RTMP command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling RTMP command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle start RTMP stream command
     */
    private boolean handleStartRtmpStream(JSONObject data) {
        try {
            String rtmpUrl = data.optString("rtmpUrl", "");
            if (rtmpUrl.isEmpty()) {
                Log.e(TAG, "Cannot start RTMP stream - missing rtmpUrl");
                streamingManager.sendRtmpStatusResponse(false, ServiceConstants.STATUS_ERROR, ServiceConstants.ERROR_MISSING_RTMP_URL);
                return false;
            }

            // BATTERY CHECK: Reject if battery too low
            if (stateManager != null) {
                int batteryLevel = stateManager.getBatteryLevel();
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(TAG, "🚫 RTMP stream rejected - battery too low (" + batteryLevel + "%)");

                    // Play audio feedback
                    com.mentra.asg_client.io.media.core.MediaCaptureService.playBatteryLowSound(context);

                    // Send error response to phone
                    streamingManager.sendRtmpStatusResponse(false, ServiceConstants.STATUS_ERROR,
                        "Battery level too low (" + batteryLevel + "%) - minimum " +
                        BatteryConstants.MIN_BATTERY_LEVEL + "% required");

                    return false;
                }
            } else {
                Log.w(TAG, "⚠️ StateManager not available - skipping battery check");
            }

            if (stateManager != null && !stateManager.isConnectedToWifi()) {
                Log.e(TAG, "Cannot start RTMP stream - no WiFi connection");
                streamingManager.sendRtmpStatusResponse(false, ServiceConstants.STATUS_ERROR, ServiceConstants.ERROR_NO_WIFI_CONNECTION);
                return false;
            }

            // Stop existing stream if running
            if (RtmpStreamingService.isStreaming()) {
                RtmpStreamingService.stopStreaming(context);
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }

            String streamId = data.optString("streamId", "");
            // silent: true = no sound/LED, false (default) = normal behavior with sound/LED
            boolean silent = data.optBoolean("silent", false);
            boolean enableLed = !silent; // Convert to internal enableLed (inverted logic)

            // Parse video/audio config from SDK message (supports both full and compact keys)
            // Full: { video: {...}, audio: {...} }
            // Compact: { v: {...}, a: {...} }
            JSONObject videoJson = data.optJSONObject("video");
            if (videoJson == null) {
                videoJson = data.optJSONObject("v");
            }
            JSONObject audioJson = data.optJSONObject("audio");
            if (audioJson == null) {
                audioJson = data.optJSONObject("a");
            }
            RtmpStreamConfig streamConfig = RtmpStreamConfig.fromJson(videoJson, audioJson);

            Log.d(TAG, "Starting RTMP stream with config: " + streamConfig.toString());
            RtmpStreamingService.startStreaming(context, rtmpUrl, streamId, enableLed, streamConfig);

            // Set StateManager for battery monitoring
            RtmpStreamingService.setStateManager(stateManager);

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling RTMP start command", e);
            streamingManager.sendRtmpStatusResponse(false, ServiceConstants.STATUS_ERROR, e.getMessage());
            return false;
        }
    }

    /**
     * Handle stop RTMP stream command
     */
    public boolean handleStopCommand() {
        try {
            if (RtmpStreamingService.isStreaming()) {
                RtmpStreamingService.stopStreaming(context);
                streamingManager.sendRtmpStatusResponse(true, ServiceConstants.STATUS_STOPPING, null);
                return true;
            } else {
                streamingManager.sendRtmpStatusResponse(false, ServiceConstants.STATUS_ERROR, ServiceConstants.ERROR_NOT_STREAMING);
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling RTMP stop command", e);
            streamingManager.sendRtmpStatusResponse(false, ServiceConstants.STATUS_ERROR, e.getMessage());
            return false;
        }
    }

    /**
     * Handle get RTMP status command
     */
    public boolean handleStatusCommand() {
        try {
            boolean isStreaming = RtmpStreamingService.isStreaming();
            boolean isReconnecting = RtmpStreamingService.isReconnecting();

            JSONObject status = new JSONObject();
            status.put("streaming", isStreaming);

            if (isReconnecting) {
                status.put("reconnecting", true);
                status.put("attempt", RtmpStreamingService.getReconnectAttempt());
            }

            streamingManager.sendRtmpStatusResponse(true, status);
            return true;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating RTMP status response", e);
            streamingManager.sendRtmpStatusResponse(false, ServiceConstants.STATUS_ERROR, ServiceConstants.ERROR_JSON_ERROR);
            return false;
        }
    }

    /**
     * Handle keep RTMP stream alive command
     */
    public boolean handleKeepAliveCommand(JSONObject data) {
        try {
            String streamId = data.optString("streamId", "");
            String ackId = data.optString("ackId", "");

            // Validate we have required fields
            if (streamId.isEmpty() || ackId.isEmpty()) {
                Log.d(TAG, "Keep-alive missing required fields (streamId or ackId) - ignoring");
                return false;
            }

            // Now we know we have both streamId and ackId
            boolean streamIdValid = RtmpStreamingService.resetStreamTimeout(streamId);
            if (streamIdValid) {
                // Stream is active and recognized
                streamingManager.sendKeepAliveAck(streamId, ackId);
                return true;
            } else {
                // Stream not recognized or not fully active yet
                // This can happen if keep-alive arrives during initialization
                // With the cloud fix, this should be rare
                if (RtmpStreamingService.isStreaming()) {
                    // We're in the process of streaming but not fully active yet
                    Log.d(TAG, "Stream still initializing, ACKing keep-alive anyway (streamId: " + streamId + ")");
                    streamingManager.sendKeepAliveAck(streamId, ackId);
                    return true;
                } else {
                    // Not streaming at all - this is an orphaned keep-alive
                    Log.w(TAG, "Keep-alive for unknown stream, not currently streaming: " + streamId);
                    // Don't forcefully stop - let cloud timeout naturally
                    return false;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling RTMP keep-alive command", e);
            return false;
        }
    }
} 