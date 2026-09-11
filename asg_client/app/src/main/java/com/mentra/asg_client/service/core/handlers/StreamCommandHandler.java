package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.SystemClock;
import android.util.Log;

import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.utils.HotspotNetworkUtils;
import com.mentra.asg_client.io.streaming.config.RtmpStreamConfig;
import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipCameraCapturer;
import com.mentra.asg_client.io.streaming.services.WhipCameraFormatSelector;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.utils.ServiceConstants;
import com.mentra.asg_client.service.utils.ServiceUtils;

import io.github.thibaultbee.streampack.internal.sources.camera.CameraController;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for streaming commands (RTMP, SRT, WHIP). Routes to the appropriate streaming service
 * based on the stream URL protocol.
 */
public class StreamCommandHandler implements ICommandHandler {
    private static final String TAG = "StreamCommandHandler";

    /**
     * Toggle Electronic Image Stabilization for livestreams. When true, livestreams enable EIS
     * (Pixsmart vendor stack: system property + per-CaptureRequest SPORTS scene mode and vendor
     * key). When false, EIS is disabled for the duration of the stream to reduce camera HAL thermal
     * load.
     */
    private static final boolean EIS_IN_LIVESTREAMS = false;

    /**
     * EIS only kicks in below this pixel budget. Higher resolutions push the camera HAL into
     * thermal/throughput regimes where EIS makes the stream worse.
     */
    private static final int EIS_MAX_PIXELS = 500_000;

    private final Context context;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;
    private final HotspotStreamActivityTracker mHotspotActivityTracker;

