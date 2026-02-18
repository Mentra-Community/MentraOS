package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.core.constants.BatteryConstants;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for photo-related commands.
 * Follows Single Responsibility Principle by handling only photo commands.
 * Extends BaseMediaCommandHandler for common package directory management.
 */
public class PhotoCommandHandler extends BaseMediaCommandHandler {
    private static final String TAG = "PhotoCommandHandler";

    private final AsgClientServiceManager serviceManager;
    private final IStateManager stateManager;

    public PhotoCommandHandler(Context context, AsgClientServiceManager serviceManager, FileManager fileManager, IStateManager stateManager) {
        super(context, fileManager);
        this.serviceManager = serviceManager;
        this.stateManager = stateManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("take_photo");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "take_photo":
                    return handleTakePhoto(data);
                default:
                    Log.e(TAG, "Unsupported photo command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling photo command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle take photo command
     */
    private boolean handleTakePhoto(JSONObject data) {
        Log.d(TAG, "Handling take photo command with data: " + data.toString());
        try {
            // Resolve package name using base class functionality
            String packageName = resolvePackageName(data);
            logCommandStart("take_photo", packageName);

            // Validate requestId using base class functionality
            if (!validateRequestId(data)) {
                return false;
            }

            String requestId = data.optString("requestId", "");
            String webhookUrl = data.optString("webhookUrl", "");
            String authToken = data.optString("authToken", "");
            String transferMethod = data.optString("transferMethod", "direct");
            String bleImgId = data.optString("bleImgId", "");
            boolean save = data.optBoolean("save", false);
            String size = data.optString("size", "medium");
            String compress = data.optString("compress", "none"); // Default to none (no compression)
            // silent: true = no sound/LED, false (default) = normal behavior with sound/LED
            boolean silent = data.optBoolean("silent", false);
            boolean enableLed = !silent; // Convert to internal enableLed (inverted logic)

            // Generate file path using base class functionality
            String fileName = generateUniqueFilename("IMG_", ".jpg");
            String photoFilePath = generateFilePath(packageName, fileName);
            if (photoFilePath == null) {
                logCommandResult("take_photo", false, "Failed to generate file path");
                return false;
            }

            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                logCommandResult("take_photo", false, "Media capture service not available");
                return false;
            }

            // BATTERY CHECK: Reject if battery too low
            if (stateManager != null) {
                int batteryLevel = stateManager.getBatteryLevel();
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                    logCommandResult("take_photo", false, "Battery too low: " + batteryLevel + "%");

                    // Play audio feedback
                    captureService.playBatteryLowSound();

                    // Send error response to phone
                    captureService.sendPhotoErrorResponse(requestId, "BATTERY_LOW",
                        "Battery level too low (" + batteryLevel + "%) - minimum " +
                        BatteryConstants.MIN_BATTERY_LEVEL + "% required");

                    return false;
                }
            } else {
                Log.w(TAG, "⚠️ StateManager not available - skipping battery check");
            }

            // VIDEO RECORDING CHECK: Reject photo requests if video is currently recording
            if (captureService.isRecordingVideo()) {
                Log.w(TAG, "🚫 Photo request rejected - video recording in progress");
                logCommandResult("take_photo", false, "Video recording in progress - request rejected");
                // Send immediate error response to phone
                captureService.sendPhotoErrorResponse(requestId, "VIDEO_RECORDING_ACTIVE", "Video recording in progress - request rejected");
                return false;
            }

            // COOLDOWN CHECK: Reject photo requests if BLE transfer is in progress
            if (captureService.isBleTransferInProgress()) {
                Log.w(TAG, "🚫 Photo request rejected - BLE transfer in progress (cooldown active)");
                logCommandResult("take_photo", false, "BLE transfer in progress - request rejected");
                // Send immediate error response to phone
                captureService.sendPhotoErrorResponse(requestId, "BLE_TRANSFER_BUSY", "BLE transfer in progress - request rejected");
                return false;
            }

            // Process photo capture based on transfer method
            boolean success = processPhotoCapture(captureService, photoFilePath, requestId, webhookUrl, authToken,
                                                 bleImgId, save, size, transferMethod, enableLed, compress);
            logCommandResult("take_photo", success, success ? null : "Photo capture failed");
            return success;

        } catch (Exception e) {
            Log.e(TAG, "Error handling take photo command", e);
            logCommandResult("take_photo", false, "Exception: " + e.getMessage());
            return false;
        }
    }

    /**
     * Process photo capture based on transfer method.
     *
     * @param captureService Media capture service
     * @param photoFilePath Photo file path
     * @param requestId Request ID
     * @param webhookUrl Webhook URL
     * @param authToken Auth token for webhook authentication
     * @param bleImgId BLE image ID
     * @param save Whether to save the photo
     * @param size Photo size
     * @param transferMethod Transfer method
     * @param enableLed Whether to enable LED
     * @param compress Compression level
     * @return true if successful, false otherwise
     */
    private boolean processPhotoCapture(MediaCaptureService captureService, String photoFilePath,
                                      String requestId, String webhookUrl, String authToken, String bleImgId,
                                      boolean save, String size, String transferMethod, boolean enableLed, String compress) {
        Log.d(TAG, "789789Processing photo capture with transfer method: " + transferMethod);
        switch (transferMethod) {
            case "ble":
                captureService.takePhotoForBleTransfer(photoFilePath, requestId, bleImgId, save, size, enableLed);
                return true;
            case "auto":
                if (bleImgId.isEmpty()) {
                    Log.e(TAG, "Auto mode requires bleImgId for fallback");
                    return false;
                }
                captureService.takePhotoAutoTransfer(photoFilePath, requestId, webhookUrl, authToken, bleImgId, save, size, enableLed, compress);
                return true;
            default:
                captureService.takePhotoAndUpload(photoFilePath, requestId, webhookUrl, authToken, save, size, enableLed, compress);
                return true;
        }
    }
}