package com.mentra.asg_client.service.utils;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Utility class for common service operations.
 * Provides shared functionality used across different service components.
 */
public class ServiceUtils {
    
    private static final String TAG = "ServiceUtils";
    
    /**
     * Check if data is a valid JSON message
     * @param data Data to check
     * @return true if valid JSON, false otherwise
     */
    public static boolean isValidJsonMessage(byte[] data) {
        if (data == null || data.length == 0) {
            return false;
        }
        
        // Check for JSON format (starts with {)
        return data.length > 0 && data[0] == '{';
    }
    
    /**
     * Check if data is a K900 protocol message
     * @param data Data to check
     * @return true if K900 protocol, false otherwise
     */
    public static boolean isK900ProtocolMessage(byte[] data) {
        return data.length > 4 && data[0] == 0x23 && data[1] == 0x23;
    }
    
    /**
     * Extract JSON from K900 protocol message
     * @param data K900 protocol data
     * @return JSON string or null if extraction fails
     */
    public static String extractJsonFromK900Protocol(byte[] data) {
        try {
            // Look for end marker ($$)
            int endMarkerPos = -1;
            for (int i = 4; i < data.length - 1; i++) {
                if (data[i] == 0x24 && data[i+1] == 0x24) {
                    endMarkerPos = i;
                    break;
                }
            }
            
            if (endMarkerPos > 0) {
                int payloadStart = 5;
                int payloadLength = endMarkerPos - payloadStart;
                
                if (payloadLength > 0 && data[payloadStart] == '{') {
                    return new String(data, payloadStart, payloadLength, StandardCharsets.UTF_8);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error extracting JSON from K900 protocol", e);
        }
        
        return null;
    }
    
    /**
     * Format duration in milliseconds to human-readable string
     * @param durationMs Duration in milliseconds
     * @return Formatted duration string
     */
    public static String formatDuration(long durationMs) {
        if (durationMs < 0) {
            return "Unknown";
        }
        
        long seconds = durationMs / 1000;
        long minutes = seconds / 60;
        long hours = minutes / 60;
        
        if (hours > 0) {
            return String.format(Locale.US, "%dh %dm %ds", hours, minutes % 60, seconds % 60);
        } else if (minutes > 0) {
            return String.format(Locale.US, "%dm %ds", minutes, seconds % 60);
        } else {
            return String.format(Locale.US, "%ds", seconds);
        }
    }
    
    /**
     * Get current timestamp as formatted string
     * @return Formatted timestamp string
     */
    public static String getCurrentTimestamp() {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US);
        return sdf.format(new Date());
    }
    
    /**
     * Create a simple JSON response
     * @param type Response type
     * @param success Success status
     * @param message Optional message
     * @return JSONObject response
     */
    public static JSONObject createSimpleResponse(String type, boolean success, String message) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", type);
            response.put("success", success);
            response.put("timestamp", System.currentTimeMillis());
            
            if (message != null) {
                response.put("message", message);
            }
            
            return response;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating simple response", e);
            return null;
        }
    }
    
    /**
     * Get app version name
     * @param context Application context
     * @return Version name or "1.0.0" if not available
     */
    public static String getAppVersionName(Context context) {
        try {
            return context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0)
                    .versionName;
        } catch (Exception e) {
            Log.e(TAG, "Error getting app version", e);
            return "1.0.0";
        }
    }
    
    /**
     * Get app version code
     * @param context Application context
     * @return Version code as string or "1" if not available
     */
    public static String getAppVersionCode(Context context) {
        try {
            return String.valueOf(context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0)
                    .versionCode);
        } catch (Exception e) {
            Log.e(TAG, "Error getting app version code", e);
            return "1";
        }
    }
    
    /**
     * Check if string is null or empty
     * @param str String to check
     * @return true if null or empty, false otherwise
     */
    public static boolean isNullOrEmpty(String str) {
        return str == null || str.trim().isEmpty();
    }
    
    /**
     * Safely convert string to integer
     * @param str String to convert
     * @param defaultValue Default value if conversion fails
     * @return Integer value or default value
     */
    public static int safeParseInt(String str, int defaultValue) {
        try {
            return Integer.parseInt(str);
        } catch (NumberFormatException e) {
            Log.w(TAG, "Error parsing integer: " + str);
            return defaultValue;
        }
    }
    
    /**
     * Safely convert string to long
     * @param str String to convert
     * @param defaultValue Default value if conversion fails
     * @return Long value or default value
     */
    public static long safeParseLong(String str, long defaultValue) {
        try {
            return Long.parseLong(str);
        } catch (NumberFormatException e) {
            Log.w(TAG, "Error parsing long: " + str);
            return defaultValue;
        }
    }
    
    /**
     * Safely convert string to boolean
     * @param str String to convert
     * @param defaultValue Default value if conversion fails
     * @return Boolean value or default value
     */
    public static boolean safeParseBoolean(String str, boolean defaultValue) {
        if (isNullOrEmpty(str)) {
            return defaultValue;
        }
        
        String lowerStr = str.toLowerCase();
        if ("true".equals(lowerStr) || "1".equals(lowerStr) || "yes".equals(lowerStr)) {
            return true;
        } else if ("false".equals(lowerStr) || "0".equals(lowerStr) || "no".equals(lowerStr)) {
            return false;
        }
        
        return defaultValue;
    }
    
    // ---------------------------------------------
    // Device Detection and Configuration Methods
    // ---------------------------------------------
    
    /**
     * Check if the device is a K900 variant
     * Supports detection of all K900 device types including:
     * - K900
     * - K900Plus
     * - K900PlusV2
     * @param context Application context (optional, can be null)
     * @return true if the device is a K900 variant, false otherwise
     */
    public static boolean isK900Device(Context context) {
        try {
            // Get device model from build properties
            String model = android.os.Build.MODEL;
            String product = android.os.Build.PRODUCT;
            String display = android.os.Build.DISPLAY;
            String fingerprint = android.os.Build.FINGERPRINT;
            String manufacturer = android.os.Build.MANUFACTURER;
            String device = android.os.Build.DEVICE;

            Log.d(TAG, "Device detection - MODEL: " + model +
                      ", PRODUCT: " + product +
                      ", DEVICE: " + device +
                      ", DISPLAY: " + display +
                      ", FINGERPRINT: " + fingerprint +
                      ", MANUFACTURER: " + manufacturer);

            // Check multiple build properties for K900 variants
            String[] propsToCheck = {model, product, device, display, fingerprint, manufacturer};

            for (String prop : propsToCheck) {
                if (prop != null) {
                    String propLower = prop.toLowerCase();

                    // Check for K900 variants
                    if (propLower.contains("k900")) {
                        Log.i(TAG, "K900 device detected via property: " + prop);
                        return true;
                    }

                    // Check for XY glasses identifiers
                    if (propLower.contains("xyglasses") || propLower.contains("xyaiglasses")) {
                        Log.i(TAG, "K900 device detected via XY glasses identifier: " + prop);
                        return true;
                    }

                    // Check for MentraLive (K900 devices)
                    if (propLower.contains("mentralive")) {
                        Log.i(TAG, "K900 device detected via MentraLive identifier: " + prop);
                        return true;
                    }
                }
            }

            Log.d(TAG, "Not a K900 device - no matching identifiers found");
            return false;

        } catch (Exception e) {
            Log.e(TAG, "Error detecting K900 device", e);
            return false;
        }
    }
    
    /**
     * Determine the default rotation for the device based on hardware type
     * @param context Application context (optional, can be null)
     * @return Default rotation in degrees (0, 90, 180, or 270)
     */
    public static int determineDefaultRotationForDevice(Context context) {
        try {
            // Get device model and product for detailed detection
            String model = android.os.Build.MODEL;
            String product = android.os.Build.PRODUCT;
            String display = android.os.Build.DISPLAY;
            
            Log.d(TAG, "Rotation detection - MODEL: " + model + 
                      ", PRODUCT: " + product + 
                      ", DISPLAY: " + display);
            
            // Check multiple build properties for device type
            String[] propsToCheck = {model, product, display};
            
            for (String prop : propsToCheck) {
                if (prop != null) {
                    String propLower = prop.toLowerCase();

                    // MentraLive devices need 90° device rotation (maps to 0° JPEG orientation)
                    if (propLower.contains("mentralive")) {
                        Log.i(TAG, "MentraLive detected - using 90° rotation");
                        return 90;
                    }

                    // K900PlusV2 devices use 0 degrees (no rotation)
                    if (propLower.contains("k900plusv2")) {
                        Log.i(TAG, "K900PlusV2 detected - using 0° rotation");
                        return 90;
                    }

                    // K900Plus (without V2) devices use 270 degrees
                    if (propLower.contains("k900plus")) {
                        Log.i(TAG, "K900Plus detected - using 270° rotation");
                        return 180;
                    }

                    // Standard K900 devices use 270 degrees
                    if (propLower.contains("k900")) {
                        Log.i(TAG, "K900 detected - using 270° rotation");
                        return 180;
                    }
                }
            }
            
            // Default rotation for non-K900 devices
            Log.d(TAG, "Non-K900 device detected - using default 0° rotation");
            return 0;
            
        } catch (Exception e) {
            Log.e(TAG, "Error determining device rotation", e);
            // Safe fallback
            return 0;
        }
    }
    
    /**
     * Get device type string for logging and debugging
     * @param context Application context (optional, can be null)
     * @return Human-readable device type string
     */
    public static String getDeviceTypeString(Context context) {
        try {
            String model = android.os.Build.MODEL;
            String product = android.os.Build.PRODUCT;
            
            if (isK900Device(context)) {
                // Try to determine specific K900 variant
                String[] propsToCheck = {model, product, android.os.Build.DISPLAY};
                
                for (String prop : propsToCheck) {
                    if (prop != null) {
                        String propLower = prop.toLowerCase();
                        if (propLower.contains("k900plusv2")) {
                            return "K900PlusV2";
                        }
                        if (propLower.contains("k900plus")) {
                            return "K900Plus";
                        }
                        if (propLower.contains("k900")) {
                            return "K900";
                        }
                        if (propLower.contains("mentra live")) {
                            return "Mentra Live";
                        }
                        if (propLower.contains("mentralive")) {
                            return "Mentra Live";
                        }
                    }
                }
                return "K900 (variant unknown)";
            } else {
                return "Standard Android (" + model + ")";
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting device type string", e);
            return "Unknown Device";
        }
    }
} 