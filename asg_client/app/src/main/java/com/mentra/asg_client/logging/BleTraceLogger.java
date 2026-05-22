package com.mentra.asg_client.logging;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;

public final class BleTraceLogger {
    private static final String TAG = "MentraBleTrace";
    private static final int MAX_PAYLOAD_CHARS = 3000;
    private static final String[] SENSITIVE_KEY_PARTS = {
        "password", "pass", "token", "secret", "authorization", "auth", "email"
    };

    private BleTraceLogger() {}

    public static void logBytes(String direction, String layer, byte[] data) {
        if (data == null) {
            Log.i(TAG, format(direction, layer, caller(), "null", null, "null"));
            return;
        }

        String payload = new String(data, StandardCharsets.UTF_8);
        JSONObject json = parseJson(payload);
        if (json != null) {
            logJson(direction, layer, json, data.length);
            return;
        }

        Log.i(TAG, format(direction, layer, caller(), "raw", data.length, "<non-json payload>"));
    }

    public static void logJson(String direction, String layer, JSONObject payload) {
        logJson(direction, layer, payload, null);
    }

    public static void logJson(String direction, String layer, JSONObject payload, Integer bytes) {
        if (payload == null) {
            Log.i(TAG, format(direction, layer, caller(), "null", bytes, "null"));
            return;
        }

        JSONObject sanitized = sanitize(payload);
        Log.i(TAG, format(direction, layer, caller(), extractType(payload), bytes, sanitized.toString()));
    }

    private static String format(
        String direction,
        String layer,
        String source,
        String type,
        Integer bytes,
        String payload
    ) {
        String bytesText = bytes != null ? " bytes=" + bytes : "";
        return "BLE_TRACE direction=" + direction
            + " layer=" + layer
            + " source=" + source
            + " type=" + type
            + bytesText
            + " payload=" + truncate(payload);
    }

    private static String extractType(JSONObject payload) {
        String type = payload.optString("type", "");
        if (!type.isEmpty()) {
            return type;
        }

        String cValue = payload.optString("C", "");
        if (!cValue.isEmpty()) {
            JSONObject inner = parseJson(cValue);
            if (inner != null) {
                String innerType = inner.optString("type", "");
                if (!innerType.isEmpty()) {
                    return innerType;
                }
            }
            return "k900:" + cValue.substring(0, Math.min(cValue.length(), 40));
        }

        return "unknown";
    }

    private static JSONObject parseJson(String payload) {
        try {
            String trimmed = payload != null ? payload.trim() : "";
            if (!trimmed.startsWith("{")) {
                return null;
            }
            return new JSONObject(trimmed);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JSONObject sanitize(JSONObject input) {
        JSONObject output = new JSONObject();
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                output.put(key, sanitizeValue(key, input.opt(key)));
            } catch (Exception ignored) {
                // Keep trace logging non-fatal.
            }
        }
        return output;
    }

    private static JSONArray sanitize(JSONArray input) {
        JSONArray output = new JSONArray();
        for (int index = 0; index < input.length(); index++) {
            output.put(sanitizeValue(null, input.opt(index)));
        }
        return output;
    }

    private static Object sanitizeValue(String key, Object value) {
        if (key != null && isSensitiveKey(key)) {
            return "<redacted>";
        }
        if ("C".equals(key) && value instanceof String) {
            JSONObject inner = parseJson((String) value);
            if (inner != null) {
                return sanitize(inner).toString();
            }
            return truncate((String) value);
        }
        if (value instanceof JSONObject) {
            return sanitize((JSONObject) value);
        }
        if (value instanceof JSONArray) {
            return sanitize((JSONArray) value);
        }
        return value;
    }

    private static boolean isSensitiveKey(String key) {
        String lowerKey = key.toLowerCase(Locale.US);
        for (String sensitivePart : SENSITIVE_KEY_PARTS) {
            if (lowerKey.contains(sensitivePart)) {
                return true;
            }
        }
        return false;
    }

    private static String caller() {
        StackTraceElement[] stackTrace = Thread.currentThread().getStackTrace();
        for (StackTraceElement frame : stackTrace) {
            String className = frame.getClassName();
            if (className.equals(BleTraceLogger.class.getName())
                || className.equals(Thread.class.getName())) {
                continue;
            }
            return simpleClassName(className) + "." + frame.getMethodName()
                + "(" + frame.getFileName() + ":" + frame.getLineNumber() + ")";
        }
        return "unknown";
    }

    private static String simpleClassName(String className) {
        int lastDot = className.lastIndexOf('.');
        return lastDot >= 0 ? className.substring(lastDot + 1) : className;
    }

    private static String truncate(String value) {
        if (value == null || value.length() <= MAX_PAYLOAD_CHARS) {
            return value;
        }
        return value.substring(0, MAX_PAYLOAD_CHARS)
            + "...(truncated " + (value.length() - MAX_PAYLOAD_CHARS) + " chars)";
    }
}
