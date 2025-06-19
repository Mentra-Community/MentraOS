package com.augmentos.augmentos_core.statushelpers;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

public class JsonHelper {
    public static Map<String, Object> convertJsonToMap(JSONObject jsonObject) throws JSONException {
        Map<String, Object> map = new HashMap<>();
        Iterator<String> keys = jsonObject.keys();

        while(keys.hasNext()) {
            String key = keys.next();
            Object value = jsonObject.get(key);

            // Handle nested objects
            if (value instanceof JSONObject) {
                map.put(key, convertJsonToMap((JSONObject) value));
            }
            // Handle arrays
            else if (value instanceof JSONArray) {
                map.put(key, convertJsonArrayToList((JSONArray) value));
            }
            // Handle primitive values
            else {
                map.put(key, value);
            }
        }

        return map;
    }

    // Helper method to convert JSONArray to List
    public static List<Object> convertJsonArrayToList(JSONArray jsonArray) throws JSONException {
        List<Object> list = new ArrayList<>();

        for (int i = 0; i < jsonArray.length(); i++) {
            Object value = jsonArray.get(i);
            if (value instanceof JSONObject) {
                list.add(convertJsonToMap((JSONObject) value));
            }
            else if (value instanceof JSONArray) {
                list.add(convertJsonArrayToList((JSONArray) value));
            }
            else {
                list.add(value);
            }
        }

        return list;
    }

    /**
     * Processes all string values in a JSONObject, replacing any occurrences of placeholders.
     * This method recursively traverses the JSON structure to find all string values.
     *
     * @param jsonObj The JSONObject to process
     * @param placeholders Map of placeholders to their replacements
     * @return A new JSONObject with all placeholders replaced
     * @throws JSONException If there's an error processing the JSON
     */
    public static JSONObject processJSONPlaceholders(JSONObject jsonObj, Map<String, String> placeholders) throws JSONException {
        JSONObject result = new JSONObject();
        Iterator<String> keys = jsonObj.keys();

        while (keys.hasNext()) {
            String key = keys.next();
            Object value = jsonObj.get(key);

            if (value instanceof JSONObject) {
                // Recursively process nested JSONObjects
                result.put(key, processJSONPlaceholders((JSONObject) value, placeholders));
            } else if (value instanceof JSONArray) {
                // Process JSONArrays
                result.put(key, processJSONArrayPlaceholders((JSONArray) value, placeholders));
            } else if (value instanceof String) {
                // Replace all placeholders in string values
                String strValue = (String) value;
                String processedValue = strValue;
                for (Map.Entry<String, String> entry : placeholders.entrySet()) {
                    if (processedValue.contains(entry.getKey())) {
                        processedValue = processedValue.replace(entry.getKey(), entry.getValue());
                    }
                }
                result.put(key, processedValue);
            } else {
                // Keep other types unchanged
                result.put(key, value);
            }
        }

        return result;
    }

    /**
     * Single placeholder version for backward compatibility
     *
     * @param jsonObj The JSONObject to process
     * @param placeholder The placeholder string to search for
     * @param replacement The string to replace the placeholder with
     * @return A new JSONObject with all placeholders replaced
     * @throws JSONException If there's an error processing the JSON
     */
    public static JSONObject processJSONPlaceholders(JSONObject jsonObj, String placeholder, String replacement) throws JSONException {
        Map<String, String> placeholders = new HashMap<>();
        placeholders.put(placeholder, replacement);
        return processJSONPlaceholders(jsonObj, placeholders);
    }

    /**
     * Processes all string values in a JSONArray, replacing any occurrences of placeholders.
     *
     * @param jsonArray The JSONArray to process
     * @param placeholders Map of placeholders to their replacements
     * @return A new JSONArray with all placeholders replaced
     * @throws JSONException If there's an error processing the JSON
     */
    public static JSONArray processJSONArrayPlaceholders(JSONArray jsonArray, Map<String, String> placeholders) throws JSONException {
        JSONArray result = new JSONArray();

        for (int i = 0; i < jsonArray.length(); i++) {
            Object value = jsonArray.get(i);

            if (value instanceof JSONObject) {
                // Recursively process nested JSONObjects
                result.put(processJSONPlaceholders((JSONObject) value, placeholders));
            } else if (value instanceof JSONArray) {
                // Recursively process nested JSONArrays
                result.put(processJSONArrayPlaceholders((JSONArray) value, placeholders));
            } else if (value instanceof String) {
                // Replace all placeholders in string values
                String strValue = (String) value;
                String processedValue = strValue;
                for (Map.Entry<String, String> entry : placeholders.entrySet()) {
                    if (processedValue.contains(entry.getKey())) {
                        processedValue = processedValue.replace(entry.getKey(), entry.getValue());
                    }
                }
                result.put(processedValue);
            } else {
                // Keep other types unchanged
                result.put(value);
            }
        }

        return result;
    }

    /**
     * Single placeholder version for backward compatibility
     *
     * @param jsonArray The JSONArray to process
     * @param placeholder The placeholder string to search for
     * @param replacement The string to replace the placeholder with
     * @return A new JSONArray with all placeholders replaced
     * @throws JSONException If there's an error processing the JSON
     */
    public static JSONArray processJSONArrayPlaceholders(JSONArray jsonArray, String placeholder, String replacement) throws JSONException {
        Map<String, String> placeholders = new HashMap<>();
        placeholders.put(placeholder, replacement);
        return processJSONArrayPlaceholders(jsonArray, placeholders);
    }
}
