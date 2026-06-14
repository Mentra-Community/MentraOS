package com.mentra.asg_client.settings;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.util.Log;

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
    private static final String KEY_BUTTON_CAMERA_LED = "button_camera_led";
    private static final String KEY_SAVE_IN_GALLERY_MODE = "save_in_gallery_mode";
    private static final String KEY_ZSL_ENABLED = "zsl_enabled";
    private static final String KEY_MFNR_ENABLED = "mfnr_enabled";
    private static final String KEY_HDR_BURST_ENABLED = "hdr_burst_enabled";
    private static final String KEY_MCU_FIRMWARE_VERSION = "mcu_firmware_version";
    /**
     * Boot stamp (approx. wall-clock time of last device boot) recorded alongside the BES firmware
     * version. Lets us tell whether the cached version was refreshed from the chip during the
     * current boot, or carried over from a previous boot (when the chip may have been
     * reflashed/downgraded while powered off — see the stale-cache OTA bug).
     */
    private static final String KEY_BES_FW_BOOT_STAMP = "bes_fw_boot_stamp";
    /**
     * Tolerance when comparing the stored boot stamp to the current one. Generous enough to absorb
     * NTP/clock corrections within a single boot, while a reboot shifts the stamp by the entire
     * previous uptime (far more than this), so reboots are reliably detected. Biased toward
     * treating ambiguous cases as stale (fail-safe: re-request + offer update).
     */
    private static final long BES_FW_BOOT_STAMP_TOLERANCE_MS = 10_000L;
    private static final String KEY_CAMERA_FOV = "camera_fov";
    private static final String KEY_CAMERA_ROI_POSITION = "camera_roi_position";

    /** Supported FOV range for K900 camera, inclusive (118 = No ROI) */
    private static final int MIN_CAMERA_FOV = 62;
    private static final int MAX_CAMERA_FOV = 118;
    private static final int DEFAULT_CAMERA_FOV = 118; // No ROI
    private static final int DEFAULT_CAMERA_ROI_POSITION = 0; // ROI_POSITION_CENTER

    private final SharedPreferences prefs;
    private final Context context;
    
    public AsgSettings(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        Log.d(TAG, "AsgSettings initialized");
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
     * @return Photo size ("small", "medium", "large", or "max")
     */
    public String getButtonPhotoSize() {
        String size = prefs.getString(KEY_BUTTON_PHOTO_SIZE, "large");
        Log.d(TAG, "Retrieved button photo size: " + size);
        return size;
    }
    
    /**
     * Set the photo size setting for button-initiated photos
     * @param size Photo size ("small", "medium", "large", or "max")
     */
    public void setButtonPhotoSize(String size) {
        // Validate size
        if (!Arrays.asList("small", "medium", "large", "max").contains(size)) {
            Log.w(TAG, "Invalid photo size: " + size + ", using medium");
            size = "medium";
        }
        Log.d(TAG, "Setting button photo size to: " + size);
        // Using commit() for immediate persistence
        prefs.edit().putString(KEY_BUTTON_PHOTO_SIZE, size).commit();
    }
    
    /**
     * Get the camera LED setting for button-initiated recordings
     * @return true if LED should be enabled, false otherwise
     */
    public boolean getButtonCameraLedEnabled() {
        boolean enabled = prefs.getBoolean(KEY_BUTTON_CAMERA_LED, true); // Default to true
        Log.d(TAG, "Retrieved button camera LED setting: " + enabled);
        return enabled;
    }
    
    /**
     * Set the camera LED setting for button-initiated recordings
     * @param enabled true to enable LED, false to disable
     */
    public void setButtonCameraLedEnabled(boolean enabled) {
        Log.d(TAG, "Setting button camera LED to: " + enabled);
        // Using commit() for immediate persistence
        prefs.edit().putBoolean(KEY_BUTTON_CAMERA_LED, enabled).commit();
    }

    /**
     * Get the camera FOV setting (K900). Supported range: 62-118 inclusive (118 = No ROI).
     * @return FOV in degrees (default 118 = No ROI)
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
     * @param fov FOV value from 62-118 inclusive (118 = No ROI; otherwise default 118 is used)
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
     * Get the ZSL (Zero Shutter Lag) setting
     * @return true if ZSL should be enabled, false otherwise (default: true)
     */
    public boolean isZslEnabled() {
        boolean enabled = prefs.getBoolean(KEY_ZSL_ENABLED, true);
        Log.d(TAG, "Retrieved ZSL enabled setting: " + enabled);
        return enabled;
    }

    /**
     * Set the ZSL (Zero Shutter Lag) setting
     * @param enabled true to enable ZSL, false to disable
     */
    public void setZslEnabled(boolean enabled) {
        Log.d(TAG, "Setting ZSL enabled to: " + enabled);
        // Using commit() for immediate persistence
        prefs.edit().putBoolean(KEY_ZSL_ENABLED, enabled).commit();
    }

    /**
     * Get the MFNR (Multi-Frame Noise Reduction) setting
     * @return true if MFNR should be enabled, false otherwise (default: true)
     */
    public boolean isMfnrEnabled() {
        boolean enabled = prefs.getBoolean(KEY_MFNR_ENABLED, true);
        Log.d(TAG, "Retrieved MFNR enabled setting: " + enabled);
        return enabled;
    }

    /**
     * Set the MFNR (Multi-Frame Noise Reduction) setting
     * @param enabled true to enable MFNR, false to disable
     */
    public void setMfnrEnabled(boolean enabled) {
        Log.d(TAG, "Setting MFNR enabled to: " + enabled);
        // Using commit() for immediate persistence
        prefs.edit().putBoolean(KEY_MFNR_ENABLED, enabled).commit();
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
        // A value cached before this boot has not been confirmed against the live chip and may be
        // stale (e.g. the BES was downgraded while powered off). Report it as unknown so OTA checks
        // — both here and on the phone — fail safe toward "update needed" instead of trusting it.
        if (!version.isEmpty() && !isBesVersionFromThisBoot()) {
            Log.w(
                    TAG,
                    "⏳ BES firmware version '"
                            + version
                            + "' was cached before this boot and has not been refreshed from the"
                            + " chip (sh_syvr/sr_syvr) — reporting as unknown until refreshed");
            return "";
        }
        Log.d(TAG, "Retrieved MCU firmware version: " + version);
        return version;
    }

    /** Approximate wall-clock time of the last boot; stable within a boot, jumps across reboots. */
    private static long currentBootStamp() {
        return System.currentTimeMillis() - SystemClock.elapsedRealtime();
    }

    /**
     * @return true if the cached BES firmware version was written during the current boot (and is
     *     therefore trustworthy), false if it predates this boot or was never set.
     */
    private boolean isBesVersionFromThisBoot() {
        long storedStamp = prefs.getLong(KEY_BES_FW_BOOT_STAMP, Long.MIN_VALUE);
        if (storedStamp == Long.MIN_VALUE) {
            return false;
        }
        return Math.abs(storedStamp - currentBootStamp()) <= BES_FW_BOOT_STAMP_TOLERANCE_MS;
    }

    /**
     * @return true if a BES firmware version has been refreshed from the chip during the current
     *     boot. Callers (e.g. the syvr request retry loop) use this to know when the handshake has
     *     succeeded and the cache can be trusted.
     */
    public boolean hasFreshBesFirmwareVersion() {
        return !prefs.getString(KEY_MCU_FIRMWARE_VERSION, "").isEmpty() && isBesVersionFromThisBoot();
    }

    /**
     * @return the last cached BES firmware version regardless of boot age (may be stale). For
     *     logging/telemetry only — never feed this into an OTA decision; use {@link
     *     #getBesFirmwareVersion()} which fails safe on stale values.
     */
    public String getCachedBesFirmwareVersionRaw() {
        return prefs.getString(KEY_MCU_FIRMWARE_VERSION, "");
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
        // Stamp with the current boot so reads this boot are trusted; reads after the next reboot
        // (until the chip is re-queried) fall back to "unknown". Using commit() for immediate
        // persistence.
        prefs.edit()
                .putString(KEY_MCU_FIRMWARE_VERSION, version)
                .putLong(KEY_BES_FW_BOOT_STAMP, currentBootStamp())
                .commit();
    }

    /**
     * Set the BES firmware version (called when hs_syvr is received from BES chipset)
     * This is an alias for setMcuFirmwareVersion() with clearer naming.
     * @param version BES firmware version string (e.g., "17.26.1.14")
     */
    public void setBesFirmwareVersion(String version) {
        setMcuFirmwareVersion(version);
    }
}