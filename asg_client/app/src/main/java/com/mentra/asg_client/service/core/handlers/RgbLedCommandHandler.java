package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Handles RGB LED control commands for smart glasses. Routes commands through the hardware manager
 * abstraction layer.
 *
 * <p>NOTE: This controls the RGB LEDs on the GLASSES themselves, NOT the local MTK recording LED.
 * For local MTK LED control, use the hardware manager's recording LED methods.
 *
 * <p>This handler focuses on command parsing, validation, and routing to the appropriate hardware
 * manager implementation. Device-specific LED control logic is handled by the hardware manager
 * (e.g., K900HardwareManager).
 *
 * <p>Follows SOLID Principles: - Single Responsibility: Handles only RGB LED command parsing and
 * routing - Open/Closed: Extensible for new RGB LED patterns - Liskov Substitution: Implements
 * ICommandHandler interface - Interface Segregation: Uses focused ICommandHandler interface -
 * Dependency Inversion: Depends on IHardwareManager abstraction
 */
public class RgbLedCommandHandler implements ICommandHandler {
    private static final String TAG = "RgbLedCommandHandler";

    // Command types from phone (for RGB LEDs on glasses)
    private static final String CMD_RGB_LED_CONTROL_ON = "rgb_led_control_on";
    private static final String CMD_RGB_LED_CONTROL_OFF = "rgb_led_control_off";
    private static final String CMD_RGB_LED_PHOTO_FLASH = "rgb_led_photo_flash";
    private static final String CMD_RGB_LED_VIDEO_SOLID = "rgb_led_video_solid";

    private final AsgClientServiceManager serviceManager;
    private final IHardwareManager hardwareManager;

    public RgbLedCommandHandler(
            AsgClientServiceManager serviceManager, IHardwareManager hardwareManager) {
        this.serviceManager = serviceManager;
        this.hardwareManager = hardwareManager;

        Log.d(TAG, "🚨 RGB LED Command Handler constructed (hardware manager ready)");
        Log.d(
                TAG,
                "🔧 Note: Bluetooth Manager will be initialized later via initializeBluetoothManager()");
    }

