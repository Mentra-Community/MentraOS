package com.mentra.asg_client.settings;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.policy.PhotoSizeTier;

import java.util.Arrays;

/**
 * Settings manager for ASG Client
 * Handles persistent storage of user preferences
 */
public class AsgSettings {
    private static final String TAG = "AugmentOS_AsgSettings";
    private static final String PREFS_NAME = "asg_settings";
    private static final String KEY_BUTTON_VIDEO_WIDTH = "button_video_width";
    private static final String KEY_BUTTON_VIDEO_HEIGHT = "button_video_height";
    private static final String KEY_BUTTON_VIDEO_FPS = "button_video_fps";
    private static final String KEY_BUTTON_MAX_RECORDING_TIME_MINUTES = "button_max_recording_time_minutes";
    private static final String KEY_BUTTON_PHOTO_SIZE = "button_photo_size";
    private static final String KEY_SAVE_IN_GALLERY_MODE = "save_in_gallery_mode";
    private static final String KEY_ZSL_ENABLED = "zsl_enabled";
    private static final String KEY_MFNR_ENABLED = "mfnr_enabled";
    /** Legacy coupled key; migrated once into {@link #KEY_ZSL_ENABLED}/{@link #KEY_MFNR_ENABLED}. */
    private static final String KEY_ZSL_MFNR_ENABLED = "zsl_mfnr_enabled";
    private static final String KEY_BUTTON_PHOTO_NOISE_REDUCTION = "button_photo_noise_reduction";
    private static final String KEY_BUTTON_PHOTO_EDGE_ENHANCEMENT = "button_photo_edge_enhancement";
    private static final String KEY_BUTTON_PHOTO_ISP_DIGITAL_GAIN = "button_photo_isp_digital_gain";
    private static final String KEY_BUTTON_PHOTO_ISP_ANALOG_GAIN = "button_photo_isp_analog_gain";
    private static final String KEY_BUTTON_PHOTO_AE_EXPOSURE_DIVISOR = "button_photo_ae_exposure_divisor";
    private static final String KEY_BUTTON_PHOTO_ISO_CAP = "button_photo_iso_cap";
    private static final String KEY_BUTTON_PHOTO_COMPRESS = "button_photo_compress";
    private static final String KEY_BUTTON_PHOTO_SOUND = "button_photo_sound";
    private static final String KEY_BUTTON_PHOTO_MFNR = "button_photo_mfnr";
    private static final String KEY_BUTTON_PHOTO_ZSL = "button_photo_zsl";
    /** Legacy coupled button key; migrated once into independent button ZSL/MFNR keys. */
    private static final String KEY_BUTTON_PHOTO_ZSL_MFNR = "button_photo_zsl_mfnr";
    private static final String KEY_HDR_BURST_ENABLED = "hdr_burst_enabled";
    private static final String KEY_MCU_FIRMWARE_VERSION = "mcu_firmware_version";
    private static final String KEY_BES_BAUD_SWITCH_VERSION = "bes_baud_switch_version";
    private static final String KEY_CAMERA_FOV = "camera_fov";
    private static final String KEY_CAMERA_ROI_POSITION = "camera_roi_position";
    private static final String KEY_CAMERA_ANR_ENABLED = "camera_anr_enabled";
    private static final String KEY_CAMERA_GAIN_ENABLED = "camera_gain_enabled";

    /** Supported FOV range for K900 camera, inclusive (118 = No ROI) */
    private static final int MIN_CAMERA_FOV = 62;
    private static final int MAX_CAMERA_FOV = 118;
    private static final int DEFAULT_CAMERA_FOV = AsgConstants.CAMERA_FOV_DEFAULT;
    private static final int DEFAULT_CAMERA_ROI_POSITION =
            AsgConstants.CAMERA_ROI_POSITION_DEFAULT;

    private final SharedPreferences prefs;
    private final Context context;
    
    public AsgSettings(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        migrateLegacyZslMfnrPreferences();
        Log.d(TAG, "AsgSettings initialized");
    }

