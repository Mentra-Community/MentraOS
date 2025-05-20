package com.augmentos.augmentos_core.smarterglassesmanager.utils;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/**
 * Utility class for K900 BES2700 protocol formatting.
 * Used for communication between AugmentOS Core and ASG Client.
 */
public class K900ProtocolUtils {
    
    // Protocol constants
    public static final byte[] CMD_START_CODE = new byte[]{0x23, 0x23}; // ##
    public static final byte[] CMD_END_CODE = new byte[]{0x24, 0x24}; // $$
    public static final byte CMD_TYPE_STRING = 0x30; // String/JSON type
    
    // JSON Field constants
    public static final String FIELD_C = "C";  // Command/Content field
    public static final String FIELD_V = "V";  // Version field
    public static final String FIELD_B = "B";  // Body field
    
    /**
     * Pack a JSON string into the proper K900 format:
     * 1. Wrap with C-field: {"C": jsonData}
     * 2. Then pack with BES2700 protocol: ## + type + length + {"C": jsonData} + $$
     *
     * @param jsonData The JSON string to pack
     * @return Byte array with packed data according to protocol format
     */
    public static byte[] packJsonCommand(String jsonData) {
        if (jsonData == null) {
            return null;
        }
        
        try {
            // First wrap with C-field
            JSONObject wrapper = new JSONObject();
            wrapper.put(FIELD_C, jsonData);
            
            // Convert to string
            String wrappedJson = wrapper.toString();
            
            // Then pack with BES2700 protocol format
            byte[] jsonBytes = wrappedJson.getBytes(StandardCharsets.UTF_8);
            return packDataCommand(jsonBytes, CMD_TYPE_STRING);
            
        } catch (JSONException e) {
            android.util.Log.e("K900ProtocolUtils", "Error creating JSON wrapper", e);
            return null;
        }
    }
    
    /**
     * Pack raw byte data with K900 BES2700 protocol format
     * Format: ## + command_type + length(2bytes) + data + $$
     *
     * @param data The raw data to pack
     * @param cmdType The command type (use CMD_TYPE_STRING for JSON)
     * @return Byte array with packed data according to protocol format
     */
    public static byte[] packDataCommand(byte[] data, byte cmdType) {
        if (data == null) {
            return null;
        }
        
        int dataLength = data.length;
        
        // Command structure: ## + type + length(2 bytes) + data + $$
        byte[] result = new byte[dataLength + 7]; // 2(start) + 1(type) + 2(length) + data + 2(end)
        
        // Start code ##
        result[0] = CMD_START_CODE[0]; // #
        result[1] = CMD_START_CODE[1]; // #
        
        // Command type
        result[2] = cmdType;
        
        // Length (2 bytes, big-endian)
        result[3] = (byte)((dataLength >> 8) & 0xFF); // MSB first
        result[4] = (byte)(dataLength & 0xFF);        // LSB second
        
        // Original little-endian implementation (commented out)
        // result[3] = (byte)(dataLength & 0xFF);        // LSB first
        // result[4] = (byte)((dataLength >> 8) & 0xFF); // MSB second
        
        // Copy the data
        System.arraycopy(data, 0, result, 5, dataLength);
        
        // End code $$
        result[5 + dataLength] = CMD_END_CODE[0]; // $
        result[6 + dataLength] = CMD_END_CODE[1]; // $
        
        return result;
    }
    
