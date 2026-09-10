package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.SystemClock;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.streaming.StreamPhonePresencePolicy;
import com.mentra.asg_client.io.streaming.StreamControllerLease;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.utils.WakeLockManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;

import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.utils.HotspotNetworkUtils;
import com.mentra.asg_client.io.streaming.LivestreamEisPolicy;
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

    private final Context context;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;
    private final HotspotStreamActivityTracker mHotspotActivityTracker;
    private final AsgClientServiceManager mServiceManager;
    private final Handler mLifecycleHandler = new Handler(Looper.getMainLooper());
    private final StreamPhonePresencePolicy mPhonePolicy = new StreamPhonePresencePolicy(
            AsgConstants.STREAM_PHONE_DISCONNECT_GRACE_MS);
    private LinkStateMachine mPhoneLink;
    private boolean mDisposed;
    private Runnable mPhoneLossDeadline;
    private String mOwnedStreamId;
    private String mOwnedControllerId;
    private long mOwnedStartRevision = -1;
    private Runnable mResourceRefresh;
    private Runnable mControllerProbeTick;
    private final StreamControllerLease mControllerLease = new StreamControllerLease(
            AsgConstants.STREAM_CONTROLLER_RESPONSE_TIMEOUT_MS,
            () -> java.util.UUID.randomUUID().toString());
    private final LinkStateMachine.Listener mPresenceListener = (state, caps, presence) ->
            mLifecycleHandler.post(() -> {
                // Read the latest signal after dispatch; queued reports may predate a start or
                // a replacement UART session. Never replay an old PRESENT over a newer ABSENT.
                if (mPhoneLink != null) updatePhonePresence(mPhoneLink.getPhonePresence());
            });

    public StreamCommandHandler(
            Context context,
            IStateManager stateManager,
            IMediaManager streamingManager,
            INetworkManager networkManager) {
        this(context, stateManager, streamingManager, networkManager, null);
    }

    /** Creates the phone-owned streaming command handler with authoritative BES presence. */
    public StreamCommandHandler(
            Context context,
            IStateManager stateManager,
            IMediaManager streamingManager,
            INetworkManager networkManager,
            AsgClientServiceManager serviceManager) {
        this.context = context;
        this.stateManager = stateManager;
        this.streamingManager = streamingManager;
        this.mHotspotActivityTracker = new HotspotStreamActivityTracker(networkManager);
        this.mServiceManager = serviceManager;
        streamingManager.setStreamStatusListener(status -> mLifecycleHandler.post(() -> {
            if (status.optBoolean("terminal", false)
                    && status.optLong("revision", -1) >= mOwnedStartRevision
                    && mOwnedStreamId != null
                    && mOwnedStreamId.equals(status.optString("streamId", ""))) {
                releaseStreamOwnership();
            }
        }));
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("start_stream", "stop_stream", "get_stream_status", "keep_stream_alive",
                "stream_controller_response");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!getSupportedCommandTypes().contains(commandType)) return false;
        // Commands, presence edges, and deadline claims must mutate the same lifecycle owner.
        if (Looper.myLooper() != mLifecycleHandler.getLooper()) {
            mLifecycleHandler.post(() -> handleCommand(commandType, data));
            return true;
        }
        if (mDisposed) return false;
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
                case "stream_controller_response":
                    return Integer.valueOf(1).equals(data.opt("protocolVersion"))
                            && mOwnedStreamId != null
                            && mOwnedStreamId.equals(data.opt("streamId"))
                            && mOwnedControllerId.equals(data.opt("controllerId"))
                            && mControllerLease.acknowledge(data.optString("probeId", ""),
                                    SystemClock.elapsedRealtime());
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
        if (streamId.isEmpty()) streamId = "asg-" + java.util.UUID.randomUUID();
        try {
            if (!Integer.valueOf(1).equals(data.opt("controllerProbeVersion"))
                    || !(data.opt("controllerId") instanceof String)
                    || data.optString("controllerId", "").isEmpty()) {
                sendStreamErrorStatus(streamId, "Update the Mentra App: native stream controller probing is required");
                return false;
            }
            bindPhonePresence();
            if (!mPhonePolicy.canStart()) {
                sendStreamErrorStatus(streamId,
                        "Phone BLE presence unavailable; connect the Mentra App and update BES firmware");
                return false;
            }
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
                if (BatteryConstants.isCameraBatteryLow(batteryLevel, HardwareManagerFactory.getInitializedInstance())) {
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
            Boolean captureAudioOverride = null;
            if (data.has("captureAudio")) {
                captureAudioOverride = data.optBoolean("captureAudio", true);
            } else if (data.has("ca")) {
                captureAudioOverride = data.optBoolean("ca", true);
            }

            switch (protocol) {
                case RTMP:
                    {
                        RtmpStreamConfig config = RtmpStreamConfig.fromJson(videoJson, audioJson);
                        Log.i(TAG, "[VideoQuality] parsed RTMP config " + config);
                        if (!preflightCameraCaptureForPackStreaming(config, streamId)) {
                            return false;
                        }
                        // Toggle EIS for the duration of the stream (500k pixel gate).
                        // Gate on resolution so EIS only runs when the camera HAL can handle it.
                        applyEisForStreaming(config.getVideoWidth(), config.getVideoHeight());
                        eisChanged = true;
                        Log.d(TAG, "Starting RTMP stream to: " + streamUrl);
                        beginStreamOwnership(streamId, data.getString("controllerId"));
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
                        beginStreamOwnership(streamId, data.getString("controllerId"));
                        SrtStreamingService.startStreaming(
                                context, streamUrl, streamId, flash, sound, config);
                        streamStarted = true;
                        SrtStreamingService.setStateManager(stateManager);
                        break;
                    }
                case WHIP:
                    {
                        WhipStreamConfig config = WhipStreamConfig.fromJson(videoJson, audioJson);
                        if (captureAudioOverride != null) {
                            config.setCaptureAudio(captureAudioOverride);
                        }
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
                        beginStreamOwnership(streamId, data.getString("controllerId"));
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
            if (!streamStarted && streamId.equals(mOwnedStreamId)) {
                streamingManager.getStreamingStatusCallback().onStreamError(e.getMessage(), streamId);
                releaseStreamOwnership();
            }
            if (eisChanged && !streamStarted) {
                restoreEisAfterStreaming();
            }
            Log.e(TAG, "Error handling start stream command", e);
            sendStreamErrorStatus(streamId, e.getMessage());
            return false;
        }
    }

    /**
     * Arm livestream EIS only under the 500k pixel gate. Mentra Call 540p/720p stay
     * off. WHIP also applies {@code EisController} on its own repeating request.
     */
    private void applyEisForStreaming(int width, int height) {
        boolean enable = LivestreamEisPolicy.logDecision(TAG, "stream-start", width, height);
        CameraController.enablePixsmartEisOnRequest = enable;
        SystemControllerFactory.get(context).setEisEnabled(enable);
    }

    /**
     * Restore EIS to the asg_client default (off) once a livestream ends or fails to start. Mirrors
     * AsgClientService boot-time configuration.
     */
    private void restoreEisAfterStreaming() {
        Log.i(TAG, "EIS stage=stream-stop enable=false reason=restore-default-off");
        CameraController.enablePixsmartEisOnRequest = false;
        try {
            SystemControllerFactory.get(context).setEisEnabled(false);
        } catch (Exception error) {
            Log.w(TAG, "Unable to restore vendor EIS after stream teardown", error);
        }
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
        if (Looper.myLooper() != mLifecycleHandler.getLooper()) {
            mLifecycleHandler.post(this::handleStopCommand);
            return true;
        }
        String stoppedId = mOwnedStreamId;
        if (stoppedId == null) stoppedId = streamingManager.getStreamSnapshot().optString("streamId", null);
        if (stoppedId != null) sendStreamStoppingStatus(stoppedId);
        stopAllServices();
        restoreEisAfterStreaming();
        if (stoppedId != null) {
            streamingManager.getStreamingStatusCallback().onStreamStopped(stoppedId);
        } else {
            // Stop is idempotent, including after an ASG restart or a lost stop response.
            streamingManager.sendStreamStatusResponse(true, streamingManager.getStreamSnapshot());
        }
        return true;
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
        if (Looper.myLooper() != mLifecycleHandler.getLooper()) {
            mLifecycleHandler.post(this::handleStatusCommand);
            return true;
        }
        streamingManager.sendStreamStatusResponse(true, streamingManager.getStreamSnapshot());
        return true;
    }

    /** Handle keep stream alive command — resets the timeout on whichever service is active. */
    public boolean handleKeepAliveCommand(JSONObject data) {
        String streamId = data.optString("streamId", "");
        String ackId = data.optString("ackId", "");
        if (streamId.isEmpty() || ackId.isEmpty()) return false;
        boolean matches = RtmpStreamingService.isCurrentStream(streamId)
                || SrtStreamingService.isCurrentStream(streamId)
                || WhipStreamingService.isCurrentStream(streamId);
        if (matches) streamingManager.sendKeepAliveAck(streamId, ackId);
        // Legacy receipt only: no phone-loss deadline or resource ownership changes.
        return matches;
    }

    private boolean stopAllServices() {
        boolean hadStream = mOwnedStreamId != null || RtmpStreamingService.isStreaming()
                || RtmpStreamingService.isReconnecting() || SrtStreamingService.isStreaming()
                || SrtStreamingService.isReconnecting() || WhipStreamingService.isStreaming()
                || WhipStreamingService.isReconnecting();
        releaseStreamOwnership();
        // Stop pending service starts too. Publishers release capture synchronously; sleeping
        // here cannot prove teardown and would block the same dispatcher that handles BLE loss.
        RtmpStreamingService.stopStreaming(context);
        SrtStreamingService.stopStreaming(context);
        WhipStreamingService.stopStreaming(context);
        return hadStream;
    }

    private void bindPhonePresence() {
        if (mServiceManager == null
                || !(mServiceManager.getBluetoothManager() instanceof K900BluetoothManager)) return;
        LinkStateMachine link = ((K900BluetoothManager) mServiceManager.getBluetoothManager())
                .getLinkStateMachine();
        if (mPhoneLink != link) {
            if (mPhoneLink != null) mPhoneLink.removeListener(mPresenceListener);
            mPhoneLink = link;
            link.addListener(mPresenceListener);
        }
        updatePhonePresence(link.getPhonePresence());
    }

    private void beginStreamOwnership(String streamId, String controllerId) {
        mOwnedStreamId = streamId;
        mOwnedControllerId = controllerId;
        long generation = mPhonePolicy.start();
        streamingManager.beginStreamSession(streamId);
        mOwnedStartRevision = streamingManager.getStreamSnapshot().optLong("revision", -1);
        mControllerLease.start(SystemClock.elapsedRealtime());
        mControllerProbeTick = new Runnable() {
            @Override public void run() {
                if (mDisposed || mOwnedStreamId == null
                        || generation != mPhonePolicy.getGeneration()) return;
                if (mControllerLease.expired(SystemClock.elapsedRealtime())) {
                    streamingManager.getStreamingStatusCallback().onStreamError(
                            "Controlling phone app stopped responding", mOwnedStreamId);
                    stopAllServices();
                    return;
                }
                try {
                    JSONObject probe = new JSONObject();
                    probe.put("type", "stream_controller_probe");
                    probe.put("protocolVersion", 1);
                    probe.put("streamId", mOwnedStreamId);
                    probe.put("controllerId", mOwnedControllerId);
                    probe.put("probeId", mControllerLease.probeId());
                    if (mServiceManager != null && mServiceManager.getBluetoothManager() != null) {
                        mServiceManager.getBluetoothManager().sendMessage(
                                probe.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    }
                } catch (Exception error) {
                    Log.w(TAG, "Unable to send native stream controller probe", error);
                }
                mLifecycleHandler.postDelayed(this, Math.min(
                        AsgConstants.STREAM_CONTROLLER_PROBE_INTERVAL_MS,
                        mControllerLease.remainingMs(SystemClock.elapsedRealtime())));
            }
        };
        mControllerProbeTick.run();
        mResourceRefresh = new Runnable() {
            @Override
            public void run() {
                if (mDisposed || mOwnedStreamId == null
                        || generation != mPhonePolicy.getGeneration()) return;
                WakeLockManager.acquireCpu(context, WakeLockManager.WakeOwner.STREAMING,
                        AsgConstants.STREAM_CPU_LEASE_MS);
                mHotspotActivityTracker.onSessionActive();
                mLifecycleHandler.postDelayed(this, AsgConstants.STREAM_RESOURCE_REFRESH_MS);
            }
        };
        mResourceRefresh.run();
    }

    private void releaseStreamOwnership() {
        if (mOwnedStreamId != null) restoreEisAfterStreaming();
        mControllerLease.stop();
        if (mControllerProbeTick != null) mLifecycleHandler.removeCallbacks(mControllerProbeTick);
        mControllerProbeTick = null;
        mPhonePolicy.stop();
        cancelPhoneLossDeadline();
        if (mResourceRefresh != null) mLifecycleHandler.removeCallbacks(mResourceRefresh);
        mResourceRefresh = null;
        mOwnedStreamId = null;
        mOwnedControllerId = null;
        mOwnedStartRevision = -1;
        WakeLockManager.release(WakeLockManager.WakeOwner.STREAMING);
        mHotspotActivityTracker.onStreamStopped();
    }

    private void updatePhonePresence(LinkStateMachine.PhonePresence presence) {
        if (mDisposed) return;
        mPhonePolicy.onPresence(StreamPhonePresencePolicy.Presence.valueOf(presence.name()),
                SystemClock.elapsedRealtime());
        cancelPhoneLossDeadline();
        long deadline = mPhonePolicy.getLossDeadlineMs();
        if (deadline < 0) return;
        long generation = mPhonePolicy.getGeneration();
        mPhoneLossDeadline = () -> {
            if (!mPhonePolicy.claimExpiredStop(generation, SystemClock.elapsedRealtime())) return;
            streamingManager.getStreamingStatusCallback().onStreamError(
                    "Phone BLE disconnected beyond grace period", mOwnedStreamId);
            stopAllServices();
        };
        mLifecycleHandler.postDelayed(mPhoneLossDeadline,
                Math.max(0, deadline - SystemClock.elapsedRealtime()));
    }

    private void cancelPhoneLossDeadline() {
        if (mPhoneLossDeadline != null) {
            mLifecycleHandler.removeCallbacks(mPhoneLossDeadline);
            mPhoneLossDeadline = null;
        }
    }

    /** Releases the presence subscription and terminates streams when the command owner closes. */
    public void cleanup() {
        mLifecycleHandler.post(() -> {
            mDisposed = true;
            streamingManager.setStreamStatusListener(null);
            if (mPhoneLink != null) mPhoneLink.removeListener(mPresenceListener);
            stopAllServices();
        });
    }
}