    /**
     * One-time migration from coupled global and button-photo keys into independent ZSL/MFNR
     * preferences.
     */
    private void migrateLegacyZslMfnrPreferences() {
        SharedPreferences.Editor editor = prefs.edit();
        boolean changed = false;
        if (prefs.contains(KEY_ZSL_MFNR_ENABLED)) {
            boolean coupled = prefs.getBoolean(KEY_ZSL_MFNR_ENABLED, AsgConstants.DEFAULT_ZSL);
            if (!prefs.contains(KEY_ZSL_ENABLED)) {
                editor.putBoolean(KEY_ZSL_ENABLED, coupled);
                changed = true;
            }
            if (!prefs.contains(KEY_MFNR_ENABLED)) {
                editor.putBoolean(KEY_MFNR_ENABLED, coupled);
                changed = true;
            }
            editor.remove(KEY_ZSL_MFNR_ENABLED);
            changed = true;
        }
        if (prefs.contains(KEY_BUTTON_PHOTO_ZSL_MFNR)) {
            boolean coupled = prefs.getBoolean(KEY_BUTTON_PHOTO_ZSL_MFNR, true);
            if (!prefs.contains(KEY_BUTTON_PHOTO_ZSL)) {
                editor.putBoolean(KEY_BUTTON_PHOTO_ZSL, coupled);
            }
            if (!prefs.contains(KEY_BUTTON_PHOTO_MFNR)) {
                editor.putBoolean(KEY_BUTTON_PHOTO_MFNR, coupled);
            }
            editor.remove(KEY_BUTTON_PHOTO_ZSL_MFNR);
            changed = true;
        }
        if (changed) {
            editor.commit();
            Log.i(TAG, "Migrated coupled ZSL/MFNR preferences to independent flags");
        }
    }
    
    /**
     * Get the video recording settings for button-initiated recording
     * @return VideoSettings with the saved resolution and fps
     */
    public VideoSettings getButtonVideoSettings() {
        int width = prefs.getInt(KEY_BUTTON_VIDEO_WIDTH, 1920);
        int height = prefs.getInt(KEY_BUTTON_VIDEO_HEIGHT, 1080);
        int fps = prefs.getInt(KEY_BUTTON_VIDEO_FPS, 30);
        VideoSettings settings = new VideoSettings(width, height, fps);
        Log.d(TAG, "Retrieved button video settings: " + settings);
        return settings;
    }
    
    /**
     * Set the video recording settings for button-initiated recording
     * @param settings VideoSettings to save
     */
    public void setButtonVideoSettings(VideoSettings settings) {
        if (settings == null) {
            Log.w(TAG, "Attempted to set null video settings, ignoring");
            return;
        }
        if (!settings.isValid()) {
            Log.w(TAG, "Attempted to set invalid video settings: " + settings + ", ignoring");
            return;
        }
        Log.d(TAG, "Setting button video settings to: " + settings);
        // Using commit() for immediate persistence
        prefs.edit()
            .putInt(KEY_BUTTON_VIDEO_WIDTH, settings.width)
            .putInt(KEY_BUTTON_VIDEO_HEIGHT, settings.height)
            .putInt(KEY_BUTTON_VIDEO_FPS, settings.fps)
            .commit();
    }
    
    /**
     * Set button video settings from width, height, and fps values
     * @param width Video width
     * @param height Video height
     * @param fps Video frame rate
     */
    public void setButtonVideoSettings(int width, int height, int fps) {
        VideoSettings settings = new VideoSettings(width, height, fps);
        setButtonVideoSettings(settings);
    }

    /**
     * Get the maximum recording time for button-initiated videos
     * @return Maximum recording time in minutes (default 10)
     */
    public int getButtonMaxRecordingTimeMinutes() {
        int minutes = prefs.getInt(KEY_BUTTON_MAX_RECORDING_TIME_MINUTES, 10);
        Log.d(TAG, "Retrieved button max recording time: " + minutes + " minutes");
        return minutes;
    }

    /**
     * Set the maximum recording time for button-initiated videos
     * @param minutes Maximum recording time in minutes (3, 5, 10, 15, or 20)
     */
    public void setButtonMaxRecordingTimeMinutes(int minutes) {
        // Validate minutes
        if (minutes != 3 && minutes != 5 && minutes != 10 && minutes != 15 && minutes != 20) {
            Log.w(TAG, "Invalid max recording time: " + minutes + " minutes, using 10 minutes");
            minutes = 10;
        }
        Log.d(TAG, "Setting button max recording time to: " + minutes + " minutes");
        // Using commit() for immediate persistence
        prefs.edit().putInt(KEY_BUTTON_MAX_RECORDING_TIME_MINUTES, minutes).commit();
    }

    /**
     * Get the photo size setting for button-initiated photos
     * @return Photo size ("low", "medium", "high", or "max")
     */
    public String getButtonPhotoSize() {
        String size = prefs.getString(KEY_BUTTON_PHOTO_SIZE, "max");
        size = PhotoSizeTier.normalize(size);
        Log.d(TAG, "Retrieved button photo size: " + size);
        return size;
    }
    
