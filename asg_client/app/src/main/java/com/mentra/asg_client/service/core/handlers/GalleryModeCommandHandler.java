package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for gallery mode state commands from the phone.
 * Follows Single Responsibility Principle by handling only gallery mode state updates.
 * 
 * This handler processes messages from the mobile app indicating whether
 * the gallery/camera view is currently active, which determines if button
 * presses should trigger local photo/video capture.
 */
public class GalleryModeCommandHandler implements ICommandHandler {
    private static final String TAG = "GalleryModeCommandHandler";
    
    private final AsgClientServiceManager serviceManager;
    private final ICommunicationManager communicationManager;

    public GalleryModeCommandHandler(
            AsgClientServiceManager serviceManager,
            ICommunicationManager communicationManager) {
        this.serviceManager = serviceManager;
        this.communicationManager = communicationManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("save_in_gallery_mode");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "save_in_gallery_mode":
                    return handleGalleryModeState(data);
                default:
                    Log.w(TAG, "Unsupported command type: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling gallery mode command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle gallery mode state update from phone
     * @param data JSON data containing 'active' boolean field
     * @return true if handled successfully
     */
    private boolean handleGalleryModeState(JSONObject data) {
        try {
            boolean active = data.optBoolean("active", false);
            String requestId = getRequestId(data);
            
            if (serviceManager != null && serviceManager.getAsgSettings() != null) {
                serviceManager.getAsgSettings().setSaveInGalleryMode(active);
                Log.i(TAG, "📸 Gallery mode state updated: " + (active ? "ACTIVE" : "INACTIVE") + 
                          " - Button captures " + (active ? "ENABLED" : "DISABLED"));
                sendSettingsAck(requestId, active);
                return true;
            } else {
                Log.e(TAG, "Service manager or settings not available");
                sendSettingsError(requestId, "settings_unavailable", "Settings are not available.");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error processing gallery mode state", e);
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

    private void sendSettingsAck(String requestId, boolean active) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            JSONObject ack = new JSONObject();
            ack.put("type", "settings_ack");
            ack.put("request_id", requestId);
            ack.put("setting", "gallery_mode");
            ack.put("status", "applied");
            ack.put("active", active);
            ack.put("ready", true);
            ack.put("timestamp", System.currentTimeMillis());
            communicationManager.sendBluetoothResponse(ack);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send gallery mode settings ack", e);
        }
    }

    private void sendSettingsError(String requestId, String errorCode, String errorMessage) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            JSONObject ack = new JSONObject();
            ack.put("type", "settings_ack");
            ack.put("request_id", requestId);
            ack.put("setting", "gallery_mode");
            ack.put("status", "error");
            ack.put("ready", false);
            ack.put("error_code", errorCode);
            ack.put("error_message", errorMessage);
            ack.put("timestamp", System.currentTimeMillis());
            communicationManager.sendBluetoothResponse(ack);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send gallery mode settings error", e);
        }
    }
}
