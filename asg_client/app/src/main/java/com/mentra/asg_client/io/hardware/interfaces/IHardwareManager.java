package com.mentra.asg_client.io.hardware.interfaces;

/**
 * Interface for hardware management operations across different device types.
 * This interface abstracts hardware control operations to support different
 * implementations for different device types (K900, future models, etc).
 * 
 * Currently supports LED control, but designed to be extensible for other
 * hardware features like haptics, sensors, etc.
 */
public interface IHardwareManager {
    
    /**
     * Initialize the hardware manager and check device capabilities
     */
    void initialize();

    /**
     * Set the Bluetooth manager for RGB LED control
     * This should be called after initialize() to enable RGB LED functionality
     * @param bluetoothManager The Bluetooth manager instance
     */
    void setBluetoothManager(Object bluetoothManager);
    
    /**
     * Check if the device supports recording LED control
     * @return true if LED control is supported, false otherwise
     */
    boolean supportsRecordingLed();
    
    /**
     * Turn the recording LED on (solid)
     */
    void setRecordingLedOn();
    
    /**
     * Turn the recording LED off
     */
    void setRecordingLedOff();
    
    /**
     * Start the recording LED blinking with default pattern
     */
    void setRecordingLedBlinking();
    
    /**
     * Start the recording LED blinking with custom pattern
     * @param onDurationMs Duration in milliseconds for LED on state
     * @param offDurationMs Duration in milliseconds for LED off state
     */
    void setRecordingLedBlinking(long onDurationMs, long offDurationMs);
    
    /**
     * Stop the recording LED blinking (turns LED off)
     */
    void stopRecordingLedBlinking();
    
    /**
     * Flash the recording LED once for a specified duration
     * @param durationMs Duration in milliseconds to keep LED on
     */
    void flashRecordingLed(long durationMs);

    /**
     * Check if the recording LED is currently on (solid or blinking)
     * @return true if LED is on or blinking, false if off
     */
    boolean isRecordingLedOn();

    /**
     * Check if the recording LED is currently blinking
     * @return true if LED is blinking, false otherwise
     */
    boolean isRecordingLedBlinking();
    
    /**
     * Get the device model identifier
     * @return String identifying the device model (e.g., "K900", "GENERIC")
     */
    String getDeviceModel();
    
    /**
     * Check if this is a K900 device
     * @return true if running on K900 hardware, false otherwise
     */
    boolean isK900Device();

    /**
     * Check whether this hardware supports audio playback through the MCU.
     * @return true if audio playback helpers are available.
     */
    boolean supportsAudioPlayback();

    /**
     * Play an audio asset routed through the device-specific audio path (e.g. I2S).
     * @param assetName Name of the asset in the application's assets directory
     */
    void playAudioAsset(String assetName);

    /**
     * Stop any active MCU-managed audio playback.
     */
    void stopAudioPlayback();

    /**
     * Release any resources held by the hardware manager
     */
    void shutdown();

    // ============================================
    // Battery Status
    // ============================================

    /**
     * Get the current battery level.
     * On K900 devices, this may query BES if cache is stale (>2 min), with 50ms timeout.
     * On standard Android devices, uses BatteryManager API directly.
     * @return Battery level percentage (0-100), or -1 if unknown
     */
    int getBatteryLevel();

    /**
     * Get the current charging status.
     * On K900 devices, this may query BES if cache is stale (>2 min), with 50ms timeout.
     * On standard Android devices, uses BatteryManager API directly.
     * @return true if charging, false if not charging or unknown
     */
    boolean getChargingStatus();

    // ============================================
    // MTK LED Brightness Control
    // ============================================

    /**
     * Check if the device supports LED brightness control
     * @return true if brightness control is supported, false otherwise
     */
    boolean supportsLedBrightness();

    /**
     * Set the recording LED brightness level
     * @param percent Brightness level from 0-100%
     */
    void setRecordingLedBrightness(int percent);

    /**
     * Set the recording LED brightness level with duration
     * @param percent Brightness level from 0-100%
     * @param durationMs Duration in milliseconds to show at this brightness
     */
    void setRecordingLedBrightness(int percent, int durationMs);

    /**
     * Get the current recording LED brightness level
     * @return Current brightness level 0-100%
     */
    int getRecordingLedBrightness();

    // ============================================
    // RGB LED Control (BES Chipset)
    // ============================================

    /**
     * Check if the device supports RGB LED control
     * @return true if RGB LED control is supported, false otherwise
     */
    boolean supportsRgbLed();

    /**
     * Set RGB LED brightness level
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void setRgbLedBrightness(int brightness);

    /**
     * Turn on a specific RGB LED with custom timing pattern (default full brightness)
     * @param ledIndex LED color index (0=red, 1=green, 2=blue, 3=orange, 4=white)
     * @param ontime Duration in milliseconds for LED on state
     * @param offtime Duration in milliseconds for LED off state
     * @param count Number of on/off cycles (0 = infinite)
     */
    void setRgbLedOn(int ledIndex, int ontime, int offtime, int count);

    /**
     * Turn on a specific RGB LED with custom timing pattern and brightness
     * @param ledIndex LED color index (0=red, 1=green, 2=blue, 3=orange, 4=white)
     * @param ontime Duration in milliseconds for LED on state
     * @param offtime Duration in milliseconds for LED off state
     * @param count Number of on/off cycles (0 = infinite)
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void setRgbLedOn(int ledIndex, int ontime, int offtime, int count, int brightness);

    /**
     * Turn off all RGB LEDs
     */
    void setRgbLedOff();

    /**
     * Flash the white RGB LED for photo capture (default full brightness)
     * @param durationMs Duration in milliseconds for the flash
     */
    void flashRgbLedWhite(int durationMs);

    /**
     * Flash the white RGB LED for photo capture with specified brightness
     * @param durationMs Duration in milliseconds for the flash
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void flashRgbLedWhite(int durationMs, int brightness);

    /**
     * Set the white RGB LED to solid on for video recording (default full brightness)
     * @param durationMs Duration in milliseconds to keep LED on
     */
    void setRgbLedSolidWhite(int durationMs);

    /**
     * Set the white RGB LED to solid on for video recording with specified brightness
     * @param durationMs Duration in milliseconds to keep LED on
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    void setRgbLedSolidWhite(int durationMs, int brightness);
}
