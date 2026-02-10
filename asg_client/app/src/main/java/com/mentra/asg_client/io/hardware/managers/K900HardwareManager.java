package com.mentra.asg_client.io.hardware.managers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.hardware.core.BaseHardwareManager;
import com.mentra.asg_client.hardware.K900LedController;
import com.mentra.asg_client.hardware.K900RgbLedController;
import com.mentra.asg_client.audio.I2SAudioController;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Implementation of IHardwareManager for K900 devices.
 * Uses K900-specific hardware APIs including the xydev library for LED control.
 */
public class K900HardwareManager extends BaseHardwareManager {
    private static final String TAG = "K900HardwareManager";

    // Battery cache settings
    private static final long BATTERY_CACHE_DURATION_MS = 2 * 60 * 1000; // 2 minutes
    private static final long BATTERY_QUERY_TIMEOUT_MS = 50; // 50ms timeout

    private K900LedController ledController;
    private K900RgbLedController rgbLedController;
    private I2SAudioController audioController;
    private K900BluetoothManager bluetoothManager;

    // Battery cache
    private int cachedBatteryLevel = -1;
    private boolean cachedChargingStatus = false;
    private long lastBatteryQueryTime = 0;
    private CountDownLatch batteryResponseLatch;
    private final Object batteryLock = new Object();
    
    /**
     * Create a new K900HardwareManager
     * @param context The application context
     */
    public K900HardwareManager(Context context) {
        super(context);
    }
    
    @Override
    public void initialize() {
        Log.d(TAG, "🔧 =========================================");
        Log.d(TAG, "🔧 K900 HARDWARE MANAGER INITIALIZE");
        Log.d(TAG, "🔧 =========================================");
        
        super.initialize();
        
        // Initialize the K900 LED controller
        try {
            ledController = K900LedController.getInstance();
            Log.d(TAG, "🔧 ✅ K900 LED controller initialized successfully");
        } catch (Exception e) {
            Log.e(TAG, "🔧 ❌ Failed to initialize K900 LED controller", e);
            ledController = null;
        }

        audioController = new I2SAudioController(context);

        Log.d(TAG, "🔧 ✅ K900 Hardware Manager initialized");
    }
    
    @Override
    public boolean supportsRecordingLed() {
        // K900 devices support recording LED
        return ledController != null;
    }
    
