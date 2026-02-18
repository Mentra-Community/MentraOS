package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Set;
import android.os.Handler;
import android.os.Looper;

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
    
    // Retry configuration for ota_start when OtaHelper not yet initialized
    private static final int OTA_START_MAX_RETRIES = 4;
    private static final long OTA_START_RETRY_DELAY_MS = 2000; // 2 seconds between retries
    private static int otaStartRetryCount = 0;
    private static final Handler retryHandler = new Handler(Looper.getMainLooper());

    // Reference to OtaHelper for triggering OTA updates
    private static OtaHelper otaHelperInstance;
    
    // Reference to CommunicationManager for sending error messages
    private static ICommunicationManager communicationManager;

    public OtaCommandHandler() {
        // No dependencies needed in constructor - dependencies set via static methods
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
    
    /**
     * Set the CommunicationManager for sending error messages to phone.
     * Called during service initialization.
     * @param manager The CommunicationManager instance
     */
    public static void setCommunicationManager(ICommunicationManager manager) {
        communicationManager = manager;
        Log.i(TAG, "CommunicationManager set for OTA error reporting");
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
     * 
     * If OtaHelper isn't initialized yet (can happen right after APK install),
     * retries with a delay until OtaHelper is ready.
     */
    private boolean handleOtaStart(JSONObject data) {
        Log.i(TAG, "📱 Received ota_start command from phone");

        if (otaHelperInstance == null) {
            // OtaHelper not ready yet - this can happen right after APK install
            // Schedule a retry instead of failing immediately
            if (otaStartRetryCount < OTA_START_MAX_RETRIES) {
                otaStartRetryCount++;
                Log.w(TAG, "📱 OtaHelper not ready - scheduling retry " + otaStartRetryCount + "/" + OTA_START_MAX_RETRIES);
                retryHandler.postDelayed(() -> {
                    handleOtaStart(data);
                }, OTA_START_RETRY_DELAY_MS);
                return true; // Return true to indicate we're handling it (async)
            } else {
                Log.e(TAG, "OtaHelper not initialized after " + OTA_START_MAX_RETRIES + " retries - cannot start phone-controlled OTA");
                otaStartRetryCount = 0; // Reset for next attempt
                // Send error to phone so user sees proper error message
                sendOtaError("OTA service failed to initialize. Please restart glasses and try again.");
                return false;
            }
        }

        // Reset retry counter on success
        otaStartRetryCount = 0;
        
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
    
    /**
     * Send OTA error message to phone.
     * Creates an ota_progress message with FAILED status.
     * @param errorMessage Human-readable error message for user
     */
    private void sendOtaError(String errorMessage) {
        if (communicationManager == null) {
            Log.e(TAG, "Cannot send OTA error - CommunicationManager not set");
            return;
        }
        
        try {
            JSONObject progress = new JSONObject();
            progress.put("type", "ota_progress");
            progress.put("stage", "download");
            progress.put("status", "FAILED");
            progress.put("progress", 0);
            progress.put("bytes_downloaded", 0);
            progress.put("total_bytes", 0);
            progress.put("current_update", "apk");
            progress.put("error_message", errorMessage);
            
            communicationManager.sendOtaProgress(progress);
            Log.i(TAG, "📱 Sent OTA error to phone: " + errorMessage);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating OTA error message", e);
        }
    }
} 