    /**
     * Formats a standard ASG-client JSON message for transmission to MentraLiveSGC
     * This does both:
     * 1. Wrap with C-field: {"C": jsonData}
     * 2. Format with BES2700 protocol: ## + type + length + data + $$
     *
     * @param jsonData The JSON string to format (must be valid JSON)
     * @return Formatted bytes ready for transmission
     */
    public static byte[] formatMessageForTransmission(String jsonData) {
        try {
            android.util.Log.e("K900ProtocolUtils", "🔄 Formatting message: " + jsonData);
            
            // Validate that input is proper JSON
            new JSONObject(jsonData);
            
            // First, create C wrapper: {"C": jsonData}
            JSONObject wrapper = new JSONObject();
            wrapper.put(FIELD_C, jsonData);
            wrapper.put(FIELD_V, 1); // Optional version field
            wrapper.put(FIELD_B, new JSONObject()); // Optional body field
            String wrappedJson = wrapper.toString();
            android.util.Log.e("K900ProtocolUtils", "🔄 After C-wrapping: " + wrappedJson);
            
            // Now format with BES2700 protocol
            byte[] result = packDataCommand(wrappedJson.getBytes(StandardCharsets.UTF_8), CMD_TYPE_STRING);
            
            // Log some bytes for debugging
            StringBuilder hexDump = new StringBuilder();
            for (int i = 0; i < Math.min(result.length, 30); i++) {
                hexDump.append(String.format("%02X ", result[i]));
            }
            android.util.Log.e("K900ProtocolUtils", "🔄 After protocol formatting (first 30 bytes): " + hexDump);
            android.util.Log.e("K900ProtocolUtils", "🔄 Final length: " + result.length + " bytes");
            
            return result;
            
        } catch (JSONException e) {
            android.util.Log.e("K900ProtocolUtils", "❌ Error in formatMessageForTransmission", e);
            // Fallback: if json is invalid, still try to pack it without validation
            return packJsonCommand(jsonData);
        }
    }
    
    /**
     * Create a C-wrapped JSON object ready for protocol formatting
     * Format: {"C": content}
     *
     * @param content The content to wrap in the C field
     * @return C-wrapped JSON string
     */
    public static String createCWrappedJson(String content) {
        try {
            JSONObject wrapper = new JSONObject();
            wrapper.put(FIELD_C, content);
            return wrapper.toString();
        } catch (JSONException e) {
            android.util.Log.e("K900ProtocolUtils", "Error creating C-wrapped JSON", e);
            return null;
        }
    }
    
    /**
     * Check if data follows the K900 BES2700 protocol format
     * Verifies if data starts with ## markers
     */
    public static boolean isK900ProtocolFormat(byte[] data) {
        if (data == null || data.length < 7) { // Minimum protocol size
            return false;
        }
        
        return data[0] == CMD_START_CODE[0] && 
               data[1] == CMD_START_CODE[1];
    }
    
    /**
     * Check if a JSON string is already properly formatted for K900 protocol
     * This can either be:
     * 1. Simple C-wrapped format: {"C": "content"} 
     * 2. Full K900 format: {"C": "command", "V": value, "B": body}
     * 
     * @return true if already in proper format, false otherwise
     */
    public static boolean isCWrappedJson(String jsonStr) {
        try {
            JSONObject json = new JSONObject(jsonStr);
            
            // Check for simple C-wrapping {"C": "content"} - only one field
            if (json.has(FIELD_C) && json.length() == 1) {
                return true;
            }
            
            // Check for full K900 format {"C": "command", "V": val, "B": body}
            if (json.has(FIELD_C) && json.has(FIELD_V) && json.has(FIELD_B)) {
                return true;
            }
            
            return false;
        } catch (JSONException e) {
            return false;
        }
    }
    
    /**
     * Extract payload from K900 protocol formatted data
     * @return Raw payload data or null if format is invalid
     */
    public static byte[] extractPayload(byte[] protocolData) {
        if (!isK900ProtocolFormat(protocolData) || protocolData.length < 7) {
            return null;
        }
        
        // Extract length (big-endian)
        int length = ((protocolData[3] & 0xFF) << 8) | (protocolData[4] & 0xFF);
        
        // Original little-endian implementation (commented out)
        // int length = (protocolData[3] & 0xFF) | ((protocolData[4] & 0xFF) << 8);
        
        if (length + 7 > protocolData.length) {
            return null; // Invalid length
        }
        
        // Extract payload
        byte[] payload = new byte[length];
        System.arraycopy(protocolData, 5, payload, 0, length);
        return payload;
    }
    
