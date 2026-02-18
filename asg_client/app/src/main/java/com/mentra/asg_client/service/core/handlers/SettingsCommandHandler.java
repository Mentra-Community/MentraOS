package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.settings.VideoSettings;
import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for settings-related commands.
 * Follows Single Responsibility Principle by handling only settings commands.
 */
public class SettingsCommandHandler implements ICommandHandler {
    private static final String TAG = "SettingsCommandHandler";
    
    private final AsgClientServiceManager serviceManager;
    private final ICommunicationManager communicationManager;
    private final IResponseBuilder responseBuilder;

    public SettingsCommandHandler(AsgClientServiceManager serviceManager,
                                ICommunicationManager communicationManager,
                                IResponseBuilder responseBuilder) {
        this.serviceManager = serviceManager;
        this.communicationManager = communicationManager;
        this.responseBuilder = responseBuilder;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("set_photo_mode", "button_video_recording_setting",
                      "button_max_recording_time", "button_photo_setting", "button_camera_led", "button_mode_setting");
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
                default:
                    Log.e(TAG, "Unsupported settings command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling settings command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle set photo mode command
     */
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

    /**
     * Handle button video recording setting command
     */
    public boolean handleButtonVideoRecordingSetting(JSONObject data) {
        try {
            JSONObject params = data.optJSONObject("params");
            if (params == null) {
                Log.e(TAG, "Missing settings object in button_video_recording_setting");
                return false;
            }
            
            int width = params.optInt("width", 1280);
            int height = params.optInt("height", 720);
            int fps = params.optInt("fps", 30);
            
            Log.d(TAG, "[VIDEO_SYNC] 📱 Received button video recording settings from phone: " + width + "x" + height + "@" + fps + "fps");
            
            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                VideoSettings videoSettings = new VideoSettings(width, height, fps);
                if (videoSettings.isValid()) {
                    asgSettings.setButtonVideoSettings(videoSettings);
                    Log.d(TAG, "[VIDEO_SYNC] ✅ Video settings saved to SharedPreferences: " + width + "x" + height + "@" + fps + "fps");
                    return true;
                } else {
                    Log.e(TAG, "[VIDEO_SYNC] Invalid video settings: " + videoSettings);
                    return false;
                }
            } else {
                Log.e(TAG, "[VIDEO_SYNC] Settings not available");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "[VIDEO_SYNC] Error handling button video recording setting", e);
            return false;
        }
    }
    
    /**
     * Handle button max recording time setting command
     */
    public boolean handleButtonMaxRecordingTime(JSONObject data) {
        try {
            int minutes = data.optInt("minutes", 10);

            Log.d(TAG, "📱 Received button max recording time setting: " + minutes + " minutes");

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                asgSettings.setButtonMaxRecordingTimeMinutes(minutes);
                Log.d(TAG, "✅ Button max recording time saved: " + minutes + " minutes");
                return true;
            } else {
                Log.e(TAG, "Settings not available");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling button max recording time setting", e);
            return false;
        }
    }

    /**
     * Handle button photo setting command
     */
    public boolean handleButtonPhotoSetting(JSONObject data) {
        try {
            String size = data.optString("size", "medium");
            
            Log.d(TAG, "📱 Received button photo setting: " + size);
            
            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                asgSettings.setButtonPhotoSize(size);
                Log.d(TAG, "✅ Button photo size saved: " + size);
                return true;
            } else {
                Log.e(TAG, "Settings not available");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling button photo setting", e);
            return false;
        }
    }
    
    /**
     * Handle button camera LED setting command
     */
    public boolean handleButtonCameraLedSetting(JSONObject data) {
        try {
            boolean enabled = data.optBoolean("enabled", true);
            
            Log.d(TAG, "📱 Received button camera LED setting: " + enabled);
            
            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                asgSettings.setButtonCameraLedEnabled(enabled);
                Log.d(TAG, "✅ Button camera LED setting saved: " + enabled);
                return true;
            } else {
                Log.e(TAG, "Settings not available");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling button camera LED setting", e);
            return false;
        }
    }
    
    /**
     * Handle button mode setting command
     * This command allows configuring general button behavior settings
     */
    public boolean handleButtonModeSetting(JSONObject data) {
        try {
            String mode = data.optString("mode", "normal");
            
            Log.d(TAG, "📱 Received button mode setting: " + mode);
            
            // For now, we'll just log the setting since AsgSettings doesn't have a specific
            // button mode field. This can be extended later if needed.
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