    public StreamCommandHandler(
            Context context,
            IStateManager stateManager,
            IMediaManager streamingManager,
            INetworkManager networkManager) {
        this.context = context;
        this.stateManager = stateManager;
        this.streamingManager = streamingManager;
        this.mHotspotActivityTracker = new HotspotStreamActivityTracker(networkManager);
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

    private enum Protocol {
        RTMP,
        SRT,
        WHIP,
        UNKNOWN
    }

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

    /** Handle start stream command — routes to RTMP, SRT, or WHIP service based on URL. */
    private boolean handleStartCommand(JSONObject data) {
        long startupStartedAtMs = SystemClock.elapsedRealtime();
        boolean eisChanged = false;
        boolean streamStarted = false;
        String streamId = data.optString("streamId", "");
        try {
            // Accept streamUrl first, then legacy rtmpUrl / srtUrl keys
            String streamUrl = data.optString("streamUrl", "");
            if (streamUrl.isEmpty()) streamUrl = data.optString("rtmpUrl", "");
            if (streamUrl.isEmpty()) streamUrl = data.optString("srtUrl", "");
            if (streamUrl.isEmpty()) streamUrl = data.optString("whipUrl", "");

            if (streamUrl.isEmpty()) {
                Log.e(TAG, "Cannot start stream - missing stream URL");
                sendStreamErrorStatus(streamId, ServiceConstants.ERROR_MISSING_STREAM_URL);
                return false;
            }

            Protocol protocol = detectProtocol(streamUrl);
            if (protocol == Protocol.UNKNOWN) {
                Log.e(TAG, "Unknown stream URL protocol: " + streamUrl);
                sendStreamErrorStatus(streamId, "Unknown stream URL protocol");
                return false;
            }

            // Mentra Live accepts synthetic [fps,fps] inside a wider AE band; keep the
            // StreamPackLite workaround off for generic Android HALs (Codex P1).
            CameraController.forceFixedFpsInsideSupportedBand = ServiceUtils.isK900Device(context);

            // BATTERY CHECK
            if (stateManager != null) {
                int batteryLevel = stateManager.getBatteryLevel();
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(TAG, "🚫 Stream rejected - battery too low (" + batteryLevel + "%)");
                    MediaCaptureService.playBatteryLowSound(context);
                    sendStreamErrorStatus(
                            streamId,
                            "Battery level too low ("
                                    + batteryLevel
                                    + "%) - minimum "
                                    + BatteryConstants.MIN_BATTERY_LEVEL
                                    + "% required");
                    return false;
                }
            } else {
                Log.w(TAG, "⚠️ StateManager not available - skipping battery check");
            }

            // The hotspot is a directly connected local network, even though Android does not
            // report it as a connected STA WiFi network.
            boolean hasStaWifi = stateManager == null || stateManager.isConnectedToWifi();
            boolean hasLocalHotspotRoute = HotspotNetworkUtils.isEndpointOnActiveHotspot(streamUrl);
            if (!hasStaWifi && !hasLocalHotspotRoute) {
                Log.e(TAG, "Cannot start stream - no WiFi or local hotspot route");
                sendStreamErrorStatus(streamId, ServiceConstants.ERROR_NO_WIFI_CONNECTION);
                return false;
            }

            // Stop any existing stream
            boolean stoppedExistingStream = stopAllServices();
            Log.i(
                    TAG,
                    "[STREAM_STARTUP] stage=existing_streams_checked elapsedMs="
                            + (SystemClock.elapsedRealtime() - startupStartedAtMs)
                            + " stoppedExisting="
                            + stoppedExistingStream);

            // Capture light is mandatory for privacy; ignore any caller-supplied flash value.
            boolean flash = true;
            boolean sound = data.optBoolean("sound", true);

            // Parse video/audio config (supports full and compact keys)
            JSONObject videoJson = data.optJSONObject("video");
            if (videoJson == null) videoJson = data.optJSONObject("v");
            JSONObject audioJson = data.optJSONObject("audio");
            if (audioJson == null) audioJson = data.optJSONObject("a");

            switch (protocol) {
                case RTMP:
                    {
                        RtmpStreamConfig config = RtmpStreamConfig.fromJson(videoJson, audioJson);
                        Log.i(TAG, "[VideoQuality] parsed RTMP config " + config);
                        if (!preflightCameraCaptureForPackStreaming(config, streamId)) {
                            return false;
                        }
                        // Toggle EIS for the duration of the stream (see EIS_IN_LIVESTREAMS).
                        // Gate on resolution so EIS only runs when the camera HAL can handle it.
                        applyEisForStreaming(config.getVideoWidth(), config.getVideoHeight());
                        eisChanged = true;
                        Log.d(TAG, "Starting RTMP stream to: " + streamUrl);
                        RtmpStreamingService.startStreaming(
                                context, streamUrl, streamId, flash, sound, config);
                        streamStarted = true;
                        RtmpStreamingService.setStateManager(stateManager);
                        break;
                    }
                case SRT:
                    {
                        RtmpStreamConfig config = RtmpStreamConfig.fromJson(videoJson, audioJson);
                        Log.i(TAG, "[VideoQuality] parsed SRT config " + config);
                        if (!preflightCameraCaptureForPackStreaming(config, streamId)) {
                            return false;
                        }
                        applyEisForStreaming(config.getVideoWidth(), config.getVideoHeight());
                        eisChanged = true;
                        Log.d(TAG, "Starting SRT stream to: " + streamUrl);
                        SrtStreamingService.startStreaming(
                                context, streamUrl, streamId, flash, sound, config);
                        streamStarted = true;
                        SrtStreamingService.setStateManager(stateManager);
                        break;
                    }
                case WHIP:
                    {
                        WhipStreamConfig config = WhipStreamConfig.fromJson(videoJson, audioJson);
                        Log.i(TAG, "[VideoQuality] parsed WHIP config " + config);
                        if (!preflightCameraCaptureForWhip(config, streamId)) {
                            return false;
                        }
                        applyEisForStreaming(config.getVideoWidth(), config.getVideoHeight());
                        eisChanged = true;
                        Log.i(
                                TAG,
                                "[STREAM_STARTUP] stage=service_start_requested protocol=whip elapsedMs="
                                        + (SystemClock.elapsedRealtime() - startupStartedAtMs));
                        Log.d(TAG, "Starting WHIP stream to: " + streamUrl);
                        String authToken = null;
                        if (data.has("authToken")) {
                            String value = data.optString("authToken", "");
                            if (!value.isEmpty()) authToken = value;
                        } else if (data.has("auth_token")) {
                            String value = data.optString("auth_token", "");
                            if (!value.isEmpty()) authToken = value;
                        }
                        WhipStreamingService.startStreaming(
                                context, streamUrl, streamId, flash, sound, config, authToken);
                        streamStarted = true;
                        WhipStreamingService.setStateManager(stateManager);
                        break;
                    }
            }

            mHotspotActivityTracker.onStreamStarted(hasLocalHotspotRoute);

            return true;
        } catch (Exception e) {
            if (eisChanged && !streamStarted) {
                restoreEisAfterStreaming();
            }
            Log.e(TAG, "Error handling start stream command", e);
            sendStreamErrorStatus(streamId, e.getMessage());
            return false;
        }
    }

