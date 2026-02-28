package com.mentra.asg_client.io.network.interfaces;

/**
 * Interface for receiving notifications about network state changes.
 */
public interface NetworkStateListener {
    /**
     * Called when the WiFi state changes
     * @param isConnected true if connected to WiFi, false otherwise
     */
    void onWifiStateChanged(boolean isConnected);
    
    /**
     * Called when the hotspot state changes
     * @param isEnabled true if the hotspot is enabled, false otherwise
     */
    void onHotspotStateChanged(boolean isEnabled);
    
    /**
     * Called when WiFi credentials are received through the hotspot setup
     * @param ssid The SSID of the network
     * @param password The password for the network
     * @param authToken Optional authentication token
     */
    void onWifiCredentialsReceived(String ssid, String password, String authToken);

    /**
     * Called when a hotspot error occurs (e.g., failed to read SSID after retries)
     * @param errorMessage Description of the error
     */
    void onHotspotError(String errorMessage);
} 