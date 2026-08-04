package com.mentra.asg_client.logging;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Process;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;

public final class BleTraceLogger {
    private static final String TAG = "MentraBleTrace";
    private static final int MAX_PAYLOAD_CHARS = 3000;
    private static final String SOURCE = "asg_client";
    private static final String K900_TYPE = "k900";
    private static final String[] SENSITIVE_KEY_PARTS = {
        "password", "pass", "token", "secret", "authorization", "auth", "email"
    };

    private BleTraceLogger() {}

    public static void logWireMetrics(
            String direction,
            String layer,
            String messageType,
            int payloadBytes,
            int wireBytes,
            int packetCount,
            long latencyMs,
            int protocolVersion) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("payload_bytes", payloadBytes);
            payload.put("wire_bytes", wireBytes);
            payload.put("packet_count", packetCount);
            payload.put("latency_ms", latencyMs);
            payload.put("protocol_version", protocolVersion);
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }
        logEvent(direction, layer, messageType, payload);
    }

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

    public static void logEvent(String direction, String layer, String type, JSONObject payload) {
        JSONObject sanitized = payload != null ? sanitize(payload) : new JSONObject();
        Log.i(TAG, format(direction, layer, caller(), type, null, sanitized.toString()));
    }

    public static void logBesTraceLine(String line) {
        if (line == null || line.trim().isEmpty()) {
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("line", sanitizeTraceText(line));
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }
        logEvent("bes_to_asg", "bes_trace_log", "trace", payload);
    }

    public static void logK900Frame(String direction, String layer, byte[] frame) {
        logK900Frame(direction, layer, frame, frame != null ? frame.length : null);
    }

    public static void logK900Frame(String direction, String layer, byte[] frame, Integer bytes) {
        JSONObject payload = parseK900Frame(frame);
        if (payload != null) {
            logJson(direction, layer, payload, bytes);
            return;
        }
        logBytes(direction, layer, frame);
    }

    public static void logLifecycle(Context context, String component, String event) {
        logLifecycle(context, component, event, null);
    }

    public static void logLifecycle(Context context, String component, String event, JSONObject extra) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("event", event);
            payload.put("component", component);
            payload.put("pid", Process.myPid());
            payload.put("model", Build.MODEL);
            payload.put("sdkInt", Build.VERSION.SDK_INT);

            if (context != null) {
                payload.put("package", context.getPackageName());
                String version = packageVersion(context);
                if (version != null) {
                    payload.put("version", version);
                }
            }

            if (extra != null) {
                Iterator<String> keys = extra.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    payload.put(key, extra.opt(key));
                }
            }
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }

        Log.i(TAG, format("glasses_app", "app_lifecycle", caller(), event, null, sanitize(payload).toString()));
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
            return extractK900Type(cValue);
        }

        return "unknown";
    }

    private static String extractK900Type(String cValue) {
        if ("sr_log".equals(cValue)) {
            return K900_TYPE + ":sr_log";
        }
        return K900_TYPE;
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

    private static JSONObject parseK900Frame(byte[] frame) {
        if (frame == null || frame.length < 7) {
            return null;
        }
        if (frame[0] != 0x23 || frame[1] != 0x23) {
            return null;
        }
        if (frame[frame.length - 2] != 0x24 || frame[frame.length - 1] != 0x24) {
            return null;
        }

        int bigEndianLength = ((frame[3] & 0xFF) << 8) | (frame[4] & 0xFF);
        int littleEndianLength = (frame[3] & 0xFF) | ((frame[4] & 0xFF) << 8);
        int payloadLength = littleEndianLength;
        if (payloadLength + 7 != frame.length && bigEndianLength + 7 == frame.length) {
            payloadLength = bigEndianLength;
        }
        if (frame[2] == 0x40) {
            JSONObject binaryPayload = new JSONObject();
            try {
                binaryPayload.put("frameType", "0x40");
                binaryPayload.put("length", payloadLength);
                binaryPayload.put("binary", true);
            } catch (Exception ignored) {
                // Keep trace logging non-fatal.
            }
            return binaryPayload;
        }
        if (payloadLength <= 0 || payloadLength + 7 > frame.length) {
            return null;
        }

        String payload = new String(frame, 5, payloadLength, StandardCharsets.UTF_8);
        JSONObject json = parseJson(payload);
        if (json != null) {
            return json;
        }

        JSONObject rawPayload = new JSONObject();
        try {
            rawPayload.put("frameType", String.format(Locale.US, "0x%02X", frame[2] & 0xFF));
            rawPayload.put("length", payloadLength);
            rawPayload.put("payload", truncate(payload));
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }
        return rawPayload;
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
            return sanitizeK900Command((String) value);
        }
        if (value instanceof JSONObject) {
            return sanitize((JSONObject) value);
        }
        if (value instanceof JSONArray) {
            return sanitize((JSONArray) value);
        }
        return value;
    }

    private static String sanitizeK900Command(String value) {
        if ("sr_log".equals(value)) {
            return value;
        }
        return "<non-json C payload>";
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

    private static String sanitizeTraceText(String value) {
        if (value == null) {
            return null;
        }
        String sanitized = value;
        for (String sensitivePart : SENSITIVE_KEY_PARTS) {
            sanitized = sanitized.replaceAll(
                "(?i)([\"']?" + sensitivePart + "[\"']?\\s*[:=]\\s*)([\"'][^\"']*[\"']|[^,;\\s}]+)",
                "$1<redacted>"
            );
        }
        return truncate(sanitized);
    }

    private static String caller() {
        return SOURCE;
    }

    private static String packageVersion(Context context) {
        try {
            PackageInfo packageInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long versionCode;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                versionCode = packageInfo.getLongVersionCode();
            } else {
                versionCode = packageInfo.versionCode;
            }
            String versionName = packageInfo.versionName != null ? packageInfo.versionName : "unknown";
            return versionName + "+" + versionCode;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String truncate(String value) {
        if (value == null || value.length() <= MAX_PAYLOAD_CHARS) {
            return value;
        }
        return value.substring(0, MAX_PAYLOAD_CHARS)
            + "...(truncated " + (value.length() - MAX_PAYLOAD_CHARS) + " chars)";
    }
}
