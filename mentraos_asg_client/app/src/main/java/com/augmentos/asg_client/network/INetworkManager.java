package com.augmentos.asg_client.network;

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
     * Start a hotspot with the specified SSID and password
     * @param ssid The SSID for the hotspot
     * @param password The password for the hotspot (null for open network)
     */
    void startHotspot(String ssid, String password);
    
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
     * Cleanup resources when the manager is no longer needed
     */
    void shutdown();
}