package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.dev.api.DevApi;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.core.CameraRestartCooldown;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.settings.VideoSettings;
import java.util.Set;
import org.json.JSONObject;

/**
 * Handler for settings-related commands. Follows Single Responsibility Principle by handling only
 * settings commands.
 */
public class SettingsCommandHandler implements ICommandHandler {
    private static final String TAG = "SettingsCommandHandler";
    private static final String STATUS_APPLIED = "applied";
    private static final String STATUS_READY = "ready";
    private static final String STATUS_ERROR = "error";

    private final AsgClientServiceManager serviceManager;
    private final ICommunicationManager communicationManager;
    private final IResponseBuilder responseBuilder;

    public SettingsCommandHandler(
            AsgClientServiceManager serviceManager,
            ICommunicationManager communicationManager,
            IResponseBuilder responseBuilder) {
        this.serviceManager = serviceManager;
        this.communicationManager = communicationManager;
        this.responseBuilder = responseBuilder;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of(
                "set_photo_mode",
                "button_video_recording_setting",
                "button_max_recording_time",
                "button_photo_setting",
                "button_camera_led",
                "button_mode_setting",
                "camera_fov_setting");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "set_photo_mode":
                    return handleSetPhotoMode(data);
                case "button_video_recording_setting":
                    return handleButtonVideoRecordingSetting(data);
                case "button_max_recording_time":
                    return handleButtonMaxRecordingTime(data);
                case "button_photo_setting":
                    return handleButtonPhotoSetting(data);
                case "button_camera_led":
                    return handleButtonCameraLedSetting(data);
                case "button_mode_setting":
                    return handleButtonModeSetting(data);
                case "camera_fov_setting":
                    return handleCameraFovSetting(data);
                default:
                    Log.e(TAG, "Unsupported settings command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling settings command: " + commandType, e);
            return false;
        }
    }

    /** Handle set photo mode command */
    private boolean handleSetPhotoMode(JSONObject data) {
        try {
            String mode = data.optString("mode", "save_locally");
            JSONObject ack = responseBuilder.buildPhotoModeAckResponse(mode);
            communicationManager.sendBluetoothResponse(ack);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling photo mode command", e);
            return false;
        }
    }

    /** Handle button video recording setting command */
    public boolean handleButtonVideoRecordingSetting(JSONObject data) {
        try {
            String requestId = getRequestId(data);
            JSONObject params = data.optJSONObject("params");
            if (params == null) {
                Log.e(TAG, "Missing settings object in button_video_recording_setting");
                sendSettingsError(requestId, "button_video_recording", "missing_params", "Missing video settings.");
                return false;
            }

            int width = params.optInt("width", 1280);
            int height = params.optInt("height", 720);
            int fps = params.optInt("fps", 30);

            Log.d(
                    TAG,
                    "[VIDEO_SYNC] 📱 Received button video recording settings from phone: "
                            + width
                            + "x"
                            + height
                            + "@"
                            + fps
                            + "fps");

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                VideoSettings videoSettings = new VideoSettings(width, height, fps);
                if (videoSettings.isValid()) {
                    asgSettings.setButtonVideoSettings(videoSettings);
                    Log.d(
                            TAG,
                            "[VIDEO_SYNC] ✅ Video settings saved to SharedPreferences: "
                                    + width
                                    + "x"
                                    + height
                                    + "@"
                                    + fps
                                    + "fps");
                    JSONObject values = new JSONObject();
                    values.put("width", width);
                    values.put("height", height);
                    values.put("fps", fps);
                    sendSettingsAck(requestId, "button_video_recording", STATUS_APPLIED, values);
                    return true;
                } else {
                    Log.e(TAG, "[VIDEO_SYNC] Invalid video settings: " + videoSettings);
                    sendSettingsError(
                            requestId,
                            "button_video_recording",
                            "invalid_settings",
                            "Invalid video settings.");
                    return false;
                }
            } else {
                Log.e(TAG, "[VIDEO_SYNC] Settings not available");
                sendSettingsError(
                        requestId,
                        "button_video_recording",
                        "settings_unavailable",
                        "Settings are not available.");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "[VIDEO_SYNC] Error handling button video recording setting", e);
            return false;
        }
    }

    /** Handle button max recording time setting command */
    public boolean handleButtonMaxRecordingTime(JSONObject data) {
        try {
            String requestId = getRequestId(data);
            int minutes = data.optInt("minutes", 10);

            Log.d(TAG, "📱 Received button max recording time setting: " + minutes + " minutes");

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                asgSettings.setButtonMaxRecordingTimeMinutes(minutes);
                Log.d(TAG, "✅ Button max recording time saved: " + minutes + " minutes");
                JSONObject values = new JSONObject();
                values.put("minutes", minutes);
                sendSettingsAck(requestId, "button_max_recording_time", STATUS_APPLIED, values);
                return true;
            } else {
                Log.e(TAG, "Settings not available");
                sendSettingsError(
                        requestId,
                        "button_max_recording_time",
                        "settings_unavailable",
                        "Settings are not available.");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling button max recording time setting", e);
            return false;
        }
    }

    /** Handle button photo setting command */
    public boolean handleButtonPhotoSetting(JSONObject data) {
        try {
            String requestId = getRequestId(data);
            String size = data.optString("size", "medium");

            Log.d(TAG, "📱 Received button photo setting: " + size);

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                asgSettings.setButtonPhotoSize(size);
                Log.d(TAG, "✅ Button photo size saved: " + size);
                JSONObject values = new JSONObject();
                values.put("size", size);
                sendSettingsAck(requestId, "button_photo", STATUS_APPLIED, values);
                return true;
            } else {
                Log.e(TAG, "Settings not available");
                sendSettingsError(
                        requestId,
                        "button_photo",
                        "settings_unavailable",
                        "Settings are not available.");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling button photo setting", e);
            return false;
        }
    }

    /** Handle button camera LED setting command */
    public boolean handleButtonCameraLedSetting(JSONObject data) {
        try {
            String requestId = getRequestId(data);
            boolean enabled = data.optBoolean("enabled", true);

            Log.d(TAG, "📱 Received button camera LED setting: " + enabled);

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                asgSettings.setButtonCameraLedEnabled(enabled);
                Log.d(TAG, "✅ Button camera LED setting saved: " + enabled);
                JSONObject values = new JSONObject();
                values.put("enabled", enabled);
                sendSettingsAck(requestId, "button_camera_led", STATUS_APPLIED, values);
                return true;
            } else {
                Log.e(TAG, "Settings not available");
                sendSettingsError(
                        requestId,
                        "button_camera_led",
                        "settings_unavailable",
                        "Settings are not available.");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling button camera LED setting", e);
            return false;
        }
    }

    /**
     * Handle camera FOV setting command (K900). Persists FOV and ROI, applies to hardware, restarts
     * camera HAL.
     */
    private boolean handleCameraFovSetting(JSONObject data) {
        try {
            String requestId = getRequestId(data);
            JSONObject params = data.optJSONObject("params");
            if (params == null) {
                Log.e(TAG, "Missing params in camera_fov_setting");
                sendSettingsError(requestId, "camera_fov", "missing_params", "Missing camera FOV params.");
                return false;
            }
            int fov = params.optInt("fov", 118);
            int roiPosition = params.optInt("roi_position", 0);

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings == null) {
                Log.e(TAG, "Settings not available for camera_fov_setting");
                sendSettingsError(
                        requestId,
                        "camera_fov",
                        "settings_unavailable",
                        "Settings are not available.");
                return false;
            }
            asgSettings.setCameraFov(fov, roiPosition);

            // Re-read sanitized values — setCameraFov clamps invalid FOV/ROI before persisting
            fov = asgSettings.getCameraFov();
            roiPosition = asgSettings.getCameraRoiPosition();
            Log.d(TAG, "Camera FOV saved: fov=" + fov + ", roi_position=" + roiPosition);

            Context context = serviceManager.getContext();
            if (context == null) {
                Log.w(TAG, "Context not available, FOV persisted but not applied to hardware");
                JSONObject values = new JSONObject();
                values.put("fov", fov);
                values.put("roi_position", roiPosition);
                values.put("ready", false);
                values.put("hardware_applied", false);
                sendSettingsAck(requestId, "camera_fov", STATUS_APPLIED, values);
                return true;
            }
            try {
                DevApi.setCameraFov(fov, roiPosition);
                SystemControllerFactory.get(context).restartCameraHal();
                CameraRestartCooldown.setCooldown();
                Log.d(TAG, "Camera FOV applied to hardware and HAL restarted");
                sendCameraFovReadyAck(requestId, fov, roiPosition);
            } catch (UnsatisfiedLinkError e) {
                Log.w(TAG, "libxydev not available (non-K900?), FOV persisted but not applied", e);
                JSONObject values = new JSONObject();
                values.put("fov", fov);
                values.put("roi_position", roiPosition);
                values.put("ready", false);
                values.put("hardware_applied", false);
                sendSettingsAck(requestId, "camera_fov", STATUS_APPLIED, values);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling camera_fov_setting", e);
            return false;
        }
    }

    private String getRequestId(JSONObject data) {
        String requestId = data.optString("requestId", "");
        if (requestId == null || requestId.isEmpty()) {
            requestId = data.optString("request_id", "");
        }
        return requestId == null ? "" : requestId;
    }

    private void sendCameraFovReadyAck(String requestId, int fov, int roiPosition) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        new Handler(Looper.getMainLooper())
                .postDelayed(
                        () -> {
                            try {
                                JSONObject values = new JSONObject();
                                values.put("fov", fov);
                                values.put("roi_position", roiPosition);
                                values.put("ready", true);
                                values.put("hardware_applied", true);
                                sendSettingsAck(requestId, "camera_fov", STATUS_READY, values);
                            } catch (Exception e) {
                                Log.e(TAG, "Failed to send delayed camera FOV ready ack", e);
                            }
                        },
                        CameraRestartCooldown.DEFAULT_COOLDOWN_DURATION_MS);
    }

    private void sendSettingsAck(String requestId, String setting, String status, JSONObject values) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            JSONObject ack = values == null ? new JSONObject() : values;
            ack.put("type", "settings_ack");
            ack.put("request_id", requestId);
            ack.put("setting", setting);
            ack.put("status", status);
            if (!ack.has("ready")) {
                ack.put("ready", !STATUS_ERROR.equals(status));
            }
            ack.put("timestamp", System.currentTimeMillis());
            communicationManager.sendBluetoothResponse(ack);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send settings ack for " + setting, e);
        }
    }

    private void sendSettingsError(
            String requestId, String setting, String errorCode, String errorMessage) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            JSONObject values = new JSONObject();
            values.put("ready", false);
            values.put("error_code", errorCode);
            values.put("error_message", errorMessage);
            sendSettingsAck(requestId, setting, STATUS_ERROR, values);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send settings error for " + setting, e);
        }
    }

    /**
     * Handle button mode setting command This command allows configuring general button behavior
     * settings
     */
    public boolean handleButtonModeSetting(JSONObject data) {
        try {
            String mode = data.optString("mode", "normal");

            Log.d(TAG, "📱 Received button mode setting: " + mode);

            // Deprecated/reserved command. Button capture behavior is controlled by
            // save_in_gallery_mode plus the photo/video capture settings.
            Log.d(TAG, "✅ Button mode setting received: " + mode);

            // Send acknowledgment response
            JSONObject ack = responseBuilder.buildPhotoModeAckResponse(mode);
            communicationManager.sendBluetoothResponse(ack);

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling button mode setting", e);
            return false;
        }
    }
}
