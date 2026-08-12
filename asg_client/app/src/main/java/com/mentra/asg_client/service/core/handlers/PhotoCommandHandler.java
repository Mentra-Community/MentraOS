package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.camera.policy.PhotoMode;
import com.mentra.asg_client.camera.policy.PhotoSizeTier;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.settings.AsgSettings;
import java.util.Set;
import org.json.JSONObject;

/**
 * Handler for photo-related commands. Follows Single Responsibility Principle by handling only
 * photo commands. Extends BaseMediaCommandHandler for common package directory management.
 */
public class PhotoCommandHandler extends BaseMediaCommandHandler {
    private static final String TAG = "PhotoCommandHandler";
    private static final Set<String> PHOTO_TRANSFER_METHODS = Set.of("auto", "direct", "ble");

    private final AsgClientServiceManager serviceManager;
    private final IStateManager stateManager;

    public PhotoCommandHandler(
            Context context,
            AsgClientServiceManager serviceManager,
            FileManager fileManager,
            IStateManager stateManager) {
        super(context, fileManager);
        this.serviceManager = serviceManager;
        this.stateManager = stateManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("take_photo", "camera_warm_up", "camera_warm_up_stop");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "take_photo":
                    return handleTakePhoto(data);
                case "camera_warm_up":
                    return handleCameraWarmUp(data);
                case "camera_warm_up_stop":
                    return handleCameraWarmUpStop(data);
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
     * Handle {@code camera_warm_up}: open + configure + preview the camera and hold it warm for a
     * TTL (default 15000ms) without capturing, so a subsequent {@code take_photo} of the same
     * {@code size}/{@code exposureTimeNs} reuses the warm session. Routes to {@link
     * MediaCaptureService#warmUpCamera} which emits {@code camera_status} (warming → ready →
     * stopped/error).
     */
    private boolean handleCameraWarmUp(JSONObject data) {
        try {
            String packageName = resolvePackageName(data);
            logCommandStart("camera_warm_up", packageName);

            // requestId is required — reject if missing.
            if (!validateRequestId(data)) {
                return false;
            }

            String requestId = data.optString("requestId", "");
            String mode = PhotoMode.normalize(data.optString("mode", PhotoMode.PHOTO));
            String requestedSize = PhotoSizeTier.normalize(data.optString("size", "medium"));
            String size = PhotoMode.captureSize(mode, requestedSize);
            Long exposureTimeNs = PhotoExposureTimeNs.parse(data);
            long durationMs = data.optLong("durationMs", 0L);
            if (durationMs <= 0) {
                durationMs = AsgConstants.CAMERA_WARM_UP_DEFAULT_DURATION_MS;
            }
            durationMs = Math.min(durationMs, AsgConstants.CAMERA_WARM_UP_MAX_DURATION_MS);
            // Only pull zsl/mfnr from the warm-up JSON — other take_photo tuning fields are
            // irrelevant for opening the preview session.
            PhotoCaptureSettings.Builder warmTuning = new PhotoCaptureSettings.Builder();
            if (data.has("zsl") && !data.isNull("zsl")) {
                warmTuning.zsl(data.optBoolean("zsl", true));
            }
            if (data.has("mfnr") && !data.isNull("mfnr")) {
                warmTuning.mfnr(data.optBoolean("mfnr", true));
            }
            PhotoCaptureSettings captureSettings = warmTuning.build();

            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                logCommandResult("camera_warm_up", false, "Media capture service not available");
                sendCameraWarmUpError(
                        requestId,
                        "media_capture_service_unavailable",
                        "Media capture service not available");
                return false;
            }

            boolean accepted =
                    captureService.warmUpCamera(
                            requestId, size, exposureTimeNs, durationMs, mode, captureSettings);
            logCommandResult("camera_warm_up", accepted, accepted ? null : "Warm-up rejected");
            return accepted;
        } catch (Exception e) {
            Log.e(TAG, "Error handling camera warm-up command", e);
            logCommandResult("camera_warm_up", false, "Exception: " + e.getMessage());
            String requestId = data.optString("requestId", "");
            if (!requestId.isEmpty()) {
                sendCameraWarmUpError(
                        requestId,
                        "camera_warm_up_failed",
                        "Camera warm-up failed: " + e.getMessage());
            }
            return false;
        }
    }