    /**
     * Set the photo size setting for button-initiated photos
     * @param size Photo size ("low", "medium", "high", or "max")
     */
    public void setButtonPhotoSize(String size) {
        size = PhotoSizeTier.normalize(size);
        if (!Arrays.asList("low", "medium", "high", "max").contains(size)) {
            Log.w(TAG, "Invalid photo size: " + size + ", using medium");
            size = "medium";
        }
        Log.d(TAG, "Setting button photo size to: " + size);
        // Using commit() for immediate persistence
        prefs.edit().putString(KEY_BUTTON_PHOTO_SIZE, size).commit();
    }
    
    /**
     * Get the camera FOV setting (K900). Supported range: 62-118 inclusive (118 = No ROI).
     * @return FOV in degrees (default 102)
     */
    public int getCameraFov() {
        int fov = prefs.getInt(KEY_CAMERA_FOV, DEFAULT_CAMERA_FOV);
        Log.d(TAG, "Retrieved camera FOV: " + fov);
        return fov;
    }

    /**
     * Get the camera ROI position setting (K900). 0=center, 1=bottom, 2=top.
     * @return ROI position (default 0)
     */
    public int getCameraRoiPosition() {
        int roi = prefs.getInt(KEY_CAMERA_ROI_POSITION, DEFAULT_CAMERA_ROI_POSITION);
        Log.d(TAG, "Retrieved camera ROI position: " + roi);
        return roi;
    }

    /**
     * Set the camera FOV and ROI position (K900). Caller should apply to hardware and restart camera HAL.
     * @param fov FOV value from 62-118 inclusive (118 = No ROI; otherwise default 102 is used)
     * @param roiPosition 0=center, 1=bottom, 2=top (clamped to [0,2]; ignored by HAL when fov is 118)
     */
    public void setCameraFov(int fov, int roiPosition) {
        if (fov < MIN_CAMERA_FOV || fov > MAX_CAMERA_FOV) {
            Log.w(TAG, "Invalid camera FOV: " + fov + ", using default " + DEFAULT_CAMERA_FOV);
            fov = DEFAULT_CAMERA_FOV;
        }
        if (roiPosition < 0 || roiPosition > 2) {
            Log.w(TAG, "Invalid camera ROI position: " + roiPosition + ", clamping to [0,2]");
            roiPosition = Math.max(0, Math.min(2, roiPosition));
        }
        Log.d(TAG, "Setting camera FOV to: " + fov + ", ROI position: " + roiPosition);
        prefs.edit()
            .putInt(KEY_CAMERA_FOV, fov)
            .putInt(KEY_CAMERA_ROI_POSITION, roiPosition)
            .commit();
    }
    
    /**
     * Check if currently in gallery mode (save/capture mode active)
     * Persisted state set by the phone when camera/gallery app is active
     * Defaults to true (take photos) - only false when connected to phone with no camera app running
     * @return true if in gallery mode, false otherwise
     */
    public boolean isSaveInGalleryMode() {
        boolean inGalleryMode = prefs.getBoolean(KEY_SAVE_IN_GALLERY_MODE, true);
        Log.d(TAG, "Retrieved save in gallery mode: " + inGalleryMode);
        return inGalleryMode;
    }

    /**
     * Set the gallery mode state
     * Called when phone notifies that camera/gallery app is active/inactive
     * Persisted to survive reboots
     * @param inGalleryMode true if gallery mode active, false otherwise
     */
    public void setSaveInGalleryMode(boolean inGalleryMode) {
        Log.d(TAG, "📸 Gallery mode state changed: " + (inGalleryMode ? "ACTIVE" : "INACTIVE"));
        // Using commit() for immediate persistence
        prefs.edit().putBoolean(KEY_SAVE_IN_GALLERY_MODE, inGalleryMode).commit();
    }

    /**
     * @return true when ZSL buffering should be enabled (default: {@link AsgConstants#DEFAULT_ZSL})
     */
    public boolean isZslEnabled() {
        if (!AsgConstants.ENABLE_ZSL) {
            return false;
        }
        boolean enabled = prefs.getBoolean(KEY_ZSL_ENABLED, AsgConstants.DEFAULT_ZSL);
        Log.d(TAG, "Retrieved ZSL enabled setting: " + enabled);
        return enabled;
    }

