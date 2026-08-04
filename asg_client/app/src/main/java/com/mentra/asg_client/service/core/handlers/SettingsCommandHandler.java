package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.dev.api.DevApi;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.policy.PhotoSizeTier;
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
    private static final long CAMERA_FOV_RESTORE_RETRY_DELAY_MS = 5_000L;

    private final AsgClientServiceManager serviceManager;
    private final ICommunicationManager communicationManager;
    private final IResponseBuilder responseBuilder;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private String cameraFovOverrideLeaseId;
    private int cameraFovOverrideValue;
    private int cameraFovOverrideRoi;
    private Runnable cameraFovOverrideExpiry;

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
                "button_mode_setting",
                "camera_fov_setting",
                "camera_fov_override",
                "camera_fov_override_release",
                "camera_tuning_config");
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
                case "button_mode_setting":
                    return handleButtonModeSetting(data);
                case "camera_fov_setting":
                    return handleCameraFovSetting(data);
                case "camera_fov_override":
                    return handleCameraFovOverride(data);
                case "camera_fov_override_release":
                    return handleCameraFovOverrideRelease(data);
                case "camera_tuning_config":
                    return handleCameraTuningConfig(data);
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
            boolean hasSize = data.has("size") && !data.isNull("size");
            String size = PhotoSizeTier.normalize(data.optString("size", "medium"));
            boolean hasMfnr = data.has("mfnr") && !data.isNull("mfnr");
            boolean hasZsl = data.has("zsl") && !data.isNull("zsl");
            boolean hasNoiseReduction = data.has("noiseReduction") && !data.isNull("noiseReduction");
            boolean hasEdgeEnhancement = data.has("edgeEnhancement") && !data.isNull("edgeEnhancement");
            boolean hasIspDigitalGain = data.has("ispDigitalGain") && !data.isNull("ispDigitalGain");
            boolean hasIspAnalogGain = data.has("ispAnalogGain") && !data.isNull("ispAnalogGain");
            boolean hasAeExposureDivisor =
                    data.has("aeExposureDivisor") && !data.isNull("aeExposureDivisor");
            boolean hasIsoCap = data.has("isoCap") && !data.isNull("isoCap");
            boolean hasCompress = data.has("compress") && !data.isNull("compress");
            boolean hasSound = data.has("sound") && !data.isNull("sound");
            Boolean mfnr = hasMfnr ? data.optBoolean("mfnr", true) : null;
            Boolean zsl = hasZsl ? data.optBoolean("zsl", true) : null;
            Boolean noiseReduction =
                    hasNoiseReduction ? data.optBoolean("noiseReduction", true) : null;
            Boolean edgeEnhancement =
                    hasEdgeEnhancement ? data.optBoolean("edgeEnhancement", true) : null;
            Integer ispDigitalGain =
                    hasIspDigitalGain ? data.optInt("ispDigitalGain", 0) : null;
            String ispAnalogGain =
                    hasIspAnalogGain ? data.optString("ispAnalogGain", null) : null;
            Integer aeExposureDivisor =
                    hasAeExposureDivisor ? data.optInt("aeExposureDivisor", 0) : null;
            Integer isoCap = hasIsoCap ? data.optInt("isoCap", 0) : null;
            String compress = hasCompress ? data.optString("compress", "none") : null;
            Boolean sound = hasSound ? data.optBoolean("sound", true) : null;

            Log.d(
                    TAG,
                    "Received button photo setting: size="
                            + size
                            + (hasMfnr ? ", mfnr=" + mfnr : "")
                            + (hasZsl ? ", zsl=" + zsl : "")
                            + (hasNoiseReduction ? ", noiseReduction=" + noiseReduction : "")
                            + (hasEdgeEnhancement ? ", edgeEnhancement=" + edgeEnhancement : "")
                            + (hasIspDigitalGain ? ", ispDigitalGain=" + ispDigitalGain : "")
                            + (hasIspAnalogGain ? ", ispAnalogGain=" + ispAnalogGain : "")
                            + (hasAeExposureDivisor ? ", aeExposureDivisor=" + aeExposureDivisor : "")
                            + (hasIsoCap ? ", isoCap=" + isoCap : "")
                            + (hasCompress ? ", compress=" + compress : "")
                            + (hasSound ? ", sound=" + sound : ""));
            if (noiseReduction != null && !noiseReduction) {
                Log.d(
                        TAG,
                        "noiseReduction=false stored via button_photo_setting; bridging to HAL"
                                + " camconfig (anr=false). Camera2 NR mode may still report"
                                + " not_implemented.");
            }
            if (ispDigitalGain != null) {
                Log.d(
                        TAG,
                        "ispDigitalGain="
                                + ispDigitalGain
                                + " stored via button_photo_setting; gain bridged to HAL camconfig."
                                + " Camera2 ISP digital gain may still report not_implemented.");
            }
            if (ispAnalogGain != null && !ispAnalogGain.isEmpty()) {
                Log.d(
                        TAG,
                        "ispAnalogGain="
                                + ispAnalogGain
                                + " stored via button_photo_setting; gain bridged to HAL camconfig."
                                + " Camera2 ISP analog gain may still report not_implemented.");
            }

            boolean resetCaptureTuning = data.optBoolean("resetCaptureTuning", false);

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings != null) {
                if (resetCaptureTuning) {
                    asgSettings.clearButtonPhotoCaptureTuning();
                }
                // Only persist size when the update actually carries it; size is optional on the
                // wire (sender omits it when unchanged), so an unconditional write would clobber a
                // stored tier (e.g. max) with the "medium" default on a partial/reset-only update.
                if (hasSize) {
                    asgSettings.setButtonPhotoSize(size);
                }
                if (hasZsl) {
                    asgSettings.setButtonPhotoZsl(zsl);
                }
                if (hasMfnr) {
                    asgSettings.setButtonPhotoMfnr(mfnr);
                }
                if (hasNoiseReduction) {
                    asgSettings.setButtonPhotoNoiseReduction(noiseReduction);
                }
                if (hasEdgeEnhancement) {
                    asgSettings.setButtonPhotoEdgeEnhancement(edgeEnhancement);
                }
                if (hasIspDigitalGain) {
                    asgSettings.setButtonPhotoIspDigitalGain(ispDigitalGain);
                }
                if (hasIspAnalogGain) {
                    asgSettings.setButtonPhotoIspAnalogGain(ispAnalogGain);
                }
                if (hasAeExposureDivisor) {
                    asgSettings.setButtonPhotoAeExposureDivisor(aeExposureDivisor);
                }
                if (hasIsoCap) {
                    asgSettings.setButtonPhotoIsoCap(isoCap);
                }
                if (hasCompress) {
                    asgSettings.setButtonPhotoCompress(compress);
                }
                if (hasSound) {
                    asgSettings.setButtonPhotoSound(sound);
                }

                // Bridge scan-preset noise-reduction / gain onto the HAL camconfig path so they
                // actually take effect at the sensor. The Camera2 per-capture keys
                // (NOISE_REDUCTION_MODE / ISP gain) are reported not_implemented by the MediaTek
                // HAL, but the camera_tuning_config camconfig broadcast (anr/gain) is honored.
                // Only touch global HAL tuning when the update carries the relevant scan fields (or
                // a reset) so plain size-only button_photo updates leave it untouched.
                boolean bridgeHalTuning =
                        resetCaptureTuning || hasNoiseReduction || hasIspAnalogGain || hasIspDigitalGain;
                if (bridgeHalTuning) {
                    // Reset restores stock tuning; explicit scan fields then override the baseline.
                    boolean anrOn = resetCaptureTuning ? true : asgSettings.isCameraAnrEnabled();
                    boolean gainOn = resetCaptureTuning ? true : asgSettings.isCameraGainEnabled();
                    if (hasNoiseReduction) {
                        anrOn = noiseReduction;
                    }
                    if (hasIspAnalogGain && ispAnalogGain != null) {
                        // "low" analog gain => pixsmart gain-off; anything else keeps stock gain.
                        gainOn = !"low".equalsIgnoreCase(ispAnalogGain.trim());
                    } else if (hasIspDigitalGain && ispDigitalGain != null) {
                        // Analog gain takes precedence when both are present; digital is the
                        // fallback. ispDigitalGain > 0 means a positive sensor gain is requested
                        // (stock pipeline), so gain stays ON; 0 means suppress gain (gain-off).
                        gainOn = ispDigitalGain > 0;
                    }
                    applyCameraTuning(asgSettings, anrOn, gainOn);
                }
                // For the ack, echo the persisted (effective) size rather than the wire value so
                // clients that omit size receive the actual stored tier (e.g. max) in the response.
                String ackedSize = asgSettings.getButtonPhotoSize();
                if (ackedSize == null || ackedSize.isEmpty()) ackedSize = "medium";
                Log.d(TAG, "✅ Button photo settings saved: size=" + ackedSize);
                JSONObject values = new JSONObject();
                values.put("size", ackedSize);
                if (mfnr != null) {
                    values.put("mfnr", mfnr);
                }
                if (zsl != null) {
                    values.put("zsl", zsl);
                }
                if (noiseReduction != null) {
                    values.put("noiseReduction", noiseReduction);
                }
                if (edgeEnhancement != null) {
                    values.put("edgeEnhancement", edgeEnhancement);
                }
                if (ispDigitalGain != null) {
                    values.put("ispDigitalGain", ispDigitalGain);
                }
                if (ispAnalogGain != null) {
                    values.put("ispAnalogGain", ispAnalogGain);
                }
                if (aeExposureDivisor != null && aeExposureDivisor > 1) {
                    values.put("aeExposureDivisor", aeExposureDivisor);
                }
                if (isoCap != null && isoCap > 0) {
                    values.put("isoCap", isoCap);
                }
                if (compress != null) {
                    values.put("compress", compress);
                }
                if (sound != null) {
                    values.put("sound", sound);
                }
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

    /**
     * Handle camera FOV setting command (K900). Persists FOV and ROI, applies to hardware, restarts
     * camera HAL.
     */
    private synchronized boolean handleCameraFovSetting(JSONObject data) {
        try {
            String requestId = getRequestId(data);
            JSONObject params = data.optJSONObject("params");
            if (params == null) {
                Log.e(TAG, "Missing params in camera_fov_setting");
                sendSettingsError(requestId, "camera_fov", "missing_params", "Missing camera FOV params.");
                return false;
            }
            int fov = params.optInt("fov", AsgConstants.CAMERA_FOV_DEFAULT);
            int roiPosition =
                    params.optInt(
                            "roi_position", AsgConstants.CAMERA_ROI_POSITION_DEFAULT);

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

            // A miniapp override is the current effective crop. Update the persistent base without
            // interrupting that owner; release/expiry will restore this newly saved value.
            if (cameraFovOverrideLeaseId != null) {
                JSONObject values = new JSONObject();
                values.put("fov", fov);
                values.put("roi_position", roiPosition);
                values.put("hardware_applied", false);
                values.put("deferred_by_override", true);
                sendSettingsAck(requestId, "camera_fov", STATUS_APPLIED, values);
                return true;
            }

            Context context = serviceManager.getContext();
            if (context == null) {
                Log.w(TAG, "Context not available, FOV persisted but not applied to hardware");
                JSONObject values = new JSONObject();
                values.put("fov", fov);
                values.put("roi_position", roiPosition);
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
                // Re-apply saved camera tuning after the HAL comes back up so ANR/gain config
                // survives a runtime FOV change (mirrors the boot-time defer in AsgClientService).
                AsgSettings savedSettings = asgSettings;
                new Handler(Looper.getMainLooper())
                        .postDelayed(
                                () -> {
                                    try {
                                        boolean anrOn = savedSettings.isCameraAnrEnabled();
                                        boolean gainOn = savedSettings.isCameraGainEnabled();
                                        SystemControllerFactory.get(context)
                                                .setCameraTuningConfig(anrOn, gainOn);
                                        Log.d(
                                                TAG,
                                                "Camera tuning re-applied after FOV HAL restart:"
                                                        + " anr="
                                                        + anrOn
                                                        + ", gain="
                                                        + gainOn);
                                    } catch (Exception ex) {
                                        Log.w(
                                                TAG,
                                                "Failed to re-apply camera tuning after FOV"
                                                        + " restart",
                                                ex);
                                    }
                                },
                                CameraRestartCooldown.DEFAULT_COOLDOWN_DURATION_MS + 500L);
            } catch (UnsatisfiedLinkError e) {
                Log.w(TAG, "libxydev not available (non-K900?), FOV persisted but not applied", e);
                JSONObject values = new JSONObject();
                values.put("fov", fov);
                values.put("roi_position", roiPosition);
                values.put("hardware_applied", false);
                sendSettingsAck(requestId, "camera_fov", STATUS_APPLIED, values);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling camera_fov_setting", e);
            return false;
        }
    }

    /** Apply/refresh a memory-only miniapp crop lease without touching persistent user prefs. */
    private synchronized boolean handleCameraFovOverride(JSONObject data) {
        String requestId = getRequestId(data);
        try {
            JSONObject params = data.optJSONObject("params");
            if (params == null) {
                sendSettingsError(
                        requestId,
                        "camera_fov_override",
                        "missing_params",
                        "Missing camera FOV override params.");
                return false;
            }
            String leaseId = params.optString("lease_id", "");
            if (leaseId.isEmpty()) {
                sendSettingsError(
                        requestId,
                        "camera_fov_override",
                        "missing_lease_id",
                        "Missing camera FOV override lease ID.");
                return false;
            }

            int fov =
                    Math.max(
                            62,
                            Math.min(
                                    118,
                                    params.optInt(
                                            "fov", AsgConstants.CAMERA_FOV_DEFAULT)));
            int roi =
                    Math.max(
                            0,
                            Math.min(
                                    2,
                                    params.optInt(
                                            "roi_position",
                                            AsgConstants.CAMERA_ROI_POSITION_DEFAULT)));
            long ttlMs = params.optLong("ttl_ms", 0L);
            if (ttlMs <= 0) {
                ttlMs = AsgConstants.CAMERA_FOV_OVERRIDE_DEFAULT_TTL_MS;
            }
            ttlMs = Math.min(ttlMs, AsgConstants.CAMERA_FOV_OVERRIDE_MAX_TTL_MS);

            boolean refresh =
                    leaseId.equals(cameraFovOverrideLeaseId)
                            && fov == cameraFovOverrideValue
                            && roi == cameraFovOverrideRoi;

            if (refresh) {
                scheduleCameraFovOverrideExpiry(leaseId, ttlMs);
                JSONObject values = cameraFovValues(fov, roi, true);
                values.put("lease_id", leaseId);
                values.put("refreshed", true);
                sendSettingsAck(requestId, "camera_fov_override", STATUS_READY, values);
                return true;
            }

            boolean applied =
                    applyEffectiveCameraFov(
                            requestId, "camera_fov_override", fov, roi, leaseId);
            if (!applied) {
                return false;
            }

            // Do not make a lease current until its HAL change succeeds. If DevApi or the restart
            // throws, the prior lease remains authoritative and persistent FOV updates are not
            // incorrectly deferred behind an override that was reported as failed.
            cameraFovOverrideLeaseId = leaseId;
            cameraFovOverrideValue = fov;
            cameraFovOverrideRoi = roi;
            scheduleCameraFovOverrideExpiry(
                    leaseId,
                    ttlMs + CameraRestartCooldown.DEFAULT_COOLDOWN_DURATION_MS);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling camera_fov_override", e);
            sendSettingsError(
                    requestId,
                    "camera_fov_override",
                    "internal_error",
                    "Unexpected error applying camera FOV override.");
            return false;
        }
    }

    /** Release only the currently effective lease; delayed stale releases are safe no-ops. */
    private synchronized boolean handleCameraFovOverrideRelease(JSONObject data) {
        String requestId = getRequestId(data);
        try {
            JSONObject params = data.optJSONObject("params");
            String leaseId = params != null ? params.optString("lease_id", "") : "";
            if (leaseId.isEmpty()) {
                sendSettingsError(
                        requestId,
                        "camera_fov_override",
                        "missing_lease_id",
                        "Missing camera FOV override lease ID.");
                return false;
            }

            if (!leaseId.equals(cameraFovOverrideLeaseId)) {
                JSONObject values = new JSONObject();
                values.put("lease_id", leaseId);
                values.put("released", false);
                values.put("stale", true);
                sendSettingsAck(requestId, "camera_fov_override", STATUS_READY, values);
                return true;
            }

            AsgSettings settings = serviceManager.getAsgSettings();
            int fov =
                    settings != null
                            ? settings.getCameraFov()
                            : AsgConstants.CAMERA_FOV_DEFAULT;
            int roi =
                    settings != null
                            ? settings.getCameraRoiPosition()
                            : AsgConstants.CAMERA_ROI_POSITION_DEFAULT;
            boolean applied =
                    applyEffectiveCameraFov(
                            requestId, "camera_fov_override", fov, roi, leaseId);
            if (applied) {
                // Preserve the lease if restoring the base fails so the phone can retry release.
                clearCameraFovOverride();
            }
            return applied;
        } catch (Exception e) {
            Log.e(TAG, "Error releasing camera_fov_override", e);
            sendSettingsError(
                    requestId,
                    "camera_fov_override",
                    "internal_error",
                    "Unexpected error releasing camera FOV override.");
            return false;
        }
    }

    private void scheduleCameraFovOverrideExpiry(String leaseId, long delayMs) {
        if (cameraFovOverrideExpiry != null) {
            mainHandler.removeCallbacks(cameraFovOverrideExpiry);
        }
        cameraFovOverrideExpiry =
                () -> {
                    synchronized (SettingsCommandHandler.this) {
                        if (!leaseId.equals(cameraFovOverrideLeaseId)) {
                            return;
                        }
                        Log.i(TAG, "Camera FOV override lease expired: " + leaseId);
                        AsgSettings settings = serviceManager.getAsgSettings();
                        int fov =
                                settings != null
                                        ? settings.getCameraFov()
                                        : AsgConstants.CAMERA_FOV_DEFAULT;
                        int roi =
                                settings != null
                                        ? settings.getCameraRoiPosition()
                                        : AsgConstants.CAMERA_ROI_POSITION_DEFAULT;
                        if (applyEffectiveCameraFov(
                                null, "camera_fov_override", fov, roi, leaseId)) {
                            clearCameraFovOverride();
                        } else {
                            // A missing service context is transient during ASG lifecycle changes.
                            // Keep ownership until the base crop is actually restored so the
                            // glasses never retain an untracked miniapp override.
                            scheduleCameraFovOverrideExpiry(
                                    leaseId, CAMERA_FOV_RESTORE_RETRY_DELAY_MS);
                        }
                    }
                };
        mainHandler.postDelayed(cameraFovOverrideExpiry, delayMs);
    }

    private void clearCameraFovOverride() {
        if (cameraFovOverrideExpiry != null) {
            mainHandler.removeCallbacks(cameraFovOverrideExpiry);
            cameraFovOverrideExpiry = null;
        }
        cameraFovOverrideLeaseId = null;
    }

    private boolean applyEffectiveCameraFov(
            String requestId, String setting, int fov, int roiPosition, String leaseId) {
        Context context = serviceManager.getContext();
        if (context == null) {
            Log.w(TAG, "Context unavailable; camera FOV was not applied");
            sendSettingsError(
                    requestId,
                    setting,
                    "camera_unavailable",
                    "Camera service is unavailable; retry when the glasses are ready.");
            return false;
        }
        try {
            DevApi.setCameraFov(fov, roiPosition);
            SystemControllerFactory.get(context).restartCameraHal();
            CameraRestartCooldown.setCooldown();
            sendCameraFovReadyAck(requestId, setting, fov, roiPosition, leaseId);
            reapplyCameraTuningAfterRestart(context);
        } catch (UnsatisfiedLinkError e) {
            Log.w(TAG, "libxydev not available (non-K900?), FOV not applied", e);
            JSONObject values = cameraFovValues(fov, roiPosition, false);
            sendSettingsAck(requestId, setting, STATUS_APPLIED, values);
        }
        return true;
    }

    private JSONObject cameraFovValues(int fov, int roiPosition, boolean hardwareApplied) {
        JSONObject values = new JSONObject();
        try {
            values.put("fov", fov);
            values.put("roi_position", roiPosition);
            values.put("hardware_applied", hardwareApplied);
        } catch (Exception ignored) {
            // JSONObject backed by primitive values cannot fail in practice.
        }
        return values;
    }

    private void reapplyCameraTuningAfterRestart(Context context) {
        AsgSettings settings = serviceManager.getAsgSettings();
        if (settings == null) {
            return;
        }
        mainHandler.postDelayed(
                () -> {
                    try {
                        SystemControllerFactory.get(context)
                                .setCameraTuningConfig(
                                        settings.isCameraAnrEnabled(),
                                        settings.isCameraGainEnabled());
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to re-apply camera tuning after FOV restart", e);
                    }
                },
                CameraRestartCooldown.DEFAULT_COOLDOWN_DURATION_MS + 500L);
    }

    private String getRequestId(JSONObject data) {
        String requestId = data.optString("requestId", "");
        if (requestId == null || requestId.isEmpty()) {
            requestId = data.optString("request_id", "");
        }
        return requestId == null ? "" : requestId;
    }

    private void sendCameraFovReadyAck(String requestId, int fov, int roiPosition) {
        sendCameraFovReadyAck(requestId, "camera_fov", fov, roiPosition, null);
    }

    private void sendCameraFovReadyAck(
            String requestId,
            String setting,
            int fov,
            int roiPosition,
            String leaseId) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        mainHandler.postDelayed(
                        () -> {
                            try {
                                JSONObject values = new JSONObject();
                                values.put("fov", fov);
                                values.put("roi_position", roiPosition);
                                values.put("hardware_applied", true);
                                if (leaseId != null) {
                                    values.put("lease_id", leaseId);
                                }
                                sendSettingsAck(requestId, setting, STATUS_READY, values);
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
                ack.put("ready", STATUS_READY.equals(status));
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
     * Handle camera_tuning_config command. Persists ANR and gain flags and immediately applies them
     * via a {@code camconfig} broadcast to SystemUI.
     *
     * <p>Expected JSON fields (both optional; omitted fields keep the stored value):
     * <ul>
     *   <li>{@code anr} – boolean; {@code true} = ANR on, {@code false} = ANR off</li>
     *   <li>{@code gain} – boolean; {@code true} = stock gain, {@code false} = pixsmart gain-off</li>
     * </ul>
     */
    private boolean handleCameraTuningConfig(JSONObject data) {
        try {
            String requestId = getRequestId(data);

            AsgSettings asgSettings = serviceManager.getAsgSettings();
            if (asgSettings == null) {
                Log.e(TAG, "Settings not available for camera_tuning_config");
                sendSettingsError(
                        requestId,
                        "camera_tuning",
                        "settings_unavailable",
                        "Settings are not available.");
                return false;
            }

            boolean anrOn = data.has("anr") ? data.optBoolean("anr") : asgSettings.isCameraAnrEnabled();
            boolean gainOn = data.has("gain") ? data.optBoolean("gain") : asgSettings.isCameraGainEnabled();

            applyCameraTuning(asgSettings, anrOn, gainOn);

            JSONObject values = new JSONObject();
            values.put("anr", anrOn);
            values.put("gain", gainOn);
            sendSettingsAck(requestId, "camera_tuning", STATUS_APPLIED, values);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling camera_tuning_config", e);
            sendSettingsError(getRequestId(data), "camera_tuning", "internal_error", "Unexpected error applying camera tuning.");
            return false;
        }
    }

    /**
     * Persist ANR/gain flags and apply them to the Mentra Live HAL via the {@code camconfig}
     * broadcast. Shared by the dedicated {@code camera_tuning_config} command and the scan-mode
     * {@code button_photo_setting} bridge so {@code noiseReduction}/gain actually take effect at the
     * sensor instead of only persisting as Camera2 hints the HAL reports as not_implemented.
     */
    private void applyCameraTuning(AsgSettings asgSettings, boolean anrOn, boolean gainOn) {
        asgSettings.setCameraAnrEnabled(anrOn);
        asgSettings.setCameraGainEnabled(gainOn);
        Log.d(TAG, "Camera tuning config saved: anr=" + anrOn + ", gain=" + gainOn);

        Context context = serviceManager.getContext();
        if (context != null) {
            SystemControllerFactory.get(context).setCameraTuningConfig(anrOn, gainOn);
            Log.d(TAG, "Camera tuning config applied via broadcast");
        } else {
            Log.w(TAG, "Context not available; tuning persisted but broadcast not sent");
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