    /**
     * Process received bytes from Bluetooth into a JSON object
     * Handles K900 protocol format detection, payload extraction, and C-field unwrapping
     *
     * @param data The raw bytes received from Bluetooth
     * @return Parsed JSON object or null if not valid protocol data or valid JSON
     */
    public static JSONObject processReceivedBytesToJson(byte[] data) {
        android.util.Log.d("K900ProtocolUtils", "Processing received bytes for JSON extraction");
        
        // Check for null or too small data
        if (data == null || data.length < 7) {
            android.util.Log.d("K900ProtocolUtils", "Received data is null or too short to be valid protocol data");
            return null;
        }
        
        // Verify if this is K900 protocol format (starts with ##)
        if (!isK900ProtocolFormat(data)) {
            android.util.Log.d("K900ProtocolUtils", "Not in K900 protocol format (missing ## markers)");
            return null;
        }
        
        // Extract the command type
        byte commandType = data[2];
        
        // Extract the length using big-endian format (MSB first)
        int payloadLength = ((data[3] & 0xFF) << 8) | (data[4] & 0xFF);
        
        android.util.Log.d("K900ProtocolUtils", "Command type: 0x" + String.format("%02X", commandType) + 
                         ", Payload length: " + payloadLength);
        
        // Verify we have enough data and the right command type
        if (commandType != CMD_TYPE_STRING) {
            android.util.Log.d("K900ProtocolUtils", "Not a JSON/string command type (0x30), got: 0x" + 
                            String.format("%02X", commandType));
            return null;
        }
        
        if (data.length < payloadLength + 7) {
            android.util.Log.d("K900ProtocolUtils", "Received data size (" + data.length + 
                           ") is less than expected size (" + (payloadLength + 7) + ")");
            return null;
        }
        
        // Check for end markers ($$)
        if (data[5 + payloadLength] != CMD_END_CODE[0] || data[6 + payloadLength] != CMD_END_CODE[1]) {
            android.util.Log.d("K900ProtocolUtils", "End markers ($$) not found where expected");
            return null;
        }
        
        // Extract the payload
        byte[] payload = new byte[payloadLength];
        System.arraycopy(data, 5, payload, 0, payloadLength);
        
        // Convert to string
        String payloadStr;
        try {
            payloadStr = new String(payload, StandardCharsets.UTF_8);
            android.util.Log.d("K900ProtocolUtils", "Extracted payload: " + payloadStr);
        } catch (Exception e) {
            android.util.Log.e("K900ProtocolUtils", "Error converting payload to string", e);
            return null;
        }
        
        // Check if it's valid JSON
        if (!payloadStr.startsWith("{") || !payloadStr.endsWith("}")) {
            android.util.Log.d("K900ProtocolUtils", "Payload is not valid JSON: " + payloadStr);
            return null;
        }
        
        try {
            // Parse the JSON payload
            JSONObject json = new JSONObject(payloadStr);
            
            // Check if this is C-wrapped format {"C": "..."}
            if (json.has(FIELD_C)) {
                String innerContent = json.optString(FIELD_C, "");
                android.util.Log.d("K900ProtocolUtils", "Detected C-wrapped format, inner content: " + innerContent);
                
                // Try to parse the inner content as JSON
                try {
                    JSONObject innerJson = new JSONObject(innerContent);
                    return innerJson;
                } catch (JSONException e) {
                    android.util.Log.d("K900ProtocolUtils", "Inner content is not JSON, returning outer JSON object");
                    // If inner content is not JSON, return the outer JSON
                    return json;
                }
            } else {
                // Not C-wrapped, return the JSON directly
                return json;
            }
        } catch (JSONException e) {
            android.util.Log.e("K900ProtocolUtils", "Error parsing JSON payload: " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * Unified method to prepare data for transmission according to K900 protocol
     * This handles all formatting cases:
     * 1. Data already in protocol format
     * 2. JSON data that needs C-wrapping
     * 3. Raw data that needs protocol packaging
     * 
     * @param data The raw data to prepare for transmission
     * @return Properly formatted data according to K900 protocol
     */
    public static byte[] prepareDataForTransmission(byte[] data) {
        if (data == null || data.length == 0) {
            return null;
        }
        
        // If already in protocol format, don't modify
        if (isK900ProtocolFormat(data)) {
            return data;
        }
        
        // Try to interpret as a JSON string that needs C-wrapping and protocol formatting
        try {
            // Convert to string for processing
            String originalData = new String(data, "UTF-8");
            
            // If looks like JSON but not C-wrapped, use the full formatting function
            if (originalData.startsWith("{") && !isCWrappedJson(originalData)) {
                android.util.Log.d("K900ProtocolUtils", "📦 JSON DATA BEFORE C-WRAPPING: " + originalData);
                byte[] formattedData = formatMessageForTransmission(originalData);
                
                // Debug log the formatting results if needed
                if (android.util.Log.isLoggable("K900ProtocolUtils", android.util.Log.DEBUG)) {
                    StringBuilder hexDump = new StringBuilder();
                    for (int i = 0; i < Math.min(formattedData.length, 50); i++) {
                        hexDump.append(String.format("%02X ", formattedData[i]));
                    }
                    android.util.Log.d("K900ProtocolUtils", "📦 AFTER C-WRAPPING & PROTOCOL FORMATTING (first 50 bytes): " + hexDump.toString());
                    android.util.Log.d("K900ProtocolUtils", "📦 Total formatted length: " + formattedData.length + " bytes");
                }
                
                return formattedData;
            } else {
                // Otherwise just apply protocol formatting
                android.util.Log.d("K900ProtocolUtils", "📦 Data already C-wrapped or not JSON: " + originalData);
                android.util.Log.d("K900ProtocolUtils", "Formatting data with K900 protocol (adding ##...)");
                return packDataCommand(data, CMD_TYPE_STRING);
            }
        } catch (Exception e) {
            // If we can't interpret as string, just apply protocol formatting to raw bytes
            android.util.Log.d("K900ProtocolUtils", "Applying protocol format to raw bytes");
            return packDataCommand(data, CMD_TYPE_STRING);
        }
    }
    
    /**
     * Check if the device is a K900
     * @param context The application context
     * @return true if the device is a K900, false otherwise
     */
    public static boolean isK900Device(Context context) {
        // Check for K900-specific broadcast receivers
        try {
            // Verify the SystemUI package exists
            PackageManager pm = context.getPackageManager();
            pm.getPackageInfo("com.android.systemui", 0);
            
            // Check for K900-specific system action
            try {
                // Set up a result receiver to check if our probe was received
                final boolean[] responseReceived = {false};
                BroadcastReceiver testReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        responseReceived[0] = true;
                        try {
                            context.unregisterReceiver(this);
                        } catch (Exception e) {
                            // Ignore unregister failures
                        }
                    }
                };
                
                // Register for any response from our probe
                context.registerReceiver(testReceiver, 
                        new IntentFilter("com.xy.xsetting.response"));
                
                // Send a test probe
                Intent testIntent = new Intent("com.xy.xsetting.action");
                testIntent.setPackage("com.android.systemui");
                testIntent.putExtra("cmd", "test_k900");
                context.sendBroadcast(testIntent);
                
                // In a real implementation, we would wait for a response
                // For now, we check device model as a fallback
                String model = android.os.Build.MODEL.toLowerCase();
                return model.contains("k900") || model.contains("xyglasses");
            } catch (Exception e) {
                Log.e("K900ProtocolUtils", "Error checking for K900 specific broadcast", e);
            }
        } catch (Exception e) {
            Log.d("K900ProtocolUtils", "Not a K900 device: " + e.getMessage());
        }
        
        return false;
    }
}