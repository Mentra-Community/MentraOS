package com.mentra.asg_client.service.system.interfaces;

/**
 * Interface for state management (battery, WiFi, Bluetooth, etc.).
 * Follows Interface Segregation Principle by providing focused state management methods.
 */
public interface IStateManager {
    
    /**
     * Update battery status
     * @param level Battery level
     * @param charging Whether device is charging
     * @param timestamp Timestamp
     */
    void updateBatteryStatus(int level, boolean charging, long timestamp);
    
    /**
     * Get battery level
     * @return Battery level
     */
    int getBatteryLevel();
    
    /**
     * Check if device is charging
     * @return true if charging, false otherwise
     */
    boolean isCharging();
    
    /**
     * Get battery status string
     * @return Formatted battery status string
     */
    String getBatteryStatusString();
    
    /**
     * Check if connected to WiFi
     * @return true if connected, false otherwise
     */
    boolean isConnectedToWifi();
    
    /**
     * Check if connected to Bluetooth
     * @return true if connected, false otherwise
     */
    boolean isBluetoothConnected();
    
    /**
     * Check if AugmentosService is bound
     * @return true if bound, false otherwise
     */
    boolean isAugmentosServiceBound();
} 