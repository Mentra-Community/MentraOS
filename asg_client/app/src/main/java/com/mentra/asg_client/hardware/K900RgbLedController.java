package com.mentra.asg_client.hardware;

import android.util.Log;

import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * Controller for RGB LED operations on K900 smart glasses (BES chipset).
 * Handles communication with the glasses via Bluetooth using K900 protocol.
 *
 * This controls the RGB LEDs on the GLASSES themselves via Bluetooth,
 * NOT the local MTK recording LED (which is controlled by K900LedController).
 *
 * RGB LED Indices:
 * - 0: Red LED
 * - 1: Green LED
 * - 2: Blue LED
 * - 3: Orange LED
 * - 4: White LED
 *
 * K900 Protocol Format:
 * {
 *   "C": "cs_ledon",  // Command name
 *   "V": 1,           // Version (required to prevent double-wrapping)
 *   "B": "{...}"      // Body parameters as JSON string
 * }
 */
public class K900RgbLedController {
    private static final String TAG = "K900RgbLedController";

    // K900 protocol commands
    private static final String K900_CMD_RGB_LED_ON = "cs_ledon";
    private static final String K900_CMD_RGB_LED_OFF = "cs_ledoff";

    // RGB LED color indices
    public static final int RGB_LED_RED = 0;
    public static final int RGB_LED_GREEN = 1;
    public static final int RGB_LED_BLUE = 2;
    public static final int RGB_LED_ORANGE = 3;
    public static final int RGB_LED_WHITE = 4;

    private final K900BluetoothManager bluetoothManager;

    /**
     * Create a new K900RgbLedController
     * @param bluetoothManager Bluetooth manager for sending commands to glasses
     */
    public K900RgbLedController(K900BluetoothManager bluetoothManager) {
        this.bluetoothManager = bluetoothManager;
        Log.d(TAG, "🚨 K900 RGB LED Controller initialized");
    }

    /**
     * Turn on a specific RGB LED with custom timing pattern
     * @param ledIndex LED color index (0=red, 1=green, 2=blue, 3=orange, 4=white)
     * @param ontime Duration in milliseconds for LED on state
     * @param offtime Duration in milliseconds for LED off state
     * @param count Number of on/off cycles (0 = infinite)
     * @return true if command was sent successfully, false otherwise
     */
    public boolean setLedOn(int ledIndex, int ontime, int offtime, int count) {
        Log.d(TAG, "🚨 Setting RGB LED ON");

        // Validate parameters
        if (ledIndex < RGB_LED_RED || ledIndex > RGB_LED_WHITE) {
            Log.e(TAG, "❌ Invalid RGB LED index: " + ledIndex + " (must be 0-4)");
            return false;
        }

        if (ontime < 0 || offtime < 0 || count < 0) {
            Log.e(TAG, "❌ Invalid timing parameters: ontime=" + ontime +
                      ", offtime=" + offtime + ", count=" + count);
            return false;
        }

        Log.i(TAG, String.format("🚨 💡 RGB LED ON - Color: %s, OnTime: %dms, OffTime: %dms, Cycles: %d",
                getColorName(ledIndex), ontime, offtime, count));

        try {
            // Build K900 protocol command
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", K900_CMD_RGB_LED_ON);
            k900Command.put("V", 1);  // Version field - REQUIRED to prevent double-wrapping

            JSONObject ledParams = new JSONObject();
            ledParams.put("led", ledIndex);
            ledParams.put("ontime", ontime);
            ledParams.put("offtime", offtime);
            ledParams.put("count", count);
            k900Command.put("B", ledParams.toString());

            // Send command to glasses
            boolean sent = sendK900Command(k900Command);

            if (sent) {
                Log.i(TAG, "✅ RGB LED ON command sent successfully to glasses");
            } else {
                Log.e(TAG, "❌ Failed to send RGB LED ON command to glasses");
            }

            return sent;

        } catch (JSONException e) {
            Log.e(TAG, "💥 Error building RGB LED ON command", e);
            return false;
        }
    }

