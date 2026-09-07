package com.mentra.asg_client.io.hardware.interfaces;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;

import java.util.Set;

/**
 * Interface for hardware management operations across different device types. This interface
 * abstracts hardware control operations to support different implementations for different device
 * types (K900, future models, etc).
 *
 * <p>Currently supports LED control, but designed to be extensible for other hardware features like
 * haptics, sensors, etc.
 */
public interface IHardwareManager {

    /** Initialize the hardware manager and check device capabilities */
    void initialize();

    /** Capabilities supported on this device. */
    Set<Capability> getCapabilities();

    /**
     * Wire companion transport for RGB LED commands (UART on Mentra Live). Call after {@link
     * #initialize()}.
     */
    void setTransport(ICompanionTransport transport);

    /**
     * Check if the device supports recording LED control
     *
     * @return true if LED control is supported, false otherwise
     */
    boolean supportsRecordingLed();

    /** Turn the recording LED on (solid) */
    void setRecordingLedOn();

    /** Turn the recording LED off */
    void setRecordingLedOff();

    /** Start the recording LED blinking with default pattern */
    void setRecordingLedBlinking();

    /**
     * Start the recording LED blinking with custom pattern
     *
     * @param onDurationMs Duration in milliseconds for LED on state
     * @param offDurationMs Duration in milliseconds for LED off state
     */
    void setRecordingLedBlinking(long onDurationMs, long offDurationMs);

    /** Stop the recording LED blinking (turns LED off) */
    void stopRecordingLedBlinking();

    /**
     * Flash the recording LED once for a specified duration
     *
     * @param durationMs Duration in milliseconds to keep LED on
     */
    void flashRecordingLed(long durationMs);

    /**
     * Check if the recording LED is currently on (solid or blinking)
     *
     * @return true if LED is on or blinking, false if off
     */
    boolean isRecordingLedOn();

    /**
     * Check if the recording LED is currently blinking
     *
     * @return true if LED is blinking, false otherwise
     */
    boolean isRecordingLedBlinking();

    /**
     * Get the device model identifier
     *
     * @return String identifying the device model (e.g., "K900", "GENERIC")
     */
    String getDeviceModel();

    /**
     * Check whether this hardware supports audio playback through the MCU.
     *
     * @return true if audio playback helpers are available.
     */
    boolean supportsAudioPlayback();

    /**
     * Play an audio asset routed through the device-specific audio path (e.g. I2S).
     *
     * @param assetName Name of the asset in the application's assets directory
     */
    void playAudioAsset(String assetName);

    /**
     * Play a primary audio asset and return a token identifying that exact playback.
     *
     * <p>Implementations that do not support tracked playback return {@code 0}.
     *
     * @param assetName Name of the asset in the application's assets directory
     * @return a positive playback token, or {@code 0} when tracking is unavailable
     */
    default long playAudioAssetTracked(String assetName) {
        playAudioAsset(assetName);
        return 0L;
    }

    /**
     * Replace the primary audio only when {@code playbackToken} still owns it.
     *
     * @return {@code true} when the asset was replaced
     */
    default boolean replaceAudioAssetIfCurrent(long playbackToken, String assetName) {
        return false;
    }

    /**
     * Play a short asset without replacing the primary audio cue.
     *
     * <p>The default preserves legacy behavior for hardware without overlay support.
     */
    default void playAudioAssetOverlay(String assetName) {
        playAudioAsset(assetName);
    }

    /**
     * Play a short asset at an explicit linear gain without replacing the primary audio cue.
     *
     * <p>The default preserves legacy behavior for hardware without volume control.
     *
     * @param assetName Name of the asset in the application's assets directory
     * @param playbackVolume Linear gain from {@code 0.0f} (silent) to {@code 1.0f} (full scale)
     */
    default void playAudioAssetOverlay(String assetName, float playbackVolume) {
        playAudioAssetOverlay(assetName);
    }

    /**
     * Play an independently stoppable overlay without replacing primary audio.
     *
     * @return a positive overlay token, or {@code 0} when tracking is unavailable
     */
    default long playAudioAssetOverlayTracked(String assetName) {
        playAudioAssetOverlay(assetName);
        return 0L;
    }

    /**
     * Play an independently stoppable overlay at an explicit linear gain.
     *
     * @return a positive overlay token, or {@code 0} when tracking is unavailable
     */
    default long playAudioAssetOverlayTracked(String assetName, float playbackVolume) {
        playAudioAssetOverlay(assetName, playbackVolume);
        return 0L;
    }

    /** Stop only the overlay identified by {@code playbackToken}. */
    default boolean stopAudioOverlayPlayback(long playbackToken) {
        return false;
    }

    /** Stop any active MCU-managed audio playback. */
    void stopAudioPlayback();

