package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.settings.VideoSettings;
import java.util.Locale;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Handler for video recording commands. Follows Single Responsibility Principle by handling only
 * video commands. Extends BaseMediaCommandHandler for common package directory management.
 */
public class VideoCommandHandler extends BaseMediaCommandHandler {
    private static final String TAG = "VideoCommandHandler";

    // Upper sanity cap (24h) for the optional auto-stop timer. Not a product limit — battery and
    // storage end a real recording long before — it just bounds the downstream
    // `minutes * 60 * 1000L` timer math (which multiplies as int before promotion to long) so a
    // garbage/overflowing value can't wrap to a negative duration and trigger an immediate stop.
    private static final int MAX_RECORDING_TIME_MINUTES = 24 * 60;

    private final AsgClientServiceManager serviceManager;
    private final IMediaManager streamingManager;
    private final IStateManager stateManager;

    public VideoCommandHandler(
            Context context,
            AsgClientServiceManager serviceManager,
            IMediaManager streamingManager,
            FileManager fileManager,
            IStateManager stateManager) {
        super(context, fileManager);
        this.serviceManager = serviceManager;
        this.streamingManager = streamingManager;
        this.stateManager = stateManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of(
                "start_video_recording", "stop_video_recording", "get_video_recording_status");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "start_video_recording":
                    return handleStartVideoRecording(data);
                case "stop_video_recording":
                    return handleStopCommand(data);
                case "get_video_recording_status":
                    return handleStatusCommand(data);
                default:
                    Log.e(TAG, "Unsupported video command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling video command: " + commandType, e);
            return false;
        }
    }

    /** Handle start video recording command */
    private boolean handleStartVideoRecording(JSONObject data) {
        try {
            // Resolve package name using base class functionality
            String packageName = resolvePackageName(data);
            logCommandStart("start_video_recording", packageName);
            String requestId = data.optString("requestId", "");

            // Validate requestId using base class functionality
            if (!validateRequestId(data)) {
                streamingManager.sendVideoRecordingStatusResponse(
                        requestId, false, "missing_request_id", null);
                return false;
            }

            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                logCommandResult(
                        "start_video_recording", false, "Media capture service is not initialized");
                streamingManager.sendVideoRecordingStatusResponse(
                        requestId, false, "service_unavailable", null);
                return false;
            }

            // BATTERY CHECK: Reject if battery too low
            if (stateManager != null) {
                int batteryLevel = stateManager.getBatteryLevel();
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(
                            TAG,
                            "🚫 Video recording rejected - battery too low ("
                                    + batteryLevel
                                    + "%)");
                    logCommandResult(
                            "start_video_recording",
                            false,
                            "Battery too low: " + batteryLevel + "%");

                    // Play audio feedback
                    captureService.playBatteryLowSound();

                    // Send error response to phone
                    streamingManager.sendVideoRecordingStatusResponse(
                            requestId,
                            false,
                            "battery_low",
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

            // Parse video settings if provided. Any field that is missing or <= 0
            // falls back to the saved button-video default rather than being
            // dropped, so partial overrides (e.g. an fps-only request from a
            // miniapp) still apply instead of silently recording at the default
            // frame rate.
            VideoSettings videoSettings = null;
            JSONObject settings = data.optJSONObject("settings");
            if (settings != null) {
                // Resolve the merge baseline from the saved button-video defaults,
                // but only when those persisted defaults are themselves valid. A
                // stale unsupported saved resolution (e.g. a legacy 1440p/4K
                // default written before validation existed) would otherwise
                // poison a partial override: the merged resolution stays
                // unsupported and the whole settings object gets discarded,
                // silently dropping e.g. an fps-only request.
                VideoSettings defaults = VideoSettings.getDefault();
                if (serviceManager != null && serviceManager.getAsgSettings() != null) {
                    VideoSettings saved = serviceManager.getAsgSettings().getButtonVideoSettings();
                    if (saved != null && saved.isValid()) {
                        defaults = saved;
                    } else {
                        Log.w(
                                TAG,
                                "Saved button-video defaults invalid ("
                                        + saved
                                        + "), falling back to "
                                        + defaults);
                    }
                }

                int width = settings.optInt("width", 0);
                int height = settings.optInt("height", 0);
                int fps = settings.optInt("fps", 0);
                if (width <= 0) width = defaults.width;
                if (height <= 0) height = defaults.height;
                if (fps <= 0) fps = defaults.fps;

                VideoSettings candidate = new VideoSettings(width, height, fps);
                // If the only problem is an explicitly requested unsupported
                // resolution, snap back to the (valid) default resolution while
                // keeping the requested frame rate, so the fps override is still
                // honored (CameraOpener also falls back to 1080p at capture time).
                if (!candidate.isValid() && !VideoSettings.isSupported(width, height)) {
                    candidate = new VideoSettings(defaults.width, defaults.height, fps);
                }
                if (candidate.isValid()) {
                    videoSettings = candidate;
                    Log.d(
                            TAG,
                            "Using video settings (merged over saved defaults): " + videoSettings);
                } else {
                    Log.w(TAG, "Invalid video settings after merge, using defaults: " + candidate);
                }
            }

            // Start recording with settings
            boolean save = data.optBoolean("save", false);
            // Capture light is mandatory for privacy; ignore any caller-supplied flash value.
            boolean flash = true;
            boolean sound = data.optBoolean("sound", true);
            // Optional auto-stop after N minutes; 0 (the default) means record until
            // stopped or interrupted (battery/storage/thermal/error). Validate like the
            // nearby numeric settings (width/height/fps): a negative value is meaningless
            // (treated as "no limit") and an out-of-range value is capped, so the downstream
            // `minutes * 60 * 1000L` timer math can't overflow to a negative duration.
            int maxRecordingTimeMinutes = data.optInt("maxRecordingTimeMinutes", 0);
            if (maxRecordingTimeMinutes < 0) {
                Log.w(
                        TAG,
                        "Ignoring negative maxRecordingTimeMinutes ("
                                + maxRecordingTimeMinutes
                                + "), recording until stopped");
                maxRecordingTimeMinutes = 0;
            } else if (maxRecordingTimeMinutes > MAX_RECORDING_TIME_MINUTES) {
                Log.w(
                        TAG,
                        "Clamping maxRecordingTimeMinutes "
                                + maxRecordingTimeMinutes
                                + " to cap "
                                + MAX_RECORDING_TIME_MINUTES);
                maxRecordingTimeMinutes = MAX_RECORDING_TIME_MINUTES;
            }

            boolean accepted =
                    captureService.handleStartVideoCommand(
                            requestId, save, videoSettings, flash, sound, maxRecordingTimeMinutes);
            if (!accepted) {
                logCommandResult("start_video_recording", false, "Already recording video");
                streamingManager.sendVideoRecordingStatusResponse(
                        requestId, false, "already_recording", "Already recording video");
                return false;
            }

            logCommandResult("start_video_recording", true, null);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling start video recording command", e);
            logCommandResult("start_video_recording", false, "Exception: " + e.getMessage());
            String requestId = data.optString("requestId", "");
            streamingManager.sendVideoRecordingStatusResponse(
                    requestId, false, "error", e.getMessage());
            return false;
        }
    }

    /** Handle stop video recording command */
    public boolean handleStopCommand(JSONObject data) {
        // Do not log the full payload: a stop command may carry an upload `authToken`.
        Log.d(
                TAG,
                "handleStopCommand called with requestId: "
                        + (data != null ? data.optString("requestId", "") : ""));

        try {
            String requestId = data != null ? data.optString("requestId", "") : "";
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                Log.e(TAG, "Media capture service is not initialized");
                streamingManager.sendVideoRecordingStatusResponse(
                        requestId, false, "service_unavailable", null);
                return false;
            }

            if (!captureService.isRecordingVideo()) {
                Log.d(TAG, "Not currently recording, ignoring stop command");
                streamingManager.sendVideoRecordingStatusResponse(
                        requestId, false, "not_recording", null);
                return false;
            }

            // Optional upload target supplied at STOP (not start) so the auth token is still
            // fresh when the upload actually runs — a recording can last arbitrarily long.
            // Empty webhook = no upload (video stays on device).
            String webhookUrl = data != null ? data.optString("webhookUrl", "") : "";
            String authToken = data != null ? data.optString("authToken", "") : "";

            // If requestId provided, use handleStopVideoCommand for validation
            // Otherwise use direct stopVideoRecording for backward compatibility
            if (requestId != null && !requestId.isEmpty()) {
                Log.d(TAG, "Stopping video with requestId validation: " + requestId);
                captureService.handleStopVideoCommand(requestId, webhookUrl, authToken);
            } else {
                Log.d(TAG, "Stopping video without requestId (backward compatibility mode)");
                captureService.stopVideoRecording(webhookUrl, authToken);
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling stop video command", e);
            String requestId = data != null ? data.optString("requestId", "") : "";
            streamingManager.sendVideoRecordingStatusResponse(
                    requestId, false, "error", e.getMessage());
            return false;
        }
    }

    /** Handle get video recording status command */
    public boolean handleStatusCommand(JSONObject data) {
        try {
            String requestId = data != null ? data.optString("requestId", "") : "";
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                Log.e(TAG, "Media capture service is not initialized");
                streamingManager.sendVideoRecordingStatusResponse(
                        requestId, false, "service_unavailable", null);
                return false;
            }

            boolean isRecording = captureService.isRecordingVideo();
            try {
                JSONObject status = new JSONObject();
                status.put("status", "recording_status");
                status.put("recording", isRecording);

                if (isRecording) {
                    long durationMs = captureService.getRecordingDurationMs();
                    status.put("duration_ms", durationMs);
                    status.put("duration_formatted", formatDuration(durationMs));
                }

                streamingManager.sendVideoRecordingStatusResponse(requestId, true, status);
                return true;
            } catch (JSONException e) {
                Log.e(TAG, "Error creating video recording status response", e);
                streamingManager.sendVideoRecordingStatusResponse(
                        requestId, false, "json_error", e.getMessage());
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling video status command", e);
            String requestId = data != null ? data.optString("requestId", "") : "";
            streamingManager.sendVideoRecordingStatusResponse(
                    requestId, false, "error", e.getMessage());
            return false;
        }
    }

    private String formatDuration(long durationMs) {
        long seconds = durationMs / 1000;
        long minutes = seconds / 60;
        seconds = seconds % 60;
        return String.format(Locale.US, "%02d:%02d", minutes, seconds);
    }
}