    /**
     * Apply EIS configuration for an active livestream. Updates the Pixsmart system property used
     * by the camera pipeline.
     *
     * <p>EIS is only enabled when the requested resolution is at or below {@link #EIS_MAX_PIXELS};
     * above that, EIS is forced off because the camera HAL cannot sustain it without degrading the
     * stream.
     */
    private void applyEisForStreaming(int width, int height) {
        boolean withinEisBudget = ((long) width * (long) height) < EIS_MAX_PIXELS;
        boolean enable = EIS_IN_LIVESTREAMS && withinEisBudget;
        if (EIS_IN_LIVESTREAMS && !withinEisBudget) {
            Log.i(
                    TAG,
                    "EIS disabled for " + width + "x" + height + " (>= " + EIS_MAX_PIXELS + " px)");
        }
        SystemControllerFactory.get(context).setEisEnabled(enable);
    }

    /**
     * Restore EIS to the asg_client default (off) once a livestream ends or fails to start. Mirrors
     * AsgClientService boot-time configuration.
     */
    private void restoreEisAfterStreaming() {
        SystemControllerFactory.get(context).setEisEnabled(false);
    }

    /**
     * RTMP/SRT: reject if no native mode can cover the requested output without upscaling; stamps
     * {@link RtmpStreamConfig#setCaptureSize(int, int)} for StreamPackLite.
     */
    private boolean preflightCameraCaptureForPackStreaming(
            RtmpStreamConfig config, String streamId) {
        try {
            if (!WhipCameraFormatSelector.stampCaptureSizeOntoConfig(context, config)) {
                Log.w(
                        TAG,
                        "Rejecting stream: camera cannot satisfy output without upscaling: "
                                + config.getVideoWidth()
                                + "x"
                                + config.getVideoHeight());
                restoreEisAfterStreaming();
                sendStreamErrorStatus(streamId, "Resolution not supported by camera");
                return false;
            }
            return true;
        } catch (CameraAccessException e) {
            Log.w(TAG, "Camera access failed during stream preflight", e);
            restoreEisAfterStreaming();
            sendStreamErrorStatus(streamId, "Could not access camera for resolution check");
            return false;
        }
    }

