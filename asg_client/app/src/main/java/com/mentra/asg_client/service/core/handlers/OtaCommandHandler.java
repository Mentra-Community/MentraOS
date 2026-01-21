package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for OTA-related commands from the phone.
 * Follows Single Responsibility Principle by handling only OTA commands.
 *
 * Supported commands:
 * - ota_start: Phone approved update, start download+install
 * - ota_update_response: Legacy command (deprecated, kept for backwards compatibility)
 */
public class OtaCommandHandler implements ICommandHandler {
    private static final String TAG = "OtaCommandHandler";

    // Reference to OtaHelper for triggering OTA updates
    private static OtaHelper otaHelperInstance;

    public OtaCommandHandler() {
        // No dependencies needed in constructor - OtaHelper set via static method
    }

    /**
     * Set the OtaHelper instance for phone-controlled OTA.
     * Called during service initialization.
     * @param helper The OtaHelper instance
     */
    public static void setOtaHelper(OtaHelper helper) {
        otaHelperInstance = helper;
        Log.i(TAG, "OtaHelper instance set for phone-controlled OTA");
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("ota_start", "ota_update_response");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "ota_start":
                    return handleOtaStart(data);
                case "ota_update_response":
                    return handleOtaUpdateResponse(data);
                default:
                    Log.e(TAG, "Unsupported OTA command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling OTA command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle ota_start command from phone.
     * User approved the update (onboarding or background mode).
     * Triggers OtaHelper.startOtaFromPhone() to begin download+install.
     */
    private boolean handleOtaStart(JSONObject data) {
        Log.i(TAG, "📱 Received ota_start command from phone");

        if (otaHelperInstance == null) {
            Log.e(TAG, "OtaHelper not initialized - cannot start phone-controlled OTA");
            return false;
        }

        // Start OTA from phone request
        otaHelperInstance.startOtaFromPhone();
        Log.i(TAG, "📱 OTA started from phone command");
        return true;
    }

    /**
     * Handle OTA update response command (legacy, deprecated)
     * Kept for backwards compatibility with older phone app versions.
     */
    private boolean handleOtaUpdateResponse(JSONObject data) {
        try {
            boolean accepted = data.optBoolean("accepted", false);
            if (accepted) {
                Log.d(TAG, "Received ota_update_response: accepted (legacy command)");
                // Delegate to new handler
                return handleOtaStart(data);
            } else {
                Log.d(TAG, "Received ota_update_response: rejected by user");
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling OTA update response", e);
            return false;
        }
    }
} 