    @Override
    public void setRecordingLedOn() {
        if (ledController != null) {
            ledController.turnOn();
            Log.d(TAG, "🔴 Recording LED turned ON");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }
    
    @Override
    public void setRecordingLedOff() {
        if (ledController != null) {
            ledController.turnOff();
            Log.d(TAG, "⚫ Recording LED turned OFF");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }
    
    @Override
    public void setRecordingLedBlinking() {
        if (ledController != null) {
            ledController.startBlinking();
            Log.d(TAG, "🔴⚫ Recording LED set to BLINKING (default pattern)");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }
    
    @Override
    public void setRecordingLedBlinking(long onDurationMs, long offDurationMs) {
        if (ledController != null) {
            ledController.startBlinking(onDurationMs, offDurationMs);
            Log.d(TAG, String.format("🔴⚫ Recording LED set to BLINKING (on=%dms, off=%dms)", 
                                     onDurationMs, offDurationMs));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }
    
    @Override
    public void stopRecordingLedBlinking() {
        if (ledController != null) {
            ledController.stopBlinking();
            Log.d(TAG, "⚫ Recording LED blinking stopped");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }
    
    @Override
    public void flashRecordingLed(long durationMs) {
        if (ledController != null) {
            ledController.flash(durationMs);
            Log.d(TAG, String.format("💥 Recording LED flashed for %dms", durationMs));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }
    
    @Override
    public boolean isRecordingLedOn() {
        if (ledController != null) {
            return ledController.isLedOn();
        }
        return false;
    }
    
    @Override
    public boolean isRecordingLedBlinking() {
        if (ledController != null) {
            return ledController.isBlinking();
        }
        return false;
    }
    
    @Override
    public String getDeviceModel() {
        return "K900";
    }
    
    @Override
    public boolean isK900Device() {
        return true;
    }

    @Override
    public boolean supportsAudioPlayback() {
        return true;
    }

    @Override
    public void playAudioAsset(String assetName) {
        if (audioController != null) {
            audioController.playAsset(assetName);
        } else {
            Log.w(TAG, "Audio controller not available");
        }
    }

    @Override
    public void stopAudioPlayback() {
        if (audioController != null) {
            audioController.stopPlayback();
        }
    }

    @Override
    public void setBluetoothManager(Object bluetoothManager) {
        if (bluetoothManager instanceof K900BluetoothManager) {
            this.bluetoothManager = (K900BluetoothManager) bluetoothManager;
            try {
                rgbLedController = new K900RgbLedController(this.bluetoothManager);
                Log.d(TAG, "🔧 ✅ K900 RGB LED controller initialized successfully");
            } catch (Exception e) {
                Log.e(TAG, "🔧 ❌ Failed to initialize K900 RGB LED controller", e);
                rgbLedController = null;
            }
        } else {
            Log.w(TAG, "Invalid BluetoothManager provided (expected K900BluetoothManager)");
        }
    }

    // ============================================
    // MTK LED Brightness Control
    // ============================================

    @Override
    public boolean supportsLedBrightness() {
        return ledController != null;
    }

    @Override
    public void setRecordingLedBrightness(int percent) {
        if (ledController != null) {
            ledController.setBrightness(percent);
            Log.d(TAG, String.format("💡 Recording LED brightness set to %d%%", percent));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public void setRecordingLedBrightness(int percent, int durationMs) {
        if (ledController != null) {
            ledController.setBrightness(percent, durationMs);
            Log.d(TAG, String.format("💡 Recording LED brightness set to %d%% for %dms", percent, durationMs));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public int getRecordingLedBrightness() {
        if (ledController != null) {
            return ledController.getBrightness();
        }
        return 0;
    }

    // ============================================
    // RGB LED Control (BES Chipset)
    // ============================================

    @Override
    public boolean supportsRgbLed() {
        return rgbLedController != null;
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count) {
        if (rgbLedController != null) {
            rgbLedController.setLedOn(ledIndex, ontime, offtime, count);
            Log.d(TAG, String.format("🚨 RGB LED ON - Index: %d, OnTime: %dms, OffTime: %dms, Count: %d",
                    ledIndex, ontime, offtime, count));
        } else {
            Log.w(TAG, "RGB LED controller not available - call setBluetoothManager() first");
        }
    }

    @Override
    public void setRgbLedOff() {
        if (rgbLedController != null) {
            rgbLedController.setLedOff();
            Log.d(TAG, "🚨 RGB LED OFF");
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    @Override
    public void flashRgbLedWhite(int durationMs) {
        if (rgbLedController != null) {
            rgbLedController.flashWhite(durationMs);
            Log.d(TAG, String.format("📸 RGB LED white flash for %dms", durationMs));
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs) {
        if (rgbLedController != null) {
            rgbLedController.setSolidWhite(durationMs);
            Log.d(TAG, String.format("🎥 RGB LED solid white for %dms", durationMs));
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    // ============================================
    // Battery Status (BES Query with Cache)
    // ============================================

    @Override
    public int getBatteryLevel() {
        synchronized (batteryLock) {
            long now = System.currentTimeMillis();

            // Return cached value if still fresh
            if (cachedBatteryLevel >= 0 && (now - lastBatteryQueryTime) < BATTERY_CACHE_DURATION_MS) {
                Log.d(TAG, "🔋 Returning cached battery level: " + cachedBatteryLevel + "%");
                return cachedBatteryLevel;
            }

            // Query BES for fresh battery status
            if (!queryBatteryFromBes()) {
                Log.w(TAG, "🔋 Battery query failed, returning cached value: " + cachedBatteryLevel);
                return cachedBatteryLevel;
            }

            return cachedBatteryLevel;
        }
    }

    @Override
    public boolean getChargingStatus() {
        synchronized (batteryLock) {
            long now = System.currentTimeMillis();

            // Return cached value if still fresh
            if (cachedBatteryLevel >= 0 && (now - lastBatteryQueryTime) < BATTERY_CACHE_DURATION_MS) {
                Log.d(TAG, "🔋 Returning cached charging status: " + cachedChargingStatus);
                return cachedChargingStatus;
            }

            // Query BES for fresh battery status
            if (!queryBatteryFromBes()) {
                Log.w(TAG, "🔋 Battery query failed, returning cached charging status: " + cachedChargingStatus);
                return cachedChargingStatus;
            }

            return cachedChargingStatus;
        }
    }

    /**
     * Query battery status from BES chipset.
     * Sends mh_batv command and waits up to 50ms for hm_batv response.
     * @return true if query succeeded and cache was updated, false otherwise
     */
    private boolean queryBatteryFromBes() {
        if (bluetoothManager == null || !bluetoothManager.isConnected()) {
            Log.w(TAG, "🔋 Cannot query battery - Bluetooth not connected");
            return false;
        }

        try {
            // Create latch for waiting on response
            batteryResponseLatch = new CountDownLatch(1);

            // Build K900 protocol command for battery query
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "mh_batv");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
            Log.d(TAG, "🔋 Querying battery from BES: " + commandStr);

            // Send command to BES
            boolean sent = bluetoothManager.sendData(commandStr.getBytes(StandardCharsets.UTF_8));
            if (!sent) {
                Log.e(TAG, "🔋 Failed to send battery query command");
                return false;
            }

            // Wait for response with timeout
            boolean received = batteryResponseLatch.await(BATTERY_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (received) {
                Log.d(TAG, "🔋 Battery query response received within timeout");
                return true;
            } else {
                Log.w(TAG, "🔋 Battery query timed out after " + BATTERY_QUERY_TIMEOUT_MS + "ms");
                return false;
            }

        } catch (JSONException e) {
            Log.e(TAG, "🔋 Error building battery query command", e);
            return false;
        } catch (InterruptedException e) {
            Log.e(TAG, "🔋 Battery query interrupted", e);
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * Called by K900CommandHandler when hm_batv response is received from BES.
     * Updates the cached battery values and signals any waiting query.
     * @param batteryLevel Battery percentage (0-100)
     * @param batteryVoltage Battery voltage in mV
     */
    public void onBatteryResponse(int batteryLevel, int batteryVoltage) {
        synchronized (batteryLock) {
            cachedBatteryLevel = batteryLevel;
            // Infer charging status from voltage (same logic as K900CommandHandler)
            cachedChargingStatus = batteryVoltage > 3900;
            lastBatteryQueryTime = System.currentTimeMillis();

            Log.d(TAG, "🔋 Battery cache updated: " + cachedBatteryLevel + "%, charging=" + cachedChargingStatus);

            // Signal any waiting query
            if (batteryResponseLatch != null) {
                batteryResponseLatch.countDown();
            }
        }
    }

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down K900HardwareManager");

        if (audioController != null) {
            audioController.stopPlayback();
            audioController = null;
        }

        if (rgbLedController != null) {
            rgbLedController = null;
        }

        if (ledController != null) {
            ledController.shutdown();
            ledController = null;
        }

        super.shutdown();
    }
}
