package com.mentra.asg_client.io.network.interfaces;

import java.util.List;
import com.mentra.asg_client.io.network.models.NetworkInfo;

/**
 * Callback interface for streaming WiFi scan results.
 * Allows networks to be sent to the phone immediately as they're discovered.
 * Supports both legacy string format and enhanced NetworkInfo format.
 */
public interface IWifiScanCallback {
    
    /**
     * Called when new WiFi networks are discovered during scanning.
     * This method will be called multiple times during a scan as networks are found.
     * 
     * @param networks List of newly discovered network SSIDs (legacy format)
     * @deprecated Use onNetworksFoundEnhanced for full network information
     */
    @Deprecated
    default void onNetworksFound(List<String> networks) {
        // Convert to NetworkInfo and call enhanced method
        List<NetworkInfo> networkInfos = NetworkInfo.fromStringList(networks);
        onNetworksFoundEnhanced(networkInfos);
    }
    
    /**
     * Called when new WiFi networks with enhanced info are discovered during scanning.
     * This method will be called multiple times during a scan as networks are found.
     * 
     * @param networks List of newly discovered NetworkInfo objects with security and signal data
     */
    default void onNetworksFoundEnhanced(List<NetworkInfo> networks) {
        // Backwards compatibility - convert to strings and call legacy method
        List<String> networkStrings = NetworkInfo.toStringList(networks);
        onNetworksFound(networkStrings);
    }
    
    /**
     * Called when the WiFi scan has completed.
     * No more networks will be reported after this callback.
     * 
     * @param totalNetworksFound Total number of unique networks discovered
     */
    void onScanComplete(int totalNetworksFound);
    
    /**
     * Called when the WiFi scan encounters an error.
     * 
     * @param error Error message describing what went wrong
     */
    void onScanError(String error);
}