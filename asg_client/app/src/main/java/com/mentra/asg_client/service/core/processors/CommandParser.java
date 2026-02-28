package com.mentra.asg_client.service.core.processors;

import android.util.Log;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * JSON parsing component following Single Responsibility Principle.
 * 
 * This class is responsible for parsing byte array data into JSONObject,
 * supporting both K900 protocol format (##...$$) and direct JSON format.
 */
public class CommandParser {
    private static final String TAG = "JsonParser";

    /**
     * Parses byte array data into a JSONObject, supporting both K900 protocol format (##...$$)
     * and direct JSON format.
     * 
     * @param data The byte array to parse
     * @return JSONObject if parsing succeeds, null otherwise
     */
    public JSONObject parseToJson(byte[] data) {
        if (data == null || data.length == 0) {
            Log.w(TAG, "parseToJson: Received null or empty data");
            return null;
        }

        // Try K900 protocol format first (##...$$)
        JSONObject k900Result = parseK900ProtocolMessage(data);
        if (k900Result != null) {
            return k900Result;
        }

        // Try direct JSON format
        return parseDirectJsonMessage(data);
    }

    /**
     * Parse K900 protocol message format (##...$$).
     * 
     * @param data The byte array containing K900 protocol data
     * @return JSONObject if parsing succeeds, null otherwise
     */
    private JSONObject parseK900ProtocolMessage(byte[] data) {
        if (!isK900ProtocolMessage(data)) {
            return null;
        }

        int endMarkerPos = findEndMarker(data);
        if (endMarkerPos <= 0) {
            Log.w(TAG, "parseK900ProtocolMessage: End marker not found");
            return null;
        }

        int payloadStart = 5;
        int payloadLength = endMarkerPos - payloadStart;

        if (payloadLength <= 0) {
            Log.w(TAG, "parseK900ProtocolMessage: Invalid payload length: " + payloadLength);
            return null;
        }

        if (data[payloadStart] != '{') {
            Log.w(TAG, "parseK900ProtocolMessage: Payload does not start with '{'");
            return null;
        }

        return parseJsonString(data, payloadStart, payloadLength, "K900 protocol");
    }

    /**
     * Parse direct JSON message format.
     * 
     * @param data The byte array containing direct JSON data
     * @return JSONObject if parsing succeeds, null otherwise
     */
    private JSONObject parseDirectJsonMessage(byte[] data) {
        if (data[0] != '{') {
            return null;
        }
        return parseJsonString(data, 0, data.length, "direct JSON");
    }

    /**
     * Parse JSON string from byte array with specified offset and length.
     * 
     * @param data The byte array containing JSON data
     * @param offset The starting offset in the byte array
     * @param length The length of the JSON data
     * @param source Description of the data source for logging
     * @return JSONObject if parsing succeeds, null otherwise
     */
    private JSONObject parseJsonString(byte[] data, int offset, int length, String source) {
        try {
            String jsonStr = new String(data, offset, length, StandardCharsets.UTF_8);
            JSONObject jsonObject = new JSONObject(jsonStr);
            
            // Log truncated JSON for debugging (first 100 characters)
            String truncatedJson = jsonStr.substring(0, Math.min(100, jsonStr.length()));
            Log.d(TAG, "✅ Successfully parsed " + source + " JSON: " + truncatedJson + "...");
            
            return jsonObject;
        } catch (JSONException e) {
            Log.e(TAG, "❌ JSON parsing error for " + source + ": " + e.getMessage());
            return null;
        } catch (Exception e) {
            Log.e(TAG, "❌ Unexpected error parsing " + source + " JSON", e);
            return null;
        }
    }

    /**
     * Find the end marker ($$) in K900 protocol data.
     * 
     * @param data The byte array to search
     * @return Position of the end marker, or -1 if not found
     */
    private int findEndMarker(byte[] data) {
        for (int i = 4; i < data.length - 1; i++) {
            if (data[i] == 0x24 && data[i + 1] == 0x24) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Check if the data follows K900 protocol format (starts with ##).
     * 
     * @param data The byte array to check
     * @return true if it's a K900 protocol message, false otherwise
     */
    private boolean isK900ProtocolMessage(byte[] data) {
        return data.length > 4 && data[0] == 0x23 && data[1] == 0x23;
    }

    /**
     * Validate if a JSON string is well-formed.
     * 
     * @param jsonString The JSON string to validate
     * @return true if valid JSON, false otherwise
     */
    public boolean isValidJson(String jsonString) {
        if (jsonString == null || jsonString.trim().isEmpty()) {
            return false;
        }
        
        try {
            new JSONObject(jsonString);
            return true;
        } catch (JSONException e) {
            return false;
        }
    }

    /**
     * Create a JSON object from a string with error handling.
     * 
     * @param jsonString The JSON string to parse
     * @return JSONObject if parsing succeeds, null otherwise
     */
    public JSONObject parseJsonString(String jsonString) {
        if (!isValidJson(jsonString)) {
            Log.w(TAG, "Invalid JSON string provided: " + jsonString);
            return null;
        }
        
        try {
            return new JSONObject(jsonString);
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing JSON string", e);
            return null;
        }
    }
} 