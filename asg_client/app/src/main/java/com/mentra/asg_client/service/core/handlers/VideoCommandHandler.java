package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.camera.CameraNeo;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.settings.VideoSettings;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.Set;

/**
 * Handler for video recording commands.
 * Follows Single Responsibility Principle by handling only video commands.
 * Extends BaseMediaCommandHandler for common package directory management.
 */
public class VideoCommandHandler extends BaseMediaCommandHandler {
    private static final String TAG = "VideoCommandHandler";

    private final AsgClientServiceManager serviceManager;
    private final IMediaManager streamingManager;
    private final IStateManager stateManager;

    public VideoCommandHandler(Context context, AsgClientServiceManager serviceManager, IMediaManager streamingManager, FileManager fileManager, IStateManager stateManager) {
        super(context, fileManager);
        this.serviceManager = serviceManager;
        this.streamingManager = streamingManager;
        this.stateManager = stateManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("start_video_recording", "stop_video_recording", "get_video_recording_status",
                      "start_buffer_recording", "stop_buffer_recording", "save_buffer_video");
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
                    return handleStatusCommand();
                case "start_buffer_recording":
                    return handleStartBufferRecording(data);
                case "stop_buffer_recording":
                    return handleStopBufferRecording(data);
                case "save_buffer_video":
                    return handleSaveBufferVideo(data);
                default:
                    Log.e(TAG, "Unsupported video command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling video command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle start video recording command
     */
    private boolean handleStartVideoRecording(JSONObject data) {
        try {
            // Resolve package name using base class functionality
            String packageName = resolvePackageName(data);
            logCommandStart("start_video_recording", packageName);

            // Validate requestId using base class functionality
            if (!validateRequestId(data)) {
                streamingManager.sendVideoRecordingStatusResponse(false, "missing_request_id", null);
                return false;
            }

            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                logCommandResult("start_video_recording", false, "Media capture service is not initialized");
                streamingManager.sendVideoRecordingStatusResponse(false, "service_unavailable", null);
                return false;
            }

            // BATTERY CHECK: Reject if battery too low
            if (stateManager != null) {
                int batteryLevel = stateManager.getBatteryLevel();
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(TAG, "🚫 Video recording rejected - battery too low (" + batteryLevel + "%)");
                    logCommandResult("start_video_recording", false, "Battery too low: " + batteryLevel + "%");

                    // Play audio feedback
                    captureService.playBatteryLowSound();

                    // Send error response to phone
                    streamingManager.sendVideoRecordingStatusResponse(false, "battery_low",
                        "Battery level too low (" + batteryLevel + "%) - minimum " +
                        BatteryConstants.MIN_BATTERY_LEVEL + "% required");

                    return false;
                }
            } else {
                Log.w(TAG, "⚠️ StateManager not available - skipping battery check");
            }

            if (captureService.isRecordingVideo()) {
                logCommandResult("start_video_recording", true, "Already recording video");
                streamingManager.sendVideoRecordingStatusResponse(true, "already_recording", null);
                return true;
            }

            // Parse video settings if provided
            VideoSettings videoSettings = null;
            JSONObject settings = data.optJSONObject("settings");
            if (settings != null) {
                int width = settings.optInt("width", 0);
                int height = settings.optInt("height", 0);
                int fps = settings.optInt("fps", 30);
                
                if (width > 0 && height > 0) {
                    videoSettings = new VideoSettings(width, height, fps);
                    if (!videoSettings.isValid()) {
                        Log.w(TAG, "Invalid video settings provided, using defaults: " + videoSettings);
                        videoSettings = null;
                    } else {
                        Log.d(TAG, "Using custom video settings: " + videoSettings);
                    }
                }
            }

            // Start recording with settings
            boolean save = data.optBoolean("save", false);
            // silent: true = no sound/LED, false (default) = normal behavior with sound/LED
            boolean silent = data.optBoolean("silent", false);
            boolean enableLed = !silent; // Convert to internal enableLed (inverted logic)
            String requestId = data.optString("requestId", "video_" + System.currentTimeMillis());
            
            if (videoSettings != null) {
                captureService.handleStartVideoCommand(requestId, save, videoSettings, enableLed);
            } else {
                captureService.handleStartVideoCommand(requestId, save, enableLed); // Use default settings
            }
            
            logCommandResult("start_video_recording", true, null);
            streamingManager.sendVideoRecordingStatusResponse(true, "recording_started", null);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling start video recording command", e);
            logCommandResult("start_video_recording", false, "Exception: " + e.getMessage());
            streamingManager.sendVideoRecordingStatusResponse(false, "error", e.getMessage());
            return false;
        }
    }