    /**
     * WHIP: reject upscale-only requests. On validation failure, match legacy behavior and allow.
     */
    private boolean preflightCameraCaptureForWhip(WhipStreamConfig config, String streamId) {
        try {
            CameraManager cameraManager =
                    (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
            if (cameraManager == null) {
                Log.w(TAG, "Rejecting WHIP stream request because camera manager is unavailable");
                restoreEisAfterStreaming();
                sendStreamErrorStatus(streamId, "Could not access camera");
                return false;
            }

            String cameraId = WhipCameraFormatSelector.selectBackCamera(cameraManager);
            if (cameraId == null) {
                Log.w(TAG, "Rejecting WHIP stream request because no camera is available");
                restoreEisAfterStreaming();
                sendStreamErrorStatus(streamId, "Could not access camera");
                return false;
            }

            CameraCharacteristics characteristics =
                    cameraManager.getCameraCharacteristics(cameraId);
            if (!WhipCameraFormatSelector.canSatisfyWithoutUpscale(
                    characteristics, config.getVideoWidth(), config.getVideoHeight())) {
                Log.w(
                        TAG,
                        "Rejecting WHIP stream request that cannot be satisfied without upscaling: "
                                + config.getVideoWidth()
                                + "x"
                                + config.getVideoHeight());
                restoreEisAfterStreaming();
                sendStreamErrorStatus(streamId, "Resolution not supported by camera");
                return false;
            }

            // Effective transmitted fps is the lower of the camera capture rate and the
            // output target (frames are dropped when the camera runs faster).
            config.setStatusVideoFps(
                    Math.min(
                            WhipCameraCapturer.resolveCameraFps(
                                    characteristics, config.getVideoFps()),
                            config.getVideoFps()));
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Unable to validate WHIP stream resolution; allowing request", e);
            config.setStatusVideoFps(config.getVideoFps());
            return true;
        }
    }

    /** Handle stop stream command — stops whichever service is currently streaming. */
    public boolean handleStopCommand() {
        try {
            if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
                sendStreamStoppingStatus(RtmpStreamingService.getCurrentStreamId());
                RtmpStreamingService.stopStreaming(context);
                mHotspotActivityTracker.onStreamStopped();
                restoreEisAfterStreaming();
                return true;
            } else if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
                sendStreamStoppingStatus(SrtStreamingService.getCurrentStreamId());
                SrtStreamingService.stopStreaming(context);
                mHotspotActivityTracker.onStreamStopped();
                restoreEisAfterStreaming();
                return true;
            } else if (WhipStreamingService.isStreaming()
                    || WhipStreamingService.isReconnecting()) {
                sendStreamStoppingStatus(WhipStreamingService.getCurrentStreamId());
                WhipStreamingService.stopStreaming(context);
                mHotspotActivityTracker.onStreamStopped();
                restoreEisAfterStreaming();
                return true;
            } else {
                mHotspotActivityTracker.onStreamStopped();
                streamingManager.sendStreamStatusResponse(
                        false, ServiceConstants.STATUS_ERROR, ServiceConstants.ERROR_NOT_STREAMING);
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling stop stream command", e);
            streamingManager.sendStreamStatusResponse(
                    false, ServiceConstants.STATUS_ERROR, e.getMessage());
            return false;
        }
    }

    /** Send an error stream status echoing the rejected command's streamId when it carried one. */
    private void sendStreamErrorStatus(String streamId, String details) {
        if (streamId == null || streamId.isEmpty()) {
            streamingManager.sendStreamStatusResponse(
                    false, ServiceConstants.STATUS_ERROR, details);
            return;
        }
        try {
            JSONObject status = new JSONObject();
            status.put("status", ServiceConstants.STATUS_ERROR);
            if (details != null) {
                status.put("errorDetails", details);
            }
            status.put("streamId", streamId);
            streamingManager.sendStreamStatusResponse(false, status);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating stream error status", e);
        }
    }

    /** Send a stopping stream status carrying the id of the stream being stopped. */
    private void sendStreamStoppingStatus(String streamId) {
        if (streamId == null || streamId.isEmpty()) {
            streamingManager.sendStreamStatusResponse(
                    true, ServiceConstants.STATUS_STOPPING, null);
            return;
        }
        try {
            JSONObject status = new JSONObject();
            status.put("status", ServiceConstants.STATUS_STOPPING);
            status.put("streamId", streamId);
            streamingManager.sendStreamStatusResponse(true, status);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating stream stopping status", e);
        }
    }