    /** Persist the ZSL device default. */
    public void setZslEnabled(boolean enabled) {
        Log.d(TAG, "Setting ZSL enabled to: " + enabled);
        prefs.edit().putBoolean(KEY_ZSL_ENABLED, enabled).commit();
    }

    /** @return true if {@link #KEY_ZSL_ENABLED} has been written (not just default). */
    public boolean hasZslPreference() {
        return prefs.contains(KEY_ZSL_ENABLED);
    }

    /**
     * @return true when vendor MFNR should be enabled (default: {@link AsgConstants#DEFAULT_MFNR})
     */
    public boolean isMfnrEnabled() {
        if (!AsgConstants.ENABLE_MFNR) {
            return false;
        }
        boolean enabled = prefs.getBoolean(KEY_MFNR_ENABLED, AsgConstants.DEFAULT_MFNR);
        Log.d(TAG, "Retrieved MFNR enabled setting: " + enabled);
        return enabled;
    }

    /** Persist the MFNR device default. */
    public void setMfnrEnabled(boolean enabled) {
        Log.d(TAG, "Setting MFNR enabled to: " + enabled);
        prefs.edit().putBoolean(KEY_MFNR_ENABLED, enabled).commit();
    }

    /** @return true if {@link #KEY_MFNR_ENABLED} has been written (not just default). */
    public boolean hasMfnrPreference() {
        return prefs.contains(KEY_MFNR_ENABLED);
    }