    /**
     * Stop primary audio only when {@code playbackToken} still owns it.
     *
     * @return {@code true} when the owned playback was stopped
     */
    default boolean stopAudioPlaybackIfCurrent(long playbackToken) {
        return false;
    }

    /**
     * Play a local audio file as one MCU I2S job. Used for stitched pairing-code phrases.
     *
     * @return {@code true} when playback was started
     */
    default boolean playAudioFile(java.io.File file) {
        return false;
    }

    /** Release any resources held by the hardware manager */
    void shutdown();

    // ============================================
    // Battery Status
    // ============================================

    /**
     * Get the current battery level without waiting for external hardware. K900 implementations
     * may trigger an asynchronous cache refresh when stale. Standard Android devices use
     * BatteryManager directly.
     *
     * @return Battery level percentage (0-100), or -1 if unknown
     */
    int getBatteryLevel();

    /**
     * Actively refresh and return the battery level. Implementations that query external hardware
     * may block, so callers must use a worker thread. Implementations without an external battery
     * source fall back to {@link #getBatteryLevel()}.
     */
    default int queryBatteryLevel() {
        return getBatteryLevel();
    }

    /**
     * Get the current charging status without waiting for external hardware. K900 implementations
     * may trigger an asynchronous cache refresh when stale. Standard Android devices use
     * BatteryManager directly.
     *
     * @return true if charging, false if not charging or unknown
     */
    boolean getChargingStatus();

    /**
     * Update cached battery readings from an MCU notification (e.g. hm_batv). No-op when {@link
     * Capability#MCU_BATTERY} is not supported.
     */
    void notifyBatteryReading(int percent, int voltageMv);

    /** Receive device-reported active charging, timestamped at UART receipt (elapsed realtime). */
    default void notifyBatteryReading(
            int percent, int voltageMv, boolean activeCharging, long receivedAtElapsedMs) {
        notifyBatteryReading(percent, voltageMv);
    }

    /** Grant only a known above-floor battery sample with fresh, verified active charging. */
    default boolean allowsLowBatteryCamera(int batteryLevel) {
        return false;
    }

    // ============================================
    // MTK LED Brightness Control
    // ============================================

    /**
     * Check if the device supports LED brightness control
     *
     * @return true if brightness control is supported, false otherwise
     */
    boolean supportsLedBrightness();

    /**
     * Set the recording LED brightness level
     *
     * @param percent Brightness level from 0-100%
     */
    void setRecordingLedBrightness(int percent);

    /**
     * Set the recording LED brightness level with duration
     *
     * @param percent Brightness level from 0-100%
     * @param durationMs Duration in milliseconds to show at this brightness
     */
    void setRecordingLedBrightness(int percent, int durationMs);

    /**
     * Get the current recording LED brightness level
     *
     * @return Current brightness level 0-100%
     */
    int getRecordingLedBrightness();

    // ============================================
    // RGB LED Control (BES Chipset)
    // ============================================

    /**
     * Check if the device supports RGB LED control
     *
     * @return true if RGB LED control is supported, false otherwise
     */
    boolean supportsRgbLed();

    /**
     * Set RGB LED brightness level
     *
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void setRgbLedBrightness(int brightness);

    /**
     * Turn on a specific RGB LED with custom timing pattern (default full brightness)
     *
     * @param ledIndex LED color index (0=red, 1=green, 2=blue, 3=orange, 4=white)
     * @param ontime Duration in milliseconds for LED on state
     * @param offtime Duration in milliseconds for LED off state
     * @param count Number of on/off cycles (0 = infinite)
     */
    void setRgbLedOn(int ledIndex, int ontime, int offtime, int count);

    /**
     * Turn on a specific RGB LED with custom timing pattern and brightness
     *
     * @param ledIndex LED color index (0=red, 1=green, 2=blue, 3=orange, 4=white)
     * @param ontime Duration in milliseconds for LED on state
     * @param offtime Duration in milliseconds for LED off state
     * @param count Number of on/off cycles (0 = infinite)
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void setRgbLedOn(int ledIndex, int ontime, int offtime, int count, int brightness);

    /** Turn off all RGB LEDs */
    void setRgbLedOff();

    /**
     * Flash the white RGB LED for photo capture (default full brightness)
     *
     * @param durationMs Duration in milliseconds for the flash
     */
    void flashRgbLedWhite(int durationMs);

    /**
     * Flash the white RGB LED for photo capture with specified brightness
     *
     * @param durationMs Duration in milliseconds for the flash
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void flashRgbLedWhite(int durationMs, int brightness);

    /**
     * Set the white RGB LED to solid on for video recording (default full brightness)
     *
     * @param durationMs Duration in milliseconds to keep LED on
     */
    void setRgbLedSolidWhite(int durationMs);

    /**
     * Set the white RGB LED to solid on for video recording with specified brightness
     *
     * @param durationMs Duration in milliseconds to keep LED on
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void setRgbLedSolidWhite(int durationMs, int brightness);
}
