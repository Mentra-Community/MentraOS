package com.mentra.asg_client.io.network.models;

import android.net.wifi.ScanResult;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.List;
import java.util.ArrayList;
import java.util.stream.Collectors;

/**
 * Enhanced WiFi network information with security and signal strength data.
 * Supports backwards compatibility with legacy string-based network lists.
 */
public class NetworkInfo {
    private String ssid;
    private boolean requiresPassword;
    private int signalStrength; // dBm value
    
    public NetworkInfo(String ssid, boolean requiresPassword, int signalStrength) {
        this.ssid = ssid != null ? ssid : "";
        this.requiresPassword = requiresPassword;
        this.signalStrength = signalStrength;
    }
    
    public NetworkInfo(String ssid, boolean requiresPassword) {
        this(ssid, requiresPassword, -100); // Default weak signal
    }
    
    public NetworkInfo(String ssid) {
        this(ssid, true, -100); // Default to secured and weak signal for safety
    }

    public String getSsid() {
        return ssid;
    }

    public boolean requiresPassword() {
        return requiresPassword;
    }

    public int getSignalStrength() {
        return signalStrength;
    }

    /**
     * Create NetworkInfo from Android ScanResult
     */
    public static NetworkInfo fromScanResult(ScanResult scanResult) {
        if (scanResult == null || scanResult.SSID == null || scanResult.SSID.isEmpty()) {
            return null;
        }
        
        String ssid = scanResult.SSID;
        boolean requiresPassword = isSecuredNetwork(scanResult.capabilities);
        int signalStrength = scanResult.level;
        
        return new NetworkInfo(ssid, requiresPassword, signalStrength);
    }
    
    /**
     * Determine if a network is secured based on capabilities string
     */
    private static boolean isSecuredNetwork(String capabilities) {
        if (capabilities == null || capabilities.isEmpty()) {
            return true; // Default to secured for safety
        }
        
        String caps = capabilities.toUpperCase();
        
        // Check for open network indicators
        if (caps.contains("[ESS]") && !caps.contains("WPA") && 
            !caps.contains("WEP") && !caps.contains("PSK") && 
            !caps.contains("EAP")) {
            return false; // Open network
        }
        
        // Check for security protocols
        return caps.contains("WPA") || caps.contains("WEP") || 
               caps.contains("PSK") || caps.contains("EAP") ||
               caps.contains("SAE") || caps.contains("OWE");
    }
    
    /**
     * Convert to JSON object for BLE transmission
     */
    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ssid", ssid);
        json.put("requiresPassword", requiresPassword);
        json.put("signalStrength", signalStrength);
        return json;
    }
    
    /**
     * Convert list of NetworkInfo to legacy string list for backwards compatibility
     */
    public static List<String> toStringList(List<NetworkInfo> networks) {
        if (networks == null) {
            return new ArrayList<>();
        }
        
        return networks.stream()
                .map(NetworkInfo::getSsid)
                .collect(Collectors.toList());
    }
    
    /**
     * Convert legacy string list to NetworkInfo list (with default security assumptions)
     */
    public static List<NetworkInfo> fromStringList(List<String> networks) {
        if (networks == null) {
            return new ArrayList<>();
        }
        
        return networks.stream()
                .map(NetworkInfo::new) // Uses constructor with default secured=true
                .collect(Collectors.toList());
    }
    
    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (obj == null || getClass() != obj.getClass()) return false;
        
        NetworkInfo that = (NetworkInfo) obj;
        return ssid.equals(that.ssid);
    }
    
    @Override
    public int hashCode() {
        return ssid.hashCode();
    }
    
    @Override
    public String toString() {
        return String.format("NetworkInfo{ssid='%s', secured=%s, strength=%ddBm}", 
                           ssid, requiresPassword, signalStrength);
    }
}