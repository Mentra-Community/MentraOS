package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

/**
 * Event sent when glasses need WiFi credentials to connect to a network.
 * This is specifically for glasses models that require WiFi connectivity,
 * such as Mentra Live glasses.
 */
public class GlassesWifiStatusChange {
    // The device model name requiring WiFi credentials
    public final String deviceModel;
    
    // Additional info about current WiFi status if available
    public final boolean isWifiConnected;
    public final String currentSsid;
    
    /**
     * Create a new GlassesNeedWifiCredentialsEvent
     * 
     * @param deviceModel The glasses model name
     * @param isWifiConnected Current WiFi connection state if known
     * @param currentSsid Current SSID if connected
     */
    public GlassesWifiStatusChange(String deviceModel,
                                   boolean isWifiConnected, String currentSsid) {
        this.deviceModel = deviceModel;
        this.isWifiConnected = isWifiConnected;
        this.currentSsid = currentSsid;
    }
}