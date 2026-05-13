package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.util.Log;

import com.mentra.asg_client.io.streaming.config.RtmpStreamConfig;
import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;
import com.mentra.asg_client.io.streaming.services.WhipCameraFormatSelector;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.SysControl;
import io.github.thibaultbee.streampack.internal.sources.camera.CameraController;
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

    /**
     * Toggle Electronic Image Stabilization for livestreams.
     * When true, livestreams enable EIS (Pixsmart vendor stack: system property
     * + per-CaptureRequest SPORTS scene mode and vendor key). When false, EIS
     * is disabled for the duration of the stream to reduce camera HAL thermal load.
     */
    private static final boolean EIS_IN_LIVESTREAMS = true;

    /**
     * EIS only kicks in below this pixel budget. Higher resolutions push the camera
     * HAL into thermal/throughput regimes where EIS makes the stream worse.
     */
    private static final int EIS_MAX_PIXELS = 500_000;

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
        boolean eisChanged = false;
        boolean streamStarted = false;
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

            switch (protocol) {
                case RTMP: {
                    RtmpStreamConfig config = RtmpStreamConfig.fromJson(videoJson, audioJson);
                    if (!preflightCameraCaptureForPackStreaming(config)) {
                        return false;
                    }
                    // Toggle EIS for the duration of the stream (see EIS_IN_LIVESTREAMS).
                    // Gate on resolution so EIS only runs when the camera HAL can handle it.
                    applyEisForStreaming(config.getVideoWidth(), config.getVideoHeight());
                    eisChanged = true;
                    Log.d(TAG, "Starting RTMP stream to: " + streamUrl);
                    RtmpStreamingService.startStreaming(context, streamUrl, streamId, flash, sound, config);
                    streamStarted = true;
                    RtmpStreamingService.setStateManager(stateManager);
                    break;
                }
                case SRT: {
                    RtmpStreamConfig config = RtmpStreamConfig.fromJson(videoJson, audioJson);
                    if (!preflightCameraCaptureForPackStreaming(config)) {
                        return false;
                    }
                    applyEisForStreaming(config.getVideoWidth(), config.getVideoHeight());
                    eisChanged = true;
                    Log.d(TAG, "Starting SRT stream to: " + streamUrl);
                    SrtStreamingService.startStreaming(context, streamUrl, streamId, flash, sound, config);
                    streamStarted = true;
                    SrtStreamingService.setStateManager(stateManager);
                    break;
                }
                case WHIP: {
                    WhipStreamConfig config = WhipStreamConfig.fromJson(videoJson, audioJson);
                    if (!preflightCameraCaptureForWhip(config.getVideoWidth(), config.getVideoHeight())) {
                        return false;
                    }
                    applyEisForStreaming(config.getVideoWidth(), config.getVideoHeight());
                    eisChanged = true;
                    Log.d(TAG, "Starting WHIP stream to: " + streamUrl);
                    WhipStreamingService.startStreaming(context, streamUrl, streamId, flash, sound, config);
                    streamStarted = true;
                    WhipStreamingService.setStateManager(stateManager);
                    break;
                }
            }

            return true;
        } catch (Exception e) {
            if (eisChanged && !streamStarted) {
                restoreEisAfterStreaming();
            }
            Log.e(TAG, "Error handling start stream command", e);
            streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR, e.getMessage());
            return false;
        }
    }

    /**
     * Apply EIS configuration for an active livestream. Updates the Pixsmart
     * system property and arms the StreamPackLite per-CaptureRequest hook so
     * the next session start uses SPORTS scene mode plus the vendor key.
     *
     * EIS is only enabled when the requested resolution is at or below
     * {@link #EIS_MAX_PIXELS}; above that, EIS is forced off because the camera
     * HAL cannot sustain it without degrading the stream.
     */
    private void applyEisForStreaming(int width, int height) {
        boolean withinEisBudget = ((long) width * (long) height) < EIS_MAX_PIXELS;
        boolean enable = EIS_IN_LIVESTREAMS && withinEisBudget;
        if (EIS_IN_LIVESTREAMS && !withinEisBudget) {
            Log.i(TAG, "EIS disabled for " + width + "x" + height + " (>= " + EIS_MAX_PIXELS + " px)");
        }
        SysControl.setEisEnable(context, enable);
        CameraController.enablePixsmartEisOnRequest = enable;
    }

    /**
     * Restore EIS to the asg_client default (off) once a livestream ends or
     * fails to start. Mirrors AsgClientService boot-time configuration.
     */
    private void restoreEisAfterStreaming() {
        SysControl.setEisEnable(context, false);
        CameraController.enablePixsmartEisOnRequest = false;
    }

    /**
     * RTMP/SRT: reject if no native mode can cover the requested output without upscaling;
     * stamps {@link RtmpStreamConfig#setCaptureSize(int, int)} for StreamPackLite.
     */
    private boolean preflightCameraCaptureForPackStreaming(RtmpStreamConfig config) {
        try {
            if (!WhipCameraFormatSelector.stampCaptureSizeOntoConfig(context, config)) {
                Log.w(TAG, "Rejecting stream: camera cannot satisfy output without upscaling: "
                        + config.getVideoWidth() + "x" + config.getVideoHeight());
                restoreEisAfterStreaming();
                streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                        "Resolution not supported by camera");
                return false;
            }
            return true;
        } catch (CameraAccessException e) {
            Log.w(TAG, "Camera access failed during stream preflight", e);
            restoreEisAfterStreaming();
            streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                    "Could not access camera for resolution check");
            return false;
        }
    }

    /**
     * WHIP: reject upscale-only requests. On validation failure, match legacy behavior and allow.
     */
    private boolean preflightCameraCaptureForWhip(int width, int height) {
        try {
            if (!WhipCameraFormatSelector.canSatisfyWithoutUpscale(context, width, height)) {
                Log.w(TAG, "Rejecting WHIP stream request that cannot be satisfied without upscaling: "
                        + width + "x" + height);
                restoreEisAfterStreaming();
                streamingManager.sendStreamStatusResponse(false, ServiceConstants.STATUS_ERROR,
                        "Resolution not supported by camera");
                return false;
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Unable to validate WHIP stream resolution; allowing request", e);
            return true;
        }
    }

    /**
     * Handle stop stream command — stops whichever service is currently streaming.
     */
    public boolean handleStopCommand() {
        try {
            if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
                RtmpStreamingService.stopStreaming(context);
                restoreEisAfterStreaming();
                streamingManager.sendStreamStatusResponse(true, ServiceConstants.STATUS_STOPPING, null);
                return true;
            } else if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
                SrtStreamingService.stopStreaming(context);
                restoreEisAfterStreaming();
                streamingManager.sendStreamStatusResponse(true, ServiceConstants.STATUS_STOPPING, null);
                return true;
            } else if (WhipStreamingService.isStreaming() || WhipStreamingService.isReconnecting()) {
                WhipStreamingService.stopStreaming(context);
                restoreEisAfterStreaming();
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

            if (WhipStreamingService.isStreaming() || WhipStreamingService.isReconnecting()) {
                boolean valid = WhipStreamingService.resetStreamTimeout(streamId);
                if (valid || WhipStreamingService.isStreaming()) {
                    streamingManager.sendKeepAliveAck(streamId, ackId);
                    return true;
                }
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
