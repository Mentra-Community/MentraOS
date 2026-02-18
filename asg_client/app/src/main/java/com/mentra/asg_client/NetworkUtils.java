package com.mentra.asg_client;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.util.Log;

import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Enumeration;

/**
 * Utility class for network-related operations.
 */
public class NetworkUtils {
    
    private static final String TAG = "NetworkUtils";

    /**
     * Get the local IP address of the device.
     * 
     * @return The local IP address as a string, or "127.0.0.1" if not found
     */
    public static String getLocalIpAddress() {
        try {
            Enumeration<NetworkInterface> networkInterfaces = NetworkInterface.getNetworkInterfaces();
            
            while (networkInterfaces.hasMoreElements()) {
                NetworkInterface networkInterface = networkInterfaces.nextElement();
                
                // Skip loopback and down interfaces
                if (networkInterface.isLoopback() || !networkInterface.isUp()) {
                    continue;
                }
                
                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    
                    // Only return IPv4 addresses
                    if (!address.isLoopbackAddress() && address.getHostAddress().indexOf(':') < 0) {
                        String ipAddress = address.getHostAddress();
                        Log.d(TAG, "Found local IP address: " + ipAddress + " on interface: " + networkInterface.getDisplayName());
                        return ipAddress;
                    }
                }
            }
        } catch (SocketException e) {
            Log.e(TAG, "Error getting local IP address: " + e.getMessage(), e);
        }
        
        Log.w(TAG, "No local IP address found, returning localhost");
        return "127.0.0.1";
    }

    /**
     * Get the WiFi IP address specifically.
     * 
     * @param context The application context
     * @return The WiFi IP address, or null if not connected to WiFi
     */
    public static String getWifiIpAddress(Context context) {
        try {
            WifiManager wifiManager = (WifiManager) context.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            
            if (wifiManager != null && wifiManager.isWifiEnabled()) {
                int ipAddress = wifiManager.getConnectionInfo().getIpAddress();
                if (ipAddress != 0) {
                    return String.format("%d.%d.%d.%d",
                            (ipAddress & 0xff),
                            (ipAddress >> 8 & 0xff),
                            (ipAddress >> 16 & 0xff),
                            (ipAddress >> 24 & 0xff));
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting WiFi IP address: " + e.getMessage(), e);
        }
        
        return null;
    }

    /**
     * Check if the device is connected to WiFi.
     * 
     * @param context The application context
     * @return true if connected to WiFi, false otherwise
     */
    public static boolean isWifiConnected(Context context) {
        try {
            ConnectivityManager connectivityManager = (ConnectivityManager) 
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            
            if (connectivityManager != null) {
                Network network = connectivityManager.getActiveNetwork();
                if (network != null) {
                    NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
                    return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error checking WiFi connection: " + e.getMessage(), e);
        }
        
        return false;
    }

    /**
     * Get the best available IP address for external access.
     * Prioritizes WiFi IP over other network interfaces.
     * 
     * @param context The application context
     * @return The best available IP address
     */
    public static String getBestIpAddress(Context context) {
        // First try to get WiFi IP address
        String wifiIp = getWifiIpAddress(context);
        if (wifiIp != null && !wifiIp.equals("0.0.0.0")) {
            Log.d(TAG, "Using WiFi IP address: " + wifiIp);
            return wifiIp;
        }
        
        // Fallback to any available local IP
        String localIp = getLocalIpAddress();
        Log.d(TAG, "Using local IP address: " + localIp);
        return localIp;
    }

    /**
     * Check if an IP address is valid.
     * 
     * @param ipAddress The IP address to validate
     * @return true if valid, false otherwise
     */
    public static boolean isValidIpAddress(String ipAddress) {
        if (ipAddress == null || ipAddress.isEmpty()) {
            return false;
        }
        
        String[] parts = ipAddress.split("\\.");
        if (parts.length != 4) {
            return false;
        }
        
        try {
            for (String part : parts) {
                int value = Integer.parseInt(part);
                if (value < 0 || value > 255) {
                    return false;
                }
            }
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }
} 