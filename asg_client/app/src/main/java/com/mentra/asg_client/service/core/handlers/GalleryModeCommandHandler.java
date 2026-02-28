package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

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

    public GalleryModeCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
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
            
            if (serviceManager != null && serviceManager.getAsgSettings() != null) {
                serviceManager.getAsgSettings().setSaveInGalleryMode(active);
                Log.i(TAG, "📸 Gallery mode state updated: " + (active ? "ACTIVE" : "INACTIVE") + 
                          " - Button captures " + (active ? "ENABLED" : "DISABLED"));
                return true;
            } else {
                Log.e(TAG, "Service manager or settings not available");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error processing gallery mode state", e);
            return false;
        }
    }
}