    /**
     * Handle stop video recording command
     */
    public boolean handleStopCommand(JSONObject data) {
        Log.d(TAG, "handleStopCommand called with data: " + data);

        try {
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                Log.e(TAG, "Media capture service is not initialized");
                streamingManager.sendVideoRecordingStatusResponse(false, "service_unavailable", null);
                return false;
            }

            if (!captureService.isRecordingVideo()) {
                Log.d(TAG, "Not currently recording, ignoring stop command");
                streamingManager.sendVideoRecordingStatusResponse(false, "not_recording", null);
                return false;
            }

            // Extract requestId from command data if provided
            String requestId = null;
            if (data != null) {
                requestId = data.optString("requestId", null);
            }
            
            // If requestId provided, use handleStopVideoCommand for validation
            // Otherwise use direct stopVideoRecording for backward compatibility
            if (requestId != null && !requestId.isEmpty()) {
                Log.d(TAG, "Stopping video with requestId validation: " + requestId);
                captureService.handleStopVideoCommand(requestId);
            } else {
                Log.d(TAG, "Stopping video without requestId (backward compatibility mode)");
                captureService.stopVideoRecording();
            }
            
            streamingManager.sendVideoRecordingStatusResponse(true, "recording_stopped", null);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling stop video command", e);
            streamingManager.sendVideoRecordingStatusResponse(false, "error", e.getMessage());
            return false;
        }
    }

    /**
     * Handle get video recording status command
     */
    public boolean handleStatusCommand() {
        try {
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                Log.e(TAG, "Media capture service is not initialized");
                streamingManager.sendVideoRecordingStatusResponse(false, "service_unavailable", null);
                return false;
            }

            boolean isRecording = captureService.isRecordingVideo();
            try {
                JSONObject status = new JSONObject();
                status.put("recording", isRecording);

                if (isRecording) {
                    long durationMs = captureService.getRecordingDurationMs();
                    status.put("duration_ms", durationMs);
                    status.put("duration_formatted", formatDuration(durationMs));
                }

                streamingManager.sendVideoRecordingStatusResponse(true, status);
                return true;
            } catch (JSONException e) {
                Log.e(TAG, "Error creating video recording status response", e);
                streamingManager.sendVideoRecordingStatusResponse(false, "json_error", e.getMessage());
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling video status command", e);
            streamingManager.sendVideoRecordingStatusResponse(false, "error", e.getMessage());
            return false;
        }
    }

    private String formatDuration(long durationMs) {
        long seconds = durationMs / 1000;
        long minutes = seconds / 60;
        seconds = seconds % 60;
        return String.format(Locale.US, "%02d:%02d", minutes, seconds);
    }
    
    /**
     * Handle start buffer recording command
     */
    private boolean handleStartBufferRecording(JSONObject data) {
        try {
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                Log.e(TAG, "Media capture service is not initialized");
                streamingManager.sendBufferStatusResponse(false, "service_unavailable", null);
                return false;
            }
            
            // Check if camera is already in use
            if (CameraNeo.isCameraInUse()) {
                Log.d(TAG, "Camera already in use, cannot start buffer recording");
                streamingManager.sendBufferStatusResponse(false, "camera_busy", null);
                return false;
            }
            
            // Close kept-alive camera if it exists to free resources for buffer recording
            CameraNeo.closeKeptAliveCamera();
            
            Log.d(TAG, "Starting buffer recording");
            captureService.startBufferRecording();
            streamingManager.sendBufferStatusResponse(true, "buffer_started", null);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling start buffer command", e);
            streamingManager.sendBufferStatusResponse(false, "error", e.getMessage());
            return false;
        }
    }
    
    /**
     * Handle stop buffer recording command
     */
    private boolean handleStopBufferRecording(JSONObject data) {
        try {
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                Log.e(TAG, "Media capture service is not initialized");
                streamingManager.sendBufferStatusResponse(false, "service_unavailable", null);
                return false;
            }
            
            Log.d(TAG, "Stopping buffer recording");
            captureService.stopBufferRecording();
            streamingManager.sendBufferStatusResponse(true, "buffer_stopped", null);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling stop buffer command", e);
            streamingManager.sendBufferStatusResponse(false, "error", e.getMessage());
            return false;
        }
    }
    
    /**
     * Handle save buffer video command
     */
    private boolean handleSaveBufferVideo(JSONObject data) {
        try {
            String bufferRequestId = data.optString("requestId", "");
            int secondsToSave = data.optInt("duration", 30); // Default to 30 seconds
            
            if (bufferRequestId.isEmpty()) {
                Log.e(TAG, "Cannot save buffer - missing requestId");
                streamingManager.sendBufferStatusResponse(false, "missing_request_id", null);
                return false;
            }
            
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                Log.e(TAG, "Media capture service is not initialized");
                streamingManager.sendBufferStatusResponse(false, "service_unavailable", null);
                return false;
            }
            
            if (!captureService.isBuffering()) {
                Log.e(TAG, "Cannot save buffer - not currently buffering");
                streamingManager.sendBufferStatusResponse(false, "not_buffering", null);
                return false;
            }
            
            Log.d(TAG, "Saving last " + secondsToSave + " seconds of buffer, requestId: " + bufferRequestId);
            captureService.saveBufferVideo(secondsToSave, bufferRequestId);
            streamingManager.sendBufferStatusResponse(true, "buffer_saving", null);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling save buffer command", e);
            streamingManager.sendBufferStatusResponse(false, "error", e.getMessage());
            return false;
        }
    }
} 