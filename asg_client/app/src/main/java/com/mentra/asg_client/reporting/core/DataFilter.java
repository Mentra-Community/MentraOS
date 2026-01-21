package com.mentra.asg_client.reporting.core;

import android.util.Log;

import java.util.HashMap;
import java.util.Map;

/**
 * Central data filtering utility for all reporting providers
 * Follows Single Responsibility Principle - only handles data filtering
 * Follows DRY principle - shared filtering logic across all providers
 */
public class DataFilter {

    private static final String TAG = "DataFilter";

    // Sensitive keys that should be filtered out
    private static final String[] SENSITIVE_KEYS = {
            "password", "token", "api_key", "dsn", "auth_token", "secret",
            "private_key", "access_token", "refresh_token", "client_secret",
            "api_secret", "encryption_key", "signing_key", "master_key",
            "coreToken", "core_token"
    };

    // Sensitive patterns that should be filtered
    private static final String[] SENSITIVE_PATTERNS = {
            ".*password.*", ".*token.*", ".*key.*", ".*secret.*", ".*auth.*"
    };

    /**
     * Filter sensitive data from a map
     *
     * @param data The original data map
     * @return A new map with sensitive data filtered out
     */
    public static Map<String, Object> filterSensitiveData(Map<String, Object> data) {
        if (data == null) return null;

        Map<String, Object> filteredData = new HashMap<>();

        for (Map.Entry<String, Object> entry : data.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();

            if (isSensitiveKey(key)) {
                filteredData.put(key, "[FILTERED]");
            } else {
                filteredData.put(key, value);
            }
        }

        return filteredData;
    }

    /**
     * Filter sensitive data from a string
     *
     * @param text The original text
     * @return Filtered text with sensitive data replaced
     */
    public static String filterSensitiveText(String text) {
        if (text == null) return null;

        String filteredText = text;

        // Replace common sensitive patterns
        for (String pattern : SENSITIVE_PATTERNS) {
            filteredText = filteredText.replaceAll("(?i)" + pattern, "[FILTERED]");
        }

        return filteredText;
    }

    /**
     * Check if a key is considered sensitive
     *
     * @param key The key to check
     * @return true if the key is sensitive
     */
    public static boolean isSensitiveKey(String key) {
        if (key == null) return false;

        String lowerKey = key.toLowerCase();

        for (String sensitiveKey : SENSITIVE_KEYS) {
            if (lowerKey.contains(sensitiveKey.toLowerCase())) {
                return true;
            }
        }

        return false;
    }

    /**
     * Filter user information
     *
     * @param userId   User ID (can be kept)
     * @param username Username (can be kept)
     * @param email    Email (kept for crash identification)
     * @return Filtered user information
     */
    public static UserInfo filterUserInfo(String userId, String username, String email) {
        return new UserInfo(userId, username, email);
    }

    /**
     * Filter device information
     *
     * @param deviceInfo Original device info
     * @return Filtered device info
     */
    public static Map<String, Object> filterDeviceInfo(Map<String, Object> deviceInfo) {
        if (deviceInfo == null) return null;

        Map<String, Object> filtered = new HashMap<>(deviceInfo);

        // Remove or filter sensitive device information
        filtered.remove("device.name");
        filtered.remove("device.fingerprint");
        filtered.remove("device.serial");

        return filtered;
    }

    /**
     * Filter network information
     *
     * @param networkInfo Original network info
     * @return Filtered network info
     */
    public static Map<String, Object> filterNetworkInfo(Map<String, Object> networkInfo) {
        if (networkInfo == null) return null;

        Map<String, Object> filtered = new HashMap<>(networkInfo);

        // Remove sensitive network information
        filtered.remove("ip_address");
        filtered.remove("mac_address");
        filtered.remove("ssid");
        filtered.remove("bssid");

        return filtered;
    }

    /**
     * Filter ReportData object
     *
     * @param reportData Original report data
     * @return Filtered report data
     */
    public static ReportData filterReportData(ReportData reportData) {
        if (reportData == null) return null;

        try {
            // Create new ReportData with filtered information
            ReportData.Builder builder = new ReportData.Builder()
                    .message(filterSensitiveText(reportData.getMessage()))
                    .level(reportData.getLevel())
                    .category(reportData.getCategory())
                    .operation(reportData.getOperation())
                    .tags(filterSensitiveData(reportData.getTags()))
                    .context(filterSensitiveData(reportData.getContext()))
                    .exception(reportData.getException())
                    .timestamp(reportData.getTimestamp())
                    .userId(reportData.getUserId())
                    .sessionId(reportData.getSessionId());

            return builder.build();

        } catch (Exception e) {
            Log.w(TAG, "Error filtering report data", e);
            return reportData; // Return original if filtering fails
        }
    }

    /**
     * Immutable user information container
     */
    public record UserInfo(String userId, String username, String email) {
    }
} 