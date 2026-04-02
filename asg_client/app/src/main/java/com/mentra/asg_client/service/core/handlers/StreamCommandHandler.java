package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.streaming.config.RtmpStreamConfig;
import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.SysControl;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.utils.ServiceConstants;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for streaming commands (RTMP, SRT, WHIP).
 * Routes to the appropriate streaming service based on the stream URL protocol.
 */
public class StreamCommandHandler implements ICommandHandler {
    private static final String TAG = "StreamCommandHandler";

    private final Context context;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;

    public StreamCommandHandler(Context context, IStateManager stateManager, IMediaManager streamingManager) {
        this.context = context;
        this.stateManager = stateManager;
        this.streamingManager = streamingManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("start_stream", "stop_stream", "get_stream_status", "keep_stream_alive");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "start_stream":
                    return handleStartCommand(data);
                case "stop_stream":
                    return handleStopCommand();
                case "get_stream_status":
                    return handleStatusCommand();
                case "keep_stream_alive":
                    return handleKeepAliveCommand(data);
                default:
                    Log.e(TAG, "Unsupported stream command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling stream command: " + commandType, e);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Protocol detection
    // -------------------------------------------------------------------------

    private enum Protocol { RTMP, SRT, WHIP, UNKNOWN }

    private static Protocol detectProtocol(String url) {
        if (url == null) return Protocol.UNKNOWN;
        if (url.startsWith("srt://")) return Protocol.SRT;
        if (url.startsWith("rtmp://") || url.startsWith("rtmps://")) return Protocol.RTMP;
        if (url.startsWith("https://") || url.startsWith("http://")) return Protocol.WHIP;
        return Protocol.UNKNOWN;
    }

    // -------------------------------------------------------------------------
    // Command handlers
    // -------------------------------------------------------------------------

    /**
     * Handle start stream command — routes to RTMP, SRT, or WHIP service based on URL.
     */
    private boolean handleStartCommand(JSONObject data) {
        try {
            // Accept streamUrl first, then legacy rtmpUrl / srtUrl keys
            String streamUrl = data.optString("streamUrl", "");
            if (streamUrl.isEmpty()) streamUrl = data.optString("rtmpUrl", "");
            if (streamUrl.isEmpty()) streamUrl = data.optString("srtUrl", "");
            if (streamUrl.isEmpty()) streamUrl = data.optString("whipUrl", "");

            if (streamUrl.isEmpty()) {
                Log.e(TAG, "Cannot start stream - missing stream URL");
                streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                        ServiceConstants.ERROR_MISSING_STREAM_URL);
                return false;
            }

            Protocol protocol = detectProtocol(streamUrl);
            if (protocol == Protocol.UNKNOWN) {
                Log.e(TAG, "Unknown stream URL protocol: " + streamUrl);
                streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                        "Unknown stream URL protocol");
                return false;
            }

            // BATTERY CHECK
            if (stateManager != null) {
                int batteryLevel = stateManager.getBatteryLevel();
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(TAG, "🚫 Stream rejected - battery too low (" + batteryLevel + "%)");
                    com.mentra.asg_client.io.media.core.MediaCaptureService.playBatteryLowSound(context);
                    streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                            "Battery level too low (" + batteryLevel + "%) - minimum " +
                            BatteryConstants.MIN_BATTERY_LEVEL + "% required");
                    return false;
                }
            } else {
                Log.w(TAG, "⚠️ StateManager not available - skipping battery check");
            }

            // WiFi check (WHIP streams may work on mobile data; skip only for WHIP if needed)
            if (stateManager != null && !stateManager.isConnectedToWifi()) {
                Log.e(TAG, "Cannot start stream - no WiFi connection");
                streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                        ServiceConstants.ERROR_NO_WIFI_CONNECTION);
                return false;
            }

            // Stop any existing stream
            stopAllServices();

            String streamId = data.optString("streamId", "");
            boolean flash = data.optBoolean("flash", true);
            boolean sound = data.optBoolean("sound", true);

            // Parse video/audio config (supports full and compact keys)
            JSONObject videoJson = data.optJSONObject("video");
            if (videoJson == null) videoJson = data.optJSONObject("v");
            JSONObject audioJson = data.optJSONObject("audio");
            if (audioJson == null) audioJson = data.optJSONObject("a");

            // Disable EIS during streaming to reduce camera HAL thermal load
            SysControl.setEisEnable(context, false);

            switch (protocol) {
                case RTMP: {
                    RtmpStreamConfig config = RtmpStreamConfig.fromJson(videoJson, audioJson);
                    Log.d(TAG, "Starting RTMP stream to: " + streamUrl);
                    RtmpStreamingService.startStreaming(context, streamUrl, streamId, flash, sound, config);
                    RtmpStreamingService.setStateManager(stateManager);
                    break;
                }
                case SRT: {
                    RtmpStreamConfig config = RtmpStreamConfig.fromJson(videoJson, audioJson);
                    Log.d(TAG, "Starting SRT stream to: " + streamUrl);
                    SrtStreamingService.startStreaming(context, streamUrl, streamId, flash, sound, config);
                    SrtStreamingService.setStateManager(stateManager);
                    break;
                }
                case WHIP: {
                    WhipStreamConfig config = WhipStreamConfig.fromJson(videoJson, audioJson);
                    Log.d(TAG, "Starting WHIP stream to: " + streamUrl);
                    WhipStreamingService.startStreaming(context, streamUrl, streamId, flash, sound, config);
                    break;
                }
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling start stream command", e);
            streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR, e.getMessage());
            return false;
        }
    }

    /**
     * Handle stop stream command — stops whichever service is currently streaming.
     */
    public boolean handleStopCommand() {
        try {
            if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
                RtmpStreamingService.stopStreaming(context);
                streamingManager.sendStreamStatusResponse(true, ServiceConstants.STATUS_STOPPING, null);
                return true;
            } else if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
                SrtStreamingService.stopStreaming(context);
                streamingManager.sendStreamStatusResponse(true, ServiceConstants.STATUS_STOPPING, null);
                return true;
            } else if (WhipStreamingService.isStreaming() || WhipStreamingService.isReconnecting()) {
                WhipStreamingService.stopStreaming(context);
                streamingManager.sendStreamStatusResponse(true, ServiceConstants.STATUS_STOPPING, null);
                return true;
            } else {
                streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                        ServiceConstants.ERROR_NOT_STREAMING);
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling stop stream command", e);
            streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR, e.getMessage());
            return false;
        }
    }

    /**
     * Handle get stream status command.
     */
    public boolean handleStatusCommand() {
        try {
            boolean isStreaming = RtmpStreamingService.isStreaming()
                    || SrtStreamingService.isStreaming()
                    || WhipStreamingService.isStreaming();
            boolean isReconnecting = RtmpStreamingService.isReconnecting()
                    || SrtStreamingService.isReconnecting()
                    || WhipStreamingService.isReconnecting();

            JSONObject status = new JSONObject();
            status.put("streaming", isStreaming);

            if (isReconnecting) {
                status.put("reconnecting", true);
                if (RtmpStreamingService.isReconnecting()) {
                    status.put("attempt", RtmpStreamingService.getReconnectAttempt());
                } else {
                    status.put("attempt", SrtStreamingService.getReconnectAttempt());
                }
            }

            streamingManager.sendStreamStatusResponse(true, status);
            return true;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating stream status response", e);
            streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                    ServiceConstants.ERROR_JSON_ERROR);
            return false;
        }
    }

    /**
     * Handle keep stream alive command — resets the timeout on whichever service is active.
     */
    public boolean handleKeepAliveCommand(JSONObject data) {
        try {
            String streamId = data.optString("streamId", "");
            String ackId = data.optString("ackId", "");

            if (streamId.isEmpty() || ackId.isEmpty()) {
                Log.d(TAG, "Keep-alive missing required fields (streamId or ackId) - ignoring");
                return false;
            }

            // Try each service in turn
            if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
                boolean valid = RtmpStreamingService.resetStreamTimeout(streamId);
                if (valid || RtmpStreamingService.isStreaming()) {
                    streamingManager.sendKeepAliveAck(streamId, ackId);
                    return true;
                }
            }

            if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
                boolean valid = SrtStreamingService.resetStreamTimeout(streamId);
                if (valid || SrtStreamingService.isStreaming()) {
                    streamingManager.sendKeepAliveAck(streamId, ackId);
                    return true;
                }
            }

            if (WhipStreamingService.isStreaming()) {
                streamingManager.sendKeepAliveAck(streamId, ackId);
                return true;
            }

            Log.w(TAG, "Keep-alive for unknown stream, not currently streaming: " + streamId);
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error handling keep-alive command", e);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private void stopAllServices() {
        if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
            RtmpStreamingService.stopStreaming(context);
        }
        if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
            SrtStreamingService.stopStreaming(context);
        }
        if (WhipStreamingService.isStreaming() || WhipStreamingService.isReconnecting()) {
            WhipStreamingService.stopStreaming(context);
        }
        // Brief pause to let services clean up before starting a new one
        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
