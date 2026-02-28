package com.mentra.asg_client.service.system.interfaces;

import android.content.Intent;

/**
 * Interface for service lifecycle management.
 * Follows Single Responsibility Principle by handling only lifecycle concerns.
 */
public interface IServiceLifecycleManager {
    
    /**
     * Initialize the service
     */
    void initialize();
    
    /**
     * Start the service
     * @param intent Start intent
     * @param flags Start flags
     * @param startId Start ID
     * @return Service start result
     */
    int onStartCommand(Intent intent, int flags, int startId);
    
    /**
     * Handle service action
     * @param action Action to handle
     * @param extras Additional data
     */
    void handleAction(String action, android.os.Bundle extras);
    
    /**
     * Clean up service resources
     */
    void cleanup();
    
    /**
     * Check if service is initialized
     * @return true if initialized, false otherwise
     */
    boolean isInitialized();
    
    /**
     * Register event handlers
     */
    void registerEventHandlers();
    
    /**
     * Unregister event handlers
     */
    void unregisterEventHandlers();
    
    /**
     * Handle WiFi state changes
     * @param isConnected WiFi connection status
     */
    void onWifiStateChanged(boolean isConnected);
    
    /**
     * Handle Bluetooth connection changes
     * @param connected Bluetooth connection status
     */
    void onBluetoothConnectionChanged(boolean connected);
    
    /**
     * Handle Bluetooth data reception
     * @param data Received data
     */
    void onBluetoothDataReceived(byte[] data);
} 