    /** Handle get stream status command. */
    public boolean handleStatusCommand() {
        try {
            boolean isStreaming =
                    RtmpStreamingService.isActivelyStreaming()
                            || SrtStreamingService.isActivelyStreaming()
                            || WhipStreamingService.isActivelyStreaming();
            boolean isStarting =
                    RtmpStreamingService.isStarting()
                            || SrtStreamingService.isStarting()
                            || WhipStreamingService.isStarting();
            boolean isReconnecting =
                    RtmpStreamingService.isReconnecting()
                            || SrtStreamingService.isReconnecting()
                            || WhipStreamingService.isReconnecting();

            JSONObject status = new JSONObject();
            status.put("kind", "snapshot");
            status.put(
                    "status",
                    isReconnecting
                            ? "reconnecting"
                            : (isStarting
                                    ? "initializing"
                                    : (isStreaming ? "streaming" : "stopped")));
            status.put("streaming", isStreaming);
            status.put("reconnecting", isReconnecting);

            String streamId = null;
            if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
                streamId = RtmpStreamingService.getCurrentStreamId();
            } else if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
                streamId = SrtStreamingService.getCurrentStreamId();
            } else if (WhipStreamingService.isStreaming()
                    || WhipStreamingService.isReconnecting()) {
                streamId = WhipStreamingService.getCurrentStreamId();
            }
            if (streamId != null && !streamId.isEmpty()) {
                status.put("streamId", streamId);
            }

            if (isReconnecting) {
                if (RtmpStreamingService.isReconnecting()) {
                    status.put("attempt", RtmpStreamingService.getReconnectAttempt());
                } else if (SrtStreamingService.isReconnecting()) {
                    status.put("attempt", SrtStreamingService.getReconnectAttempt());
                }
            }

            streamingManager.sendStreamStatusResponse(true, status);
            return true;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating stream status response", e);
            streamingManager.sendStreamStatusResponse(
                    false, ServiceConstants.STATUS_ERROR, ServiceConstants.ERROR_JSON_ERROR);
            return false;
        }
    }

    /** Handle keep stream alive command — resets the timeout on whichever service is active. */
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
                    if (valid) {
                        mHotspotActivityTracker.onKeepAlive();
                    }
                    streamingManager.sendKeepAliveAck(streamId, ackId);
                    return true;
                }
            }

            if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
                boolean valid = SrtStreamingService.resetStreamTimeout(streamId);
                if (valid || SrtStreamingService.isStreaming()) {
                    if (valid) {
                        mHotspotActivityTracker.onKeepAlive();
                    }
                    streamingManager.sendKeepAliveAck(streamId, ackId);
                    return true;
                }
            }

            if (WhipStreamingService.isStreaming() || WhipStreamingService.isReconnecting()) {
                boolean valid = WhipStreamingService.resetStreamTimeout(streamId);
                if (valid || WhipStreamingService.isStreaming()) {
                    if (valid) {
                        mHotspotActivityTracker.onKeepAlive();
                    }
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

    private boolean stopAllServices() {
        mHotspotActivityTracker.onStreamStopped();
        boolean stoppedExistingStream = false;
        if (RtmpStreamingService.isStreaming() || RtmpStreamingService.isReconnecting()) {
            RtmpStreamingService.stopStreaming(context);
            stoppedExistingStream = true;
        }
        if (SrtStreamingService.isStreaming() || SrtStreamingService.isReconnecting()) {
            SrtStreamingService.stopStreaming(context);
            stoppedExistingStream = true;
        }
        if (WhipStreamingService.isStreaming() || WhipStreamingService.isReconnecting()) {
            WhipStreamingService.stopStreaming(context);
            stoppedExistingStream = true;
        }
        if (stoppedExistingStream) {
            // Give an active service time to release camera/encoder resources
            // before replacing it. Cold starts do not need this delay.
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        return stoppedExistingStream;
    }
}
