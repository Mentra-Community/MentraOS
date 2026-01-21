package com.mentra.asg_client.io.network.interfaces;

import java.util.List;

/**
 * Interface for network management operations across different device types.
 * This interface abstracts WiFi and hotspot operations to support different
 * implementations for different device types (K900, system-level, fallback).
 */
public interface INetworkManager {
    /**
     * Initialize the network manager and check current connectivity
     */
    void initialize();
    
    /**
     * Enable WiFi and attempt to connect to known networks
     */
    void enableWifi();
    
    /**
     * Disable WiFi
     */
    void disableWifi();
    
    /**
     * Start a hotspot with device-generated persistent credentials
     * SSID format: MentraOS_XXXXX where XXXXX is a persistent device ID
     * Password: 12345678 (fixed)
     */
    void startHotspot();
    
    /**
     * Stop the currently running hotspot
     */
    void stopHotspot();
    
    /**
     * Check if the device is currently connected to a WiFi network
     * @return true if connected to WiFi, false otherwise
     */
    boolean isConnectedToWifi();
    
    /**
     * Get the SSID of the currently connected WiFi network
     * @return the SSID string, or empty string if not connected
     */
    String getCurrentWifiSsid();
    
    /**
     * Connect to a specific WiFi network
     * @param ssid The SSID of the network to connect to
     * @param password The password for the network (null for open networks)
     */
    void connectToWifi(String ssid, String password);
    
    /**
     * Disconnect from the currently connected WiFi network
     */
    void disconnectFromWifi();

    /**
     * Forget a saved WiFi network (removes it from saved networks)
     * @param ssid The SSID of the network to forget
     */
    void forgetWifiNetwork(String ssid);
    
    /**
     * Add a listener for WiFi state changes
     * @param listener The listener to add
     */
    void addWifiListener(NetworkStateListener listener);
    
    /**
     * Remove a previously added WiFi state listener
     * @param listener The listener to remove
     */
    void removeWifiListener(NetworkStateListener listener);
    
    /**
     * Get a list of configured WiFi networks
     * @return List of WiFi network names (SSIDs)
     */
    List<String> getConfiguredWifiNetworks();
    
    /**
     * Scan for available WiFi networks
     * @return List of nearby WiFi network names (SSIDs)
     */
    List<String> scanWifiNetworks();
    
    /**
     * Scan for available WiFi networks with streaming results
     * @param callback Callback to receive networks as they're discovered
     */
    void scanWifiNetworks(IWifiScanCallback callback);
    
    /**
     * Get the local IP address of the device on the current network
     * @return the local IP address as a string, or empty string if not available
     */
    String getLocalIpAddress();
    
    /**
     * Check if the hotspot is currently enabled
     * @return true if hotspot is active, false otherwise
     */
    boolean isHotspotEnabled();
    
    /**
     * Get the SSID of the currently running hotspot
     * @return the hotspot SSID, or empty string if not active
     */
    String getHotspotSsid();
    
    /**
     * Get the password of the currently running hotspot
     * @return the hotspot password, or empty string if not active
     */
    String getHotspotPassword();
    
    /**
     * Get the gateway IP address when in hotspot mode
     * @return The gateway IP for clients to connect to (typically 192.168.43.1)
     */
    String getHotspotGatewayIp();
    
    /**
     * Update HTTP activity timestamp for hotspot auto-disconnect monitoring
     */
    void updateHttpActivity();
    
    /**
     * Cleanup resources when the manager is no longer needed
     */
    void shutdown();
} 