    /** Stored phone preset for button-photo MFNR; {@code null} if unset. */
    public Boolean getButtonPhotoMfnr() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_MFNR)) {
            return null;
        }
        return prefs.getBoolean(KEY_BUTTON_PHOTO_MFNR, true);
    }

    /** Persist or clear the button-photo MFNR override. */
    public void setButtonPhotoMfnr(Boolean enabled) {
        if (enabled == null) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_MFNR).commit();
            return;
        }
        Log.d(TAG, "Setting button photo MFNR to: " + enabled);
        prefs.edit().putBoolean(KEY_BUTTON_PHOTO_MFNR, enabled).commit();
    }

    /** Stored phone preset for button-photo ZSL; {@code null} if unset. */
    public Boolean getButtonPhotoZsl() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_ZSL)) {
            return null;
        }
        return prefs.getBoolean(KEY_BUTTON_PHOTO_ZSL, true);
    }

    /** Persist or clear the button-photo ZSL override. */
    public void setButtonPhotoZsl(Boolean enabled) {
        if (enabled == null) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_ZSL).commit();
            return;
        }
        Log.d(TAG, "Setting button photo ZSL to: " + enabled);
        prefs.edit().putBoolean(KEY_BUTTON_PHOTO_ZSL, enabled).commit();
    }

    /** Stored phone preset for noise reduction; {@code null} if unset. */
    public Boolean getButtonPhotoNoiseReduction() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_NOISE_REDUCTION)) {
            return null;
        }
        return prefs.getBoolean(KEY_BUTTON_PHOTO_NOISE_REDUCTION, true);
    }

    public void setButtonPhotoNoiseReduction(Boolean enabled) {
        if (enabled == null) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_NOISE_REDUCTION).commit();
            return;
        }
        Log.d(TAG, "Setting button photo noise reduction to: " + enabled);
        prefs.edit().putBoolean(KEY_BUTTON_PHOTO_NOISE_REDUCTION, enabled).commit();
    }

    /** Stored phone preset for edge enhancement; {@code null} if unset. */
    public Boolean getButtonPhotoEdgeEnhancement() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_EDGE_ENHANCEMENT)) {
            return null;
        }
        return prefs.getBoolean(KEY_BUTTON_PHOTO_EDGE_ENHANCEMENT, true);
    }

    public void setButtonPhotoEdgeEnhancement(Boolean enabled) {
        if (enabled == null) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_EDGE_ENHANCEMENT).commit();
            return;
        }
        Log.d(TAG, "Setting button photo edge enhancement to: " + enabled);
        prefs.edit().putBoolean(KEY_BUTTON_PHOTO_EDGE_ENHANCEMENT, enabled).commit();
    }

    /** Stored phone preset for ISP digital gain; {@code null} if unset. */
    public Integer getButtonPhotoIspDigitalGain() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_ISP_DIGITAL_GAIN)) {
            return null;
        }
        return prefs.getInt(KEY_BUTTON_PHOTO_ISP_DIGITAL_GAIN, 0);
    }

    public void setButtonPhotoIspDigitalGain(Integer gain) {
        if (gain == null) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_ISP_DIGITAL_GAIN).commit();
            return;
        }
        Log.d(TAG, "Setting button photo ISP digital gain to: " + gain);
        prefs.edit().putInt(KEY_BUTTON_PHOTO_ISP_DIGITAL_GAIN, gain).commit();
    }

    /** Stored phone preset for ISP analog gain; {@code null} if unset. */
    public String getButtonPhotoIspAnalogGain() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_ISP_ANALOG_GAIN)) {
            return null;
        }
        return prefs.getString(KEY_BUTTON_PHOTO_ISP_ANALOG_GAIN, "");
    }

    public void setButtonPhotoIspAnalogGain(String gain) {
        if (gain == null || gain.isEmpty()) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_ISP_ANALOG_GAIN).commit();
            return;
        }
        Log.d(TAG, "Setting button photo ISP analog gain to: " + gain);
        prefs.edit().putString(KEY_BUTTON_PHOTO_ISP_ANALOG_GAIN, gain).commit();
    }

    /** Stored phone preset for AE exposure divisor; {@code null} if unset. */
    public Integer getButtonPhotoAeExposureDivisor() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_AE_EXPOSURE_DIVISOR)) {
            return null;
        }
        int divisor = prefs.getInt(KEY_BUTTON_PHOTO_AE_EXPOSURE_DIVISOR, 0);
        return divisor > 1 ? divisor : null;
    }

    public void setButtonPhotoAeExposureDivisor(Integer divisor) {
        if (divisor == null || divisor <= 1) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_AE_EXPOSURE_DIVISOR).commit();
            return;
        }
        Log.d(TAG, "Setting button photo AE exposure divisor to: " + divisor);
        prefs.edit().putInt(KEY_BUTTON_PHOTO_AE_EXPOSURE_DIVISOR, divisor).commit();
    }

    /** Stored phone preset for ISO cap; {@code null} if unset. */
    public Integer getButtonPhotoIsoCap() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_ISO_CAP)) {
            return null;
        }
        int cap = prefs.getInt(KEY_BUTTON_PHOTO_ISO_CAP, 0);
        return cap > 0 ? cap : null;
    }

    public void setButtonPhotoIsoCap(Integer cap) {
        if (cap == null || cap <= 0) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_ISO_CAP).commit();
            return;
        }
        Log.d(TAG, "Setting button photo ISO cap to: " + cap);
        prefs.edit().putInt(KEY_BUTTON_PHOTO_ISO_CAP, cap).commit();
    }

    /** Stored phone preset for transfer compression; {@code null} if unset. */
    public String getButtonPhotoCompress() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_COMPRESS)) {
            return null;
        }
        return prefs.getString(KEY_BUTTON_PHOTO_COMPRESS, "none");
    }

    public void setButtonPhotoCompress(String compress) {
        if (compress == null || compress.isEmpty()) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_COMPRESS).commit();
            return;
        }
        Log.d(TAG, "Setting button photo compress to: " + compress);
        prefs.edit().putString(KEY_BUTTON_PHOTO_COMPRESS, compress).commit();
    }

    /** Stored phone preset for shutter sound; {@code null} if unset. */
    public Boolean getButtonPhotoSound() {
        if (!prefs.contains(KEY_BUTTON_PHOTO_SOUND)) {
            return null;
        }
        return prefs.getBoolean(KEY_BUTTON_PHOTO_SOUND, true);
    }

    public void setButtonPhotoSound(Boolean enabled) {
        if (enabled == null) {
            prefs.edit().remove(KEY_BUTTON_PHOTO_SOUND).commit();
            return;
        }
        Log.d(TAG, "Setting button photo sound to: " + enabled);
        prefs.edit().putBoolean(KEY_BUTTON_PHOTO_SOUND, enabled).commit();
    }

    /** Clears scan/button-photo tuning prefs without changing global ZSL or MFNR defaults. */
    public void clearButtonPhotoCaptureTuning() {
        Log.d(TAG, "Clearing button photo capture tuning");
        prefs.edit()
                .remove(KEY_BUTTON_PHOTO_NOISE_REDUCTION)
                .remove(KEY_BUTTON_PHOTO_EDGE_ENHANCEMENT)
                .remove(KEY_BUTTON_PHOTO_ISP_DIGITAL_GAIN)
                .remove(KEY_BUTTON_PHOTO_ISP_ANALOG_GAIN)
                .remove(KEY_BUTTON_PHOTO_AE_EXPOSURE_DIVISOR)
                .remove(KEY_BUTTON_PHOTO_ISO_CAP)
                .remove(KEY_BUTTON_PHOTO_COMPRESS)
                .remove(KEY_BUTTON_PHOTO_SOUND)
                .remove(KEY_BUTTON_PHOTO_MFNR)
                .remove(KEY_BUTTON_PHOTO_ZSL)
                .remove(KEY_BUTTON_PHOTO_ZSL_MFNR)
                .commit();
    }

    /**
     * Get the HDR burst capture setting
     * @return true if HDR burst should be enabled, false otherwise (default: true)
     */
    public boolean isHdrBurstEnabled() {
        return prefs.getBoolean(KEY_HDR_BURST_ENABLED, false);
    }

    /**
     * Set the HDR burst capture setting
     * @param enabled true to enable HDR burst, false to disable
     */
    public void setHdrBurstEnabled(boolean enabled) {
        Log.d(TAG, "Setting HDR burst enabled to: " + enabled);
        prefs.edit().putBoolean(KEY_HDR_BURST_ENABLED, enabled).commit();
    }

    /**
     * Get the MCU firmware version (cached from hs_syvr command)
     * @return MCU firmware version string, or empty string if not yet received
     * @deprecated Use getBesFirmwareVersion() for clarity - MCU refers to BES firmware
     */
    public String getMcuFirmwareVersion() {
        String version = prefs.getString(KEY_MCU_FIRMWARE_VERSION, "");
        Log.d(TAG, "Retrieved MCU firmware version: " + version);
        return version;
    }

    /**
     * Get the BES firmware version (cached from hs_syvr command)
     * This is an alias for getMcuFirmwareVersion() with clearer naming.
     * @return BES firmware version string (e.g., "17.26.1.14"), or empty string if not yet received
     */
    public String getBesFirmwareVersion() {
        return getMcuFirmwareVersion();
    }

    /**
     * Set the MCU firmware version (called when hs_syvr is received from MCU)
     * @param version MCU firmware version string
     * @deprecated Use setBesFirmwareVersion() for clarity - MCU refers to BES firmware
     */
    public void setMcuFirmwareVersion(String version) {
        if (version == null || version.isEmpty()) {
            Log.w(TAG, "Attempted to set empty MCU firmware version, ignoring");
            return;
        }
        Log.i(TAG, "📋 Setting MCU firmware version to: " + version);
        // Using commit() for immediate persistence
        prefs.edit().putString(KEY_MCU_FIRMWARE_VERSION, version).commit();
    }

    /**
     * Set the BES firmware version (called when hs_syvr is received from BES chipset)
     * This is an alias for setMcuFirmwareVersion() with clearer naming.
     * @param version BES firmware version string (e.g., "17.26.1.14")
     */
    public void setBesFirmwareVersion(String version) {
        setMcuFirmwareVersion(version);
    }

    /** Return the exact BES version field last used to evaluate fast-UART capability. */
    public String getBesBaudSwitchVersion() {
        return prefs.getString(KEY_BES_BAUD_SWITCH_VERSION, "");
    }

    /** Persist the exact BES version field used to evaluate fast-UART capability. */
    public void setBesBaudSwitchVersion(String version) {
        if (version == null || version.isEmpty()) {
            return;
        }
        prefs.edit().putString(KEY_BES_BAUD_SWITCH_VERSION, version).commit();
    }

    /**
     * Whether ANR (Adaptive Noise Reduction) is enabled for the camera HAL tuning.
     * Defaults to {@code true} (ANR on).
     */
    public boolean isCameraAnrEnabled() {
        return prefs.getBoolean(KEY_CAMERA_ANR_ENABLED, true);
    }

    public void setCameraAnrEnabled(boolean enabled) {
        Log.d(TAG, "Setting camera ANR enabled to: " + enabled);
        prefs.edit().putBoolean(KEY_CAMERA_ANR_ENABLED, enabled).commit();
    }

    /**
     * Whether the stock gain parameters are used for the camera HAL tuning.
     * {@code true} = stock gain on; {@code false} = pixsmart gain-off parameters.
     * Defaults to {@code true}.
     */
    public boolean isCameraGainEnabled() {
        return prefs.getBoolean(KEY_CAMERA_GAIN_ENABLED, true);
    }

    public void setCameraGainEnabled(boolean enabled) {
        Log.d(TAG, "Setting camera gain enabled to: " + enabled);
        prefs.edit().putBoolean(KEY_CAMERA_GAIN_ENABLED, enabled).commit();
    }
}
