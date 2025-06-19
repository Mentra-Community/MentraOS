package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

import java.util.List;

/**
 * Event sent when WiFi scan results are received from the glasses.
 * Contains a list of available WiFi network names (SSIDs).
 */
public class GlassesWifiScanResultEvent {
    // The device model name that sent the scan results
    public final String deviceModel;
    
    // List of WiFi networks found in the scan
    public final List<String> networks;
    
    /**
     * Create a new GlassesWifiScanResultEvent
     * 
     * @param deviceModel The glasses model name
     * @param networks List of WiFi network SSIDs found during scan
     */
    public GlassesWifiScanResultEvent(String deviceModel, List<String> networks) {
        this.deviceModel = deviceModel;
        this.networks = networks;
    }
}