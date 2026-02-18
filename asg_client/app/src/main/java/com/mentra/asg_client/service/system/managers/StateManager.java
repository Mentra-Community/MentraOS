package com.mentra.asg_client.service.system.managers;

import android.util.Log;

import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;


import org.greenrobot.eventbus.EventBus;

import java.util.Locale;

/**
 * Manages all state information (battery, WiFi, Bluetooth, etc.).
 * Follows Single Responsibility Principle by handling only state management concerns.
 */
public class StateManager implements IStateManager {
    
    private static final String TAG = "StateManager";
    
    private final AsgClientServiceManager serviceManager;
    
    // Battery state
    private int glassesBatteryLevel = -1;
    private boolean glassesCharging = false;
    private int lastBroadcastedBatteryLevel = -1;
    private boolean lastBroadcastedCharging = false;
    
    // Service binding state
    private boolean isAugmentosBound = false;
    
    public StateManager(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }
    
    @Override
    public void updateBatteryStatus(int level, boolean charging, long timestamp) {
        glassesBatteryLevel = level;
        glassesCharging = charging;
        
        Log.d(TAG, "🔋 Received battery status: " + level + "% " + 
              (charging ? "(charging)" : "(not charging)") + " at " + timestamp);
        
        broadcastBatteryStatusToOtaUpdater(level, charging, timestamp);
    }
    
    @Override
    public int getBatteryLevel() {
        return glassesBatteryLevel;
    }
    
    @Override
    public boolean isCharging() {
        return glassesCharging;
    }
    
    @Override
    public String getBatteryStatusString() {
        if (glassesBatteryLevel == -1) {
            return "Unknown";
        }
        return glassesBatteryLevel + "% " + (glassesCharging ? "(charging)" : "(not charging)");
    }
    
    @Override
    public boolean isConnectedToWifi() {
        return serviceManager != null && serviceManager.getNetworkManager() != null && 
               serviceManager.getNetworkManager().isConnectedToWifi();
    }
    
    @Override
    public boolean isBluetoothConnected() {
        return serviceManager != null && serviceManager.getBluetoothManager() != null && 
               serviceManager.getBluetoothManager().isConnected();
    }
    
    @Override
    public boolean isAugmentosServiceBound() {
        return isAugmentosBound;
    }
    
    /**
     * Set AugmentosService binding state
     * @param bound Binding state
     */
    public void setAugmentosServiceBound(boolean bound) {
        this.isAugmentosBound = bound;
    }
    
    /**
     * Broadcast battery status to OTA updater
     */
    private void broadcastBatteryStatusToOtaUpdater(int level, boolean charging, long timestamp) {
        if (level == lastBroadcastedBatteryLevel && charging == lastBroadcastedCharging) {
            return;
        }
        
        try {
            BatteryStatusEvent batteryEvent = new BatteryStatusEvent(level, charging, timestamp);
            EventBus.getDefault().post(batteryEvent);
            
            lastBroadcastedBatteryLevel = level;
            lastBroadcastedCharging = charging;
        } catch (Exception e) {
            Log.e(TAG, "Error broadcasting battery status", e);
        }
    }
    
    /**
     * Format duration in milliseconds to human readable string
     */
    public String formatDuration(long durationMs) {
        long seconds = durationMs / 1000;
        long minutes = seconds / 60;
        long hours = minutes / 60;
        
        if (hours > 0) {
            return String.format(Locale.US, "%d:%02d:%02d", hours, minutes % 60, seconds % 60);
        } else {
            return String.format(Locale.US, "%d:%02d", minutes, seconds % 60);
        }
    }
} 