    /**
     * Turn off all RGB LEDs
     * Note: Per K900 protocol specification, LED OFF always uses led:0
     * @return true if command was sent successfully, false otherwise
     */
    public boolean setLedOff() {
        Log.d(TAG, "🚨 Setting RGB LED OFF");

        try {
            // Build K900 protocol command
            // Per K900 protocol: LED OFF always uses led:0 regardless of which LED is being turned off
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", K900_CMD_RGB_LED_OFF);
            k900Command.put("V", 1);  // Version field - REQUIRED to prevent double-wrapping

            JSONObject ledParams = new JSONObject();
            ledParams.put("led", 0);  // Always 0 per K900 protocol specification
            k900Command.put("B", ledParams.toString());

            // Send command to glasses
            boolean sent = sendK900Command(k900Command);

            if (sent) {
                Log.i(TAG, "✅ RGB LED OFF command sent successfully to glasses");
            } else {
                Log.e(TAG, "❌ Failed to send RGB LED OFF command to glasses");
            }

            return sent;

        } catch (JSONException e) {
            Log.e(TAG, "💥 Error building RGB LED OFF command", e);
            return false;
        }
    }

    /**
     * Flash the white RGB LED for photo capture
     * @param durationMs Duration in milliseconds for the flash
     * @return true if command was sent successfully, false otherwise
     */
    public boolean flashWhite(int durationMs) {
        Log.d(TAG, String.format("📸 Flashing white RGB LED for %dms", durationMs));

        try {
            // Build K900 protocol command for white flash
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", K900_CMD_RGB_LED_ON);
            k900Command.put("V", 1);

            JSONObject ledParams = new JSONObject();
            ledParams.put("led", RGB_LED_WHITE);
            ledParams.put("ontime", durationMs);
            ledParams.put("offtime", 0);  // No off time for single flash
            ledParams.put("count", 1);    // Single flash
            k900Command.put("B", ledParams.toString());

            // Send command to glasses
            boolean sent = sendK900Command(k900Command);

            if (sent) {
                Log.i(TAG, "✅ Photo flash LED (white) command sent successfully to glasses");
            } else {
                Log.e(TAG, "❌ Failed to send photo flash LED command to glasses");
            }

            return sent;

        } catch (JSONException e) {
            Log.e(TAG, "💥 Error building photo flash LED command", e);
            return false;
        }
    }

    /**
     * Set the white RGB LED to solid on for video recording
     * @param durationMs Duration in milliseconds to keep LED on
     * @return true if command was sent successfully, false otherwise
     */
    public boolean setSolidWhite(int durationMs) {
        Log.d(TAG, String.format("🎥 Setting solid white RGB LED for %dms", durationMs));

        try {
            // Build K900 protocol command for solid white LED
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", K900_CMD_RGB_LED_ON);
            k900Command.put("V", 1);

            JSONObject ledParams = new JSONObject();
            ledParams.put("led", RGB_LED_WHITE);
            ledParams.put("ontime", durationMs);
            ledParams.put("offtime", 0);  // No off time - solid
            ledParams.put("count", 1);    // Single cycle (solid on)
            k900Command.put("B", ledParams.toString());

            // Send command to glasses
            boolean sent = sendK900Command(k900Command);

            if (sent) {
                Log.i(TAG, "✅ Video recording LED (solid white) command sent successfully to glasses");
            } else {
                Log.e(TAG, "❌ Failed to send video recording LED command to glasses");
            }

            return sent;

        } catch (JSONException e) {
            Log.e(TAG, "💥 Error building video recording LED command", e);
            return false;
        }
    }

    /**
     * Send K900 protocol command to glasses via Bluetooth
     * @param k900Command The K900 protocol command JSON object
     * @return true if command was sent successfully, false otherwise
     */
    private boolean sendK900Command(JSONObject k900Command) {
        Log.d(TAG, "📤 Sending K900 command to glasses: " + k900Command.toString());

        if (bluetoothManager == null) {
            Log.e(TAG, "❌ BluetoothManager is null");
            return false;
        }

        if (!bluetoothManager.isConnected()) {
            Log.w(TAG, "⚠️ Bluetooth not connected - cannot send LED command");
            return false;
        }

        try {
            byte[] commandBytes = k900Command.toString().getBytes(StandardCharsets.UTF_8);
            boolean sent = bluetoothManager.sendData(commandBytes);
            Log.d(TAG, "📡 Command sent result: " + sent);
            return sent;
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending command to glasses", e);
            return false;
        }
    }

    /**
     * Get human-readable color name for LED index
     * @param ledIndex LED color index
     * @return Human-readable color name
     */
    private String getColorName(int ledIndex) {
        switch (ledIndex) {
            case RGB_LED_RED: return "RED";
            case RGB_LED_GREEN: return "GREEN";
            case RGB_LED_BLUE: return "BLUE";
            case RGB_LED_ORANGE: return "ORANGE";
            case RGB_LED_WHITE: return "WHITE";
            default: return "UNKNOWN";
        }
    }
}
