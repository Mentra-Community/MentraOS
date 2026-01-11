package com.mentra.asg_client.io.hardware.core;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;

/**
 * Base implementation of the IHardwareManager interface.
 * Provides default no-op implementations for devices without specific hardware support.
 * This is used when running on generic Android devices or emulators.
 */
public class BaseHardwareManager implements IHardwareManager {
    private static final String TAG = "BaseHardwareManager";
    
    protected final Context context;
    protected boolean isInitialized = false;
    
    /**
     * Create a new BaseHardwareManager
     * @param context The application context
     */
    public BaseHardwareManager(Context context) {
        this.context = context.getApplicationContext();
    }
    
    @Override
    public void initialize() {
        Log.d(TAG, "Initializing BaseHardwareManager (no hardware-specific features)");
        isInitialized = true;
    }
    
    @Override
    public boolean supportsRecordingLed() {
        // Base implementation doesn't support LED
        return false;
    }
    
    @Override
    public void setRecordingLedOn() {
        Log.d(TAG, "setRecordingLedOn() called - no-op on base hardware");
    }
    
    @Override
    public void setRecordingLedOff() {
        Log.d(TAG, "setRecordingLedOff() called - no-op on base hardware");
    }
    
    @Override
    public void setRecordingLedBlinking() {
        Log.d(TAG, "setRecordingLedBlinking() called - no-op on base hardware");
    }
    
    @Override
    public void setRecordingLedBlinking(long onDurationMs, long offDurationMs) {
        Log.d(TAG, String.format("setRecordingLedBlinking(%d, %d) called - no-op on base hardware", 
                                 onDurationMs, offDurationMs));
    }
    
    @Override
    public void stopRecordingLedBlinking() {
        Log.d(TAG, "stopRecordingLedBlinking() called - no-op on base hardware");
    }
    
    @Override
    public void flashRecordingLed(long durationMs) {
        Log.d(TAG, String.format("flashRecordingLed(%d) called - no-op on base hardware", durationMs));
    }
    
    @Override
    public boolean isRecordingLedOn() {
        // Always return false for base implementation
        return false;
    }
    
    @Override
    public boolean isRecordingLedBlinking() {
        // Always return false for base implementation
        return false;
    }
    
    @Override
    public String getDeviceModel() {
        return "GENERIC";
    }
    
    @Override
    public boolean isK900Device() {
        return false;
    }

    @Override
    public boolean supportsAudioPlayback() {
        return false;
    }

    @Override
    public void playAudioAsset(String assetName) {
        Log.d(TAG, "playAudioAsset(" + assetName + ") called - no-op on base hardware");
    }

    @Override
    public void stopAudioPlayback() {
        Log.d(TAG, "stopAudioPlayback() called - no-op on base hardware");
    }

    @Override
    public void setBluetoothManager(Object bluetoothManager) {
        Log.d(TAG, "setBluetoothManager() called - no-op on base hardware");
    }

    // ============================================
    // MTK LED Brightness Control (Not Supported)
    // ============================================

    @Override
    public boolean supportsLedBrightness() {
        return false;
    }

    @Override
    public void setRecordingLedBrightness(int percent) {
        Log.d(TAG, "setRecordingLedBrightness(" + percent + ") called - no-op on base hardware");
    }

    @Override
    public void setRecordingLedBrightness(int percent, int durationMs) {
        Log.d(TAG, String.format("setRecordingLedBrightness(%d, %d) called - no-op on base hardware",
                                 percent, durationMs));
    }

    @Override
    public int getRecordingLedBrightness() {
        return 0;
    }

    // ============================================
    // RGB LED Control (Not Supported)
    // ============================================

    @Override
    public boolean supportsRgbLed() {
        return false;
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count) {
        Log.d(TAG, String.format("setRgbLedOn(%d, %d, %d, %d) called - no-op on base hardware",
                                 ledIndex, ontime, offtime, count));
    }

    @Override
    public void setRgbLedOff() {
        Log.d(TAG, "setRgbLedOff() called - no-op on base hardware");
    }

    @Override
    public void flashRgbLedWhite(int durationMs) {
        Log.d(TAG, "flashRgbLedWhite(" + durationMs + ") called - no-op on base hardware");
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs) {
        Log.d(TAG, "setRgbLedSolidWhite(" + durationMs + ") called - no-op on base hardware");
    }

    // ============================================
    // Battery Status (Not Supported)
    // ============================================

    @Override
    public int getBatteryLevel() {
        Log.d(TAG, "getBatteryLevel() called - returning -1 on base hardware");
        return -1;
    }

    @Override
    public boolean getChargingStatus() {
        Log.d(TAG, "getChargingStatus() called - returning false on base hardware");
        return false;
    }

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down BaseHardwareManager");
        isInitialized = false;
    }
}