    /**
     * Initialize Bluetooth Manager for RGB LED control. Called after BluetoothManager is ready in
     * the service lifecycle. This uses deferred initialization pattern to handle initialization
     * ordering.
     */
    public void initializeBluetoothManager() {
        Log.d(TAG, "🔧 initializeBluetoothManager() called");

        if (hardwareManager != null && serviceManager.getBluetoothManager() != null) {
            Log.d(TAG, "🚨 Setting Bluetooth Manager for RGB LED control");
            hardwareManager.setTransport(serviceManager.getBluetoothManager());
            Log.i(TAG, "✅ Bluetooth Manager set for RGB LED control - READY FOR OPERATIONS");
        } else {
            Log.w(
                    TAG,
                    "⚠️ Cannot set Bluetooth Manager - hardwareManager: "
                            + (hardwareManager != null ? "valid" : "null")
                            + ", bluetoothManager: "
                            + (serviceManager.getBluetoothManager() != null ? "valid" : "null"));
        }
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of(
                CMD_RGB_LED_CONTROL_ON,
                CMD_RGB_LED_CONTROL_OFF,
                CMD_RGB_LED_PHOTO_FLASH,
                CMD_RGB_LED_VIDEO_SOLID);
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        Log.i(TAG, "🚨 Handling RGB LED command: " + commandType);

        // Check if RGB LED is supported on this device
        if (hardwareManager == null || !hardwareManager.supportsRgbLed()) {
            Log.w(TAG, "⚠️ RGB LED not supported on this device");
            sendErrorResponse("RGB LED not supported on this device");
            return false;
        }

        try {
            switch (commandType) {
                case CMD_RGB_LED_CONTROL_ON:
                    return handleRgbLedOn(data);

                case CMD_RGB_LED_CONTROL_OFF:
                    return handleRgbLedOff(data);

                case CMD_RGB_LED_PHOTO_FLASH:
                    return handlePhotoFlash(data);

                case CMD_RGB_LED_VIDEO_SOLID:
                    return handleVideoSolid(data);

                default:
                    Log.w(TAG, "⚠️ Unknown RGB LED command type: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling RGB LED command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle RGB LED ON command with timing parameters.
     *
     * <p>Expected data format: { "led": 0-4, // RGB LED index (0=red, 1=green, 2=blue, 3=orange,
     * 4=white) "ontime": 1000, // RGB LED on duration in milliseconds "offtime": 1000, // RGB LED
     * off duration in milliseconds "count": 5, // Number of on/off cycles "brightness": 100 //
     * Brightness level (0-255, optional, default DEFAULT_RGB_LED_BRIGHTNESS) }
     */
    private boolean handleRgbLedOn(JSONObject data) {
        Log.d(TAG, "🚨 Processing RGB LED ON command");

        try {
            // Extract parameters with defaults
            int led = data.optInt("led", RgbLedConstants.LED_RED);
            int ontime = data.optInt("ontime", 1000);
            int offtime = data.optInt("offtime", 1000);
            int count = data.optInt("count", 1);
            int brightness = data.optInt("brightness", RgbLedConstants.DEFAULT_BRIGHTNESS);

            // Validate parameters
            if (led < RgbLedConstants.LED_RED || led > RgbLedConstants.LED_WHITE) {
                Log.e(TAG, "❌ Invalid RGB LED index: " + led + " (must be 0-4)");
                sendErrorResponse("Invalid RGB LED index: " + led);
                return false;
            }

            if (ontime < 0 || offtime < 0 || count < 0) {
                Log.e(
                        TAG,
                        "❌ Invalid timing parameters: ontime="
                                + ontime
                                + ", offtime="
                                + offtime
                                + ", count="
                                + count);
                sendErrorResponse("Invalid timing parameters");
                return false;
            }

            if (brightness < 0 || brightness > 255) {
                Log.e(TAG, "❌ Invalid brightness value: " + brightness + " (must be 0-255)");
                sendErrorResponse("Invalid brightness value: " + brightness);
                return false;
            }

            Log.i(
                    TAG,
                    String.format(
                            "🚨 💡 RGB LED ON - LED: %d, OnTime: %dms, OffTime: %dms, Cycles: %d, Brightness: %d",
                            led, ontime, offtime, count, brightness));

            // Route to hardware manager
            hardwareManager.setRgbLedOn(led, ontime, offtime, count, brightness);

            Log.i(TAG, "✅ RGB LED ON command sent via hardware manager");
            sendSuccessResponse(CMD_RGB_LED_CONTROL_ON);
            return true;

        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling RGB LED ON command", e);
            sendErrorResponse("Failed to execute RGB LED command");
            return false;
        }
    }

    /** Handle RGB LED OFF command. Turns off all active RGB LEDs. */
    private boolean handleRgbLedOff(JSONObject data) {
        Log.d(TAG, "🚨 Processing RGB LED OFF command");

        try {
            Log.i(TAG, "🚨 🔴 RGB LED OFF");

            // Route to hardware manager
            hardwareManager.setRgbLedOff();

            Log.i(TAG, "✅ RGB LED OFF command sent via hardware manager");
            sendSuccessResponse(CMD_RGB_LED_CONTROL_OFF);
            return true;

        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling RGB LED OFF command", e);
            sendErrorResponse("Failed to execute RGB LED command");
            return false;
        }
    }

    /**
     * Handle photo flash LED command - white flash for photo capture.
     *
     * <p>Expected data format: { "duration": 5000, // Flash duration in milliseconds (optional,
     * default 5000ms) "brightness": 100 // Brightness level (0-255, optional, default
     * DEFAULT_RGB_LED_BRIGHTNESS) }
     */
    private boolean handlePhotoFlash(JSONObject data) {
        Log.d(TAG, "📸 Processing photo flash LED command");

        try {
            // Extract flash duration and brightness with defaults
            int duration = data.optInt("duration", 5000); // Default 5 sec flash
            int brightness = data.optInt("brightness", RgbLedConstants.DEFAULT_BRIGHTNESS);

            // Validate brightness
            if (brightness < 0 || brightness > 255) {
                Log.e(TAG, "❌ Invalid brightness value: " + brightness + " (must be 0-255)");
                sendErrorResponse("Invalid brightness value: " + brightness);
                return false;
            }

            Log.i(
                    TAG,
                    String.format(
                            "📸 ⚪ Photo flash LED (WHITE) - Duration: %dms, Brightness: %d",
                            duration, brightness));

            // Route to hardware manager
            hardwareManager.flashRgbLedWhite(duration, brightness);

            Log.i(TAG, "✅ Photo flash LED command sent via hardware manager");
            sendSuccessResponse(CMD_RGB_LED_PHOTO_FLASH);
            return true;

        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling photo flash LED command", e);
            sendErrorResponse("Failed to execute photo flash command");
            return false;
        }
    }

    /**
     * Handle video solid LED command - solid white LED for video recording.
     *
     * <p>Expected data format: { "brightness": 100 // Brightness level (0-255, optional, default
     * DEFAULT_RGB_LED_BRIGHTNESS) }
     */
    private boolean handleVideoSolid(JSONObject data) {
        Log.d(TAG, "🎥 Processing video recording LED command");

        try {
            // Extract brightness with default
            int brightness = data.optInt("brightness", RgbLedConstants.DEFAULT_BRIGHTNESS);

            // Validate brightness
            if (brightness < 0 || brightness > 255) {
                Log.e(TAG, "❌ Invalid brightness value: " + brightness + " (must be 0-255)");
                sendErrorResponse("Invalid brightness value: " + brightness);
                return false;
            }

            Log.i(
                    TAG,
                    String.format(
                            "🎥 ⚪ Video recording LED - Solid WHITE, Brightness: %d", brightness));

            // Route to hardware manager (30 minute duration, manually turned off when recording
            // stops)
            hardwareManager.setRgbLedSolidWhite(1800000, brightness);

            Log.i(TAG, "✅ Video recording LED command sent via hardware manager");
            sendSuccessResponse(CMD_RGB_LED_VIDEO_SOLID);
            return true;

        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling video recording LED command", e);
            sendErrorResponse("Failed to execute video recording LED command");
            return false;
        }
    }

    /** Send success response back to phone. */
    private void sendSuccessResponse(String commandType) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", commandType + "_response");
            response.put("success", true);
            response.put("timestamp", System.currentTimeMillis());

            if (serviceManager != null
                    && serviceManager.getBluetoothManager() != null
                    && serviceManager.getBluetoothManager().isConnected()) {
                serviceManager
                        .getBluetoothManager()
                        .sendMessage(response.toString().getBytes(StandardCharsets.UTF_8));
                Log.d(TAG, "✅ Success response sent to phone");
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating success response", e);
        }
    }

    /** Send error response back to phone. */
    private void sendErrorResponse(String errorMessage) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "rgb_led_control_error");
            response.put("success", false);
            response.put("error", errorMessage);
            response.put("timestamp", System.currentTimeMillis());

            if (serviceManager != null
                    && serviceManager.getBluetoothManager() != null
                    && serviceManager.getBluetoothManager().isConnected()) {
                serviceManager
                        .getBluetoothManager()
                        .sendMessage(response.toString().getBytes(StandardCharsets.UTF_8));
                Log.d(TAG, "⚠️ Error response sent to phone");
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating error response", e);
        }
    }
}