    /** Release one request-owned warm-up lease without disturbing compatible owners. */
    private boolean handleCameraWarmUpStop(JSONObject data) {
        String requestId = data.optString("requestId", "");
        if (requestId.isEmpty()) {
            requestId = data.optString("request_id", "");
        }
        if (requestId.isEmpty()) {
            Log.w(TAG, "camera_warm_up_stop rejected - missing requestId");
            return false;
        }

        MediaCaptureService captureService = serviceManager.getMediaCaptureService();
        if (captureService == null) {
            sendCameraWarmUpError(
                    requestId,
                    "media_capture_service_unavailable",
                    "Media capture service not available");
            return false;
        }
        captureService.stopCameraWarmUp(requestId);
        return true;
    }

    private void sendCameraWarmUpError(String requestId, String errorCode, String errorMessage) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            JSONObject status = new JSONObject();
            status.put("type", "camera_status");
            status.put("state", "error");
            status.put("requestId", requestId);
            status.put("timestamp", System.currentTimeMillis());
            status.put("errorCode", errorCode);
            status.put("errorMessage", errorMessage);

            if (serviceManager.getBluetoothManager() != null) {
                serviceManager.getBluetoothManager().sendMessage(status.toString().getBytes());
                Log.d(
                        TAG,
                        "📷 camera_status sent: state=error requestId="
                                + requestId
                                + " errorCode="
                                + errorCode);
            } else {
                Log.w(TAG, "Cannot send camera warm-up error - Bluetooth manager unavailable");
            }
        } catch (Exception sendError) {
            Log.e(TAG, "Error sending camera warm-up error", sendError);
        }
    }

    /** Handle take photo command */
    private boolean handleTakePhoto(JSONObject data) {
        String requestIdForLog = data.optString("requestId", "");
        // Do not log the raw `data` payload — it carries the user's authToken.
        Log.i(
                TAG,
                "PHOTO PIPELINE [ASG 2/3] PhotoCommandHandler.handleTakePhoto requestId="
                        + requestIdForLog);
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
            String transferMethod = resolveTransferMethod(data);
            String bleImgId = data.optString("bleImgId", "");
            boolean save = data.optBoolean("save", false);
            String mode = PhotoMode.normalize(data.optString("mode", PhotoMode.PHOTO));
            String requestedSize = PhotoSizeTier.normalize(data.optString("size", "medium"));
            String size = PhotoMode.captureSize(mode, requestedSize);
            if (!data.has("mode")) {
                Log.w(TAG, "📸 take_photo BLE payload missing mode field; defaulting to " + mode);
            }
            Log.i(TAG, "📸 Mentra Live take_photo mode: " + mode);
            if (!size.equals(requestedSize)) {
                Log.i(
                        TAG,
                        "📸 Text mode overriding capture size "
                                + requestedSize
                                + " → "
                                + size
                                + " (ASG text sensor constants)");
            }
            PhotoCaptureSettings requestCaptureSettings =
                    PhotoCaptureSettings.fromTakePhotoJson(data);
            PhotoCaptureSettings.logIncomingTakePhotoFields(data, requestId);
            AsgSettings asgSettings = serviceManager.getAsgSettings();
            Long exposureTimeNs = PhotoExposureTimeNs.parse(data);
            // Text mode no longer injects aeExposureDivisor; callers that want scan AE pass it
            // explicitly. Request zsl/mfnr omit → global defaults (same as photo mode).
            PhotoCaptureSettings captureSettings = requestCaptureSettings;
            if (asgSettings != null) {
                captureSettings =
                        PhotoCaptureSettings.mergeForSdkRequest(captureSettings, asgSettings);
            }
            String compress = resolvePhotoCompress(data, asgSettings);
            // Capture light is mandatory for privacy; ignore any caller-supplied flash value.
            boolean flash = true;
            boolean sound = resolvePhotoSound(data, asgSettings);
            PhotoCaptureSettings.logMergeDiagnostics(
                    requestCaptureSettings, captureSettings, asgSettings, requestId);
            Integer requestedIso = PhotoIso.parse(data);
            Integer iso = exposureTimeNs != null ? requestedIso : null;
            if (exposureTimeNs != null) {
                Log.i(
                        TAG,
                        "Mentra Live using manual exposure time for take_photo request "
                                + requestId
                                + ": "
                                + exposureTimeNs
                                + " ns");
            }
            if (requestedIso != null && exposureTimeNs == null) {
                Log.i(
                        TAG,
                        "Mentra Live ignoring ISO for take_photo request "
                                + requestId
                                + " because exposureTimeNs was not set");
            }
            if (iso != null) {
                Log.i(
                        TAG,
                        "Mentra Live using manual ISO for take_photo request "
                                + requestId
                                + ": ISO "
                                + iso);
            }

            logResolvedTakePhotoParams(
                    requestId,
                    size,
                    mode,
                    compress,
                    flash,
                    sound,
                    save,
                    transferMethod,
                    bleImgId,
                    webhookUrl,
                    exposureTimeNs,
                    iso,
                    captureSettings);

            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService == null) {
                logCommandResult("take_photo", false, "Media capture service not available");
                return false;
            }
            if (captureService.isPairingTransferCaptureBlocked()) {
                String message = "Capture blocked during ownership transfer";
                Log.w(TAG, "🚫 Photo request rejected - ownership transfer capture barrier active");
                logCommandResult("take_photo", false, message);
                captureService.sendPhotoErrorResponse(requestId, "PAIRING_TRANSFER", message);
                return false;
            }
            if (transferMethod == null || !PHOTO_TRANSFER_METHODS.contains(transferMethod)) {
                Object invalidTransferMethod = data.opt("transferMethod");
                String message =
                        "Invalid transferMethod \""
                                + invalidTransferMethod
                                + "\". Expected auto, direct, or ble.";
                logCommandResult("take_photo", false, message);
                captureService.sendPhotoErrorResponse(
                        requestId, "INVALID_TRANSFER_METHOD", message);
                return false;
            }

            // Use the permanent gallery path only when the caller wants to save; otherwise use
            // the transient _sdk_pending tree so in-flight SDK photos are invisible to gallery
            // sync and are cleaned up automatically after upload.
            String photoFilePath =
                    save
                            ? generateCaptureFilePath(packageName, "IMG_", ".jpg", requestId)
                            : generateTransientCaptureFilePath(
                                    packageName, "IMG_", ".jpg", requestId);
            if (photoFilePath == null) {
                logCommandResult("take_photo", false, "Failed to generate file path");
                captureService.sendPhotoErrorResponse(
                        requestId, "PHOTO_FILE_PATH_FAILED", "Failed to generate file path");
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
                    captureService.sendPhotoErrorResponse(
                            requestId,
                            "BATTERY_LOW",
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

            // VIDEO RECORDING CHECK: Reject photo requests if video is currently recording
            if (captureService.isRecordingVideo()) {
                Log.w(TAG, "🚫 Photo request rejected - video recording in progress");
                logCommandResult(
                        "take_photo", false, "Video recording in progress - request rejected");
                // Send immediate error response to phone
                captureService.sendPhotoErrorResponse(
                        requestId,
                        "VIDEO_RECORDING_ACTIVE",
                        "Video recording in progress - request rejected");
                return false;
            }

            // ARCHIVAL CAPTURE: a save-only request (no upload target) has no delivery leg —
            // no webhook upload, no BLE transfer — so there is nothing for the single-flight
            // photo-job gate to protect. Route it down the button-photo path: camera-queue
            // serialized, no CAMERA_BUSY, so SDK callers can burst-save to the gallery and
            // pull the files later over WiFi sync (each stamped with its requestId).
            // transferMethod is deliberately not consulted: it is always "auto" in practice
            // and the phone app always supplies a webhookUrl, so this shape is only ever
            // produced by direct BT-SDK callers that want exactly this behavior.
            if (save && webhookUrl.isEmpty()) {
                Log.i(
                        TAG,
                        "PHOTO PIPELINE [ASG 3/3] Local-save capture (no upload target)"
                                + " requestId="
                                + requestId);
                boolean accepted =
                        captureService.takePhotoForLocalSave(
                                photoFilePath,
                                requestId,
                                size,
                                mode,
                                flash,
                                sound,
                                exposureTimeNs,
                                iso,
                                captureSettings);
                logCommandResult(
                        "take_photo", accepted, accepted ? null : "Local-save capture rejected");
                return accepted;
            }

            // COOLDOWN CHECK: Reject photo requests if BLE transfer is in progress
            if (captureService.isBleTransferInProgress()) {
                Log.w(
                        TAG,
                        "🚫 Photo request rejected - BLE transfer in progress (cooldown active)");
                logCommandResult(
                        "take_photo", false, "BLE transfer in progress - request rejected");
                // Send immediate error response to phone
                captureService.sendPhotoErrorResponse(
                        requestId,
                        "BLE_TRANSFER_BUSY",
                        "BLE transfer in progress - request rejected");
                return false;
            }

            // PHOTO JOB CHECK: Reject if any photo job (capture or upload/BLE-handoff) is in flight
            if (captureService.isPhotoJobInFlight()) {
                Log.w(TAG, "🚫 Photo request rejected - photo job already in flight");
                logCommandResult("take_photo", false, "Photo job in flight - request rejected");
                captureService.sendPhotoErrorResponse(
                        requestId, "CAMERA_BUSY", "Another photo job is in progress");
                return false;
            }

            // Process photo capture based on transfer method
            if ("ble".equals(transferMethod) || !bleImgId.isEmpty()) {
                captureService.markBlePhotoPipelineStart(requestId);
            }
            Log.i(
                    TAG,
                    "PHOTO PIPELINE [ASG 3/3] Starting capture requestId="
                            + requestId
                            + " mode="
                            + mode
                            + " transferMethod="
                            + transferMethod
                            + " size="
                            + size);
            boolean success =
                    processPhotoCapture(
                            captureService,
                            photoFilePath,
                            requestId,
                            webhookUrl,
                            authToken,
                            bleImgId,
                            save,
                            size,
                            mode,
                            transferMethod,
                            flash,
                            sound,
                            compress,
                            exposureTimeNs,
                            iso,
                            captureSettings);
            logCommandResult("take_photo", success, success ? null : "Photo capture failed");
            if (success) {
                Log.i(TAG, "PHOTO PIPELINE [ASG 3/3] Capture accepted requestId=" + requestId);
            }
            return success;

        } catch (Exception e) {
            Log.e(TAG, "Error handling take photo command", e);
            logCommandResult("take_photo", false, "Exception: " + e.getMessage());
            MediaCaptureService captureService = serviceManager.getMediaCaptureService();
            if (captureService != null && !requestIdForLog.isEmpty()) {
                captureService.sendPhotoErrorResponse(
                        requestIdForLog,
                        "PHOTO_COMMAND_FAILED",
                        "Error handling photo command: " + e.getMessage());
            }
            return false;
        }
    }

    private static String resolveTransferMethod(JSONObject data) {
        if (!data.has("transferMethod")) {
            return "auto";
        }
        Object value = data.opt("transferMethod");
        return value instanceof String ? (String) value : null;
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
     * @param mode Photo capture mode
     * @param transferMethod Transfer method
     * @param flash Whether to enable privacy flash LED
     * @param sound Whether to enable shutter sound
     * @param compress Compression level
     * @return true if successful, false otherwise
     */
    private boolean processPhotoCapture(
            MediaCaptureService captureService,
            String photoFilePath,
            String requestId,
            String webhookUrl,
            String authToken,
            String bleImgId,
            boolean save,
            String size,
            String mode,
            String transferMethod,
            boolean flash,
            boolean sound,
            String compress,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        Log.d(TAG, "Processing photo capture with transfer method: " + transferMethod);

        if (AsgConstants.FORCE_BLE_TRANSFER
                && !bleImgId.isEmpty()
                && !"ble".equals(transferMethod)) {
            Log.i(
                    TAG,
                    "🚫📶 FORCE_BLE_TRANSFER active: overriding requested transferMethod="
                            + transferMethod
                            + " -> ble (skipping WiFi upload attempt) requestId="
                            + requestId);
            return captureService.takePhotoForBleTransfer(
                    photoFilePath,
                    requestId,
                    bleImgId,
                    save,
                    size,
                    mode,
                    flash,
                    sound,
                    exposureTimeNs,
                    iso,
                    captureSettings);
        }

        switch (transferMethod) {
            case "ble":
                return captureService.takePhotoForBleTransfer(
                        photoFilePath,
                        requestId,
                        bleImgId,
                        save,
                        size,
                        mode,
                        flash,
                        sound,
                        exposureTimeNs,
                        iso,
                        captureSettings);
            case "auto":
                if (bleImgId.isEmpty()) {
                    Log.e(TAG, "Auto mode requires bleImgId for fallback");
                    return false;
                }
                return captureService.takePhotoAutoTransfer(
                        photoFilePath,
                        requestId,
                        webhookUrl,
                        authToken,
                        bleImgId,
                        save,
                        size,
                        mode,
                        flash,
                        sound,
                        compress,
                        exposureTimeNs,
                        iso,
                        captureSettings);
            case "direct":
                return captureService.takePhotoAndUpload(
                        photoFilePath,
                        requestId,
                        webhookUrl,
                        authToken,
                        save,
                        size,
                        mode,
                        flash,
                        sound,
                        compress,
                        exposureTimeNs,
                        iso,
                        captureSettings);
            default:
                // handleTakePhoto validates this before any capture work starts.
                throw new IllegalArgumentException("Unsupported transferMethod: " + transferMethod);
        }
    }

    private static void logResolvedTakePhotoParams(
            String requestId,
            String size,
            String mode,
            String compress,
            boolean flash,
            boolean sound,
            boolean save,
            String transferMethod,
            String bleImgId,
            String webhookUrl,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        Log.i(
                TAG,
                "📸 take_photo resolved params"
                        + " requestId="
                        + requestId
                        + " size="
                        + size
                        + " mode="
                        + mode
                        + " compress="
                        + compress
                        + " flash="
                        + flash
                        + " sound="
                        + sound
                        + " save="
                        + save
                        + " transferMethod="
                        + transferMethod
                        + " bleImgId="
                        + bleImgId
                        + " webhookUrl="
                        + webhookUrl
                        + " exposureTimeNs="
                        + exposureTimeNs
                        + " iso="
                        + iso
                        + " captureTuning={"
                        + (captureSettings != null ? captureSettings.describeForLog() : "null")
                        + "}");
    }

    private static String resolvePhotoCompress(JSONObject data, AsgSettings stored) {
        if (data != null && data.has("compress") && !data.isNull("compress")) {
            return data.optString("compress", "none");
        }
        // SDK take_photo requests that omit compress should use the SDK default (none), not
        // a stored button scan preset — button presets are for hardware-button captures only.
        return "none";
    }

    private static boolean resolvePhotoSound(JSONObject data, AsgSettings stored) {
        if (data != null && data.has("sound") && !data.isNull("sound")) {
            return data.optBoolean("sound", true);
        }
        // Same as compress: SDK requests use the SDK default (sound on) regardless of
        // any stored button_photo_setting scan preset.
        return true;
    }
}
