package com.augmentos.augmentos_core.utils;

import com.augmentos.augmentos_core.BuildConfig;

/**
 * Utility class for server configuration and URL management.
 * Centralizes server URL construction to ensure consistency across components.
 */
public class ServerConfigUtil {

    /**
     * Gets the base URL for the AugmentOS server.
     * Uses BuildConfig properties to dynamically construct the URL.
     * 
     * @return The complete server base URL
     * @throws IllegalStateException if required configuration is missing
     */
    public static String getServerBaseUrl() {
        String host = BuildConfig.AUGMENTOS_HOST;
        String port = BuildConfig.AUGMENTOS_PORT;
        boolean secureServer = Boolean.parseBoolean(BuildConfig.AUGMENTOS_SECURE);
        
        if (host == null || port == null) {
            throw new IllegalStateException("AugmentOS Server Config Not Found");
        }
        
        return String.format("%s://%s:%s", secureServer ? "https" : "http", host, port);
    }
    
    /**
     * Gets the full URL for a specific API endpoint.
     * Combines the base URL with the provided endpoint path.
     * 
     * @param endpointPath The API endpoint path (e.g., "/api/photos/upload")
     * @return The complete URL to the specified endpoint
     */
    public static String getApiUrl(String endpointPath) {
        String baseUrl = getServerBaseUrl();
        
        // Ensure path starts with a slash
        if (!endpointPath.startsWith("/")) {
            endpointPath = "/" + endpointPath;
        }
        
        return baseUrl + endpointPath;
    }
    
    /**
     * Gets the hardware button press endpoint URL.
     * 
     * @return Complete URL for the button press endpoint
     */
    public static String getButtonPressUrl() {
        return getApiUrl("/api/hardware/button-press");
    }
    
    /**
     * Gets the photo upload endpoint URL.
     * 
     * @return Complete URL for the photo upload endpoint
     */
    public static String getPhotoUploadUrl() {
        return getApiUrl("/api/photos/upload");
    }

    public static String getVideoUploadUrl() {
        return getApiUrl("/api/videos/upload");
    }
}