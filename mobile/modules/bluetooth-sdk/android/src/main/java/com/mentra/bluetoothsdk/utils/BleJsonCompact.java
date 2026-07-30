package com.mentra.bluetoothsdk.utils;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** BLE Wire Protocol v2 JSON compaction with lossless fallback for ambiguous payloads. */
public final class BleJsonCompact {

    private static final Map<String, String> LONG_TO_SHORT = new HashMap<>();
    private static final Map<String, String> SHORT_TO_LONG = new HashMap<>();

    private static final Map<String, Integer> PHOTO_STATUS_TO_INT = new HashMap<>();
    private static final Map<Integer, String> PHOTO_STATUS_FROM_INT = new HashMap<>();
    private static final Map<String, Integer> KIND_TO_INT = new HashMap<>();
    private static final Map<Integer, String> KIND_FROM_INT = new HashMap<>();
    private static final Map<String, Integer> SOURCE_TO_INT = new HashMap<>();
    private static final Map<Integer, String> SOURCE_FROM_INT = new HashMap<>();
    private static final Map<String, Integer> AE_STATE_TO_INT = new HashMap<>();
    private static final Map<Integer, String> AE_STATE_FROM_INT = new HashMap<>();

    public static final String KEY_RESOLVED_CONFIG_HASH = "rch";

    /** ROI 8–10 message types: compact outbound and accept compact inbound. */
    private static final Set<String> HIGH_ROI_MESSAGE_TYPES =
            Collections.unmodifiableSet(
                    new HashSet<>(
                            Arrays.asList(
                                    "photo_status",
                                    "stream_status",
                                    "wifi_scan_result",
                                    "start_stream",
                                    "photo_response")));

    /** Structural chunk envelope (always compact on wire). */
    private static final Set<String> CHUNK_MESSAGE_TYPES =
            Collections.unmodifiableSet(new HashSet<>(Arrays.asList("ck", "chunked_msg")));

    private static long sessionConnectEpochMs;
    private static final Map<String, JSONObject> resolvedConfigByHash = new HashMap<>();

    static {
        putKey("type", "t");
        putKey("requestId", "r");
        putKey("timestamp", "ts");
        putKey("status", "s");
        putKey("kind", "k");
        putKey("source", "src");
        putKey("requestedCaptureConfig", "rcc");
        putKey("meteredPreview", "mp");
        putKey("exposureTimeNs", "etn");
        putKey("captureMetadata", "cm");
        putKey("aeStateName", "aes");
        putKey("transferMethod", "tm");
        putKey("manual", "m");
        putKey("reconnecting", "rc");
        putKey("stats", "st");
        putKey("width", "w");
        putKey("height", "h");
        putKey("bitrate", "br");
        putKey("fps", "f");
        putKey("droppedFrames", "df");
        putKey("duration", "du");
        putKey("temperatureC", "tc");

        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "accepted", 0);
        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "queued", 1);
        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "configuring", 2);
        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "capturing", 3);
        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "captured", 4);
        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "uploading", 5);
        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "uploaded", 6);
        putEnum(PHOTO_STATUS_TO_INT, PHOTO_STATUS_FROM_INT, "failed", 7);

        putEnum(KIND_TO_INT, KIND_FROM_INT, "lifecycle", 0);
        putEnum(KIND_TO_INT, KIND_FROM_INT, "snapshot", 1);

        putEnum(SOURCE_TO_INT, SOURCE_FROM_INT, "sdk", 0);
        putEnum(SOURCE_TO_INT, SOURCE_FROM_INT, "button", 1);

        putEnum(AE_STATE_TO_INT, AE_STATE_FROM_INT, "CONVERGED", 0);
        putEnum(AE_STATE_TO_INT, AE_STATE_FROM_INT, "SEARCHING", 1);
        putEnum(AE_STATE_TO_INT, AE_STATE_FROM_INT, "INACTIVE", 2);
        putEnum(AE_STATE_TO_INT, AE_STATE_FROM_INT, "LOCKED", 3);
        putEnum(AE_STATE_TO_INT, AE_STATE_FROM_INT, "FLASH_REQUIRED", 4);
        putEnum(AE_STATE_TO_INT, AE_STATE_FROM_INT, "PRECAPTURE", 5);
    }

    private BleJsonCompact() {}

    public static void resetSession() {
        sessionConnectEpochMs = 0L;
        resolvedConfigByHash.clear();
    }

    public static void markSessionConnected(long epochMs) {
        resetSession();
        sessionConnectEpochMs = epochMs;
    }

    public static boolean isCameraCommandJson(String jsonData) {
        if (jsonData == null || jsonData.isEmpty()) {
            return false;
        }
        return jsonData.contains("cs_pho")
                || jsonData.contains("cs_cpho")
                || jsonData.contains("cs_vid")
                || jsonData.contains("\"type\":\"take_photo\"");
    }

    public static boolean shouldCompactOutbound(String messageType) {
        return messageType != null && HIGH_ROI_MESSAGE_TYPES.contains(messageType);
    }

    public static boolean supportsCompactInbound(String messageType) {
        if (messageType == null || messageType.isEmpty()) {
            return false;
        }
        return HIGH_ROI_MESSAGE_TYPES.contains(messageType)
                || CHUNK_MESSAGE_TYPES.contains(messageType);
    }

    /** Compact wire form uses short `t` key without verbose `type`. */
    public static boolean isCompactWireForm(JSONObject json) {
        return json != null && json.has("t") && !json.has("type");
    }

    public static String extractMessageType(JSONObject json) {
        if (json == null) {
            return "";
        }
        if (json.has("type")) {
            return json.optString("type", "");
        }
        if (json.has("t")) {
            return json.optString("t", "");
        }
        return "";
    }

    public static JSONObject encode(JSONObject json) throws JSONException {
        if (json == null) {
            return null;
        }
        if (isCameraCommandJson(json.toString())) {
            return json;
        }
        String messageType = extractMessageType(json);
        if (!shouldCompactOutbound(messageType) || !canCompactLosslessly(json, true)) {
            return json;
        }
        return compactObject(json, true);
    }

    public static JSONObject encode(String jsonData) throws JSONException {
        if (jsonData == null || !jsonData.startsWith("{")) {
            return null;
        }
        return encode(new JSONObject(jsonData));
    }

    public static JSONObject decode(JSONObject json) throws JSONException {
        if (json == null) {
            return null;
        }
        if (isCameraCommandJson(json.toString())) {
            return json;
        }
        return expandObject(json, true);
    }

    /**
     * Expand compact wire JSON only when the message type is on the ROI allowlist.
     *
     * @return expanded JSON, passthrough expanded JSON, or {@code null} if compact form is unsupported
     */
    public static JSONObject decodeIfSupported(JSONObject json) throws JSONException {
        if (json == null) {
            return null;
        }
        if (isCameraCommandJson(json.toString())) {
            return json;
        }
        if (!isCompactWireForm(json)) {
            return json;
        }
        String compactType = json.optString("t", "");
        if (!supportsCompactInbound(compactType)) {
            return null;
        }
        return expandObject(json, true);
    }

    public static JSONObject decode(String jsonData) throws JSONException {
        if (jsonData == null || !jsonData.startsWith("{")) {
            return null;
        }
        return decode(new JSONObject(jsonData));
    }

    private static void putKey(String longKey, String shortKey) {
        LONG_TO_SHORT.put(longKey, shortKey);
        SHORT_TO_LONG.put(shortKey, longKey);
    }

    private static void putEnum(
            Map<String, Integer> toInt, Map<Integer, String> fromInt, String value, int code) {
        toInt.put(value, code);
        fromInt.put(code, value);
    }

    /**
     * Compact JSON has reserved short keys and enum integers. If an otherwise valid future payload
     * already uses one of those wire representations, sending verbose JSON is the only way an older
     * decoder can distinguish the original value.
     */
    private static boolean canCompactLosslessly(JSONObject input, boolean topLevel)
            throws JSONException {
        String messageType = input.optString("type", input.optString("t", ""));
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = input.get(key);
            if (SHORT_TO_LONG.containsKey(key)
                    || (topLevel && KEY_RESOLVED_CONFIG_HASH.equals(key))
                    || isAmbiguousEnumValue(key, value, messageType)) {
                return false;
            }
            if (value instanceof JSONObject
                    && !canCompactLosslessly((JSONObject) value, false)) {
                return false;
            }
            if (value instanceof JSONArray
                    && !canCompactArrayLosslessly((JSONArray) value)) {
                return false;
            }
        }
        return true;
    }

    private static boolean canCompactArrayLosslessly(JSONArray array) throws JSONException {
        for (int i = 0; i < array.length(); i++) {
            Object value = array.get(i);
            if (value instanceof JSONObject
                    && !canCompactLosslessly((JSONObject) value, false)) {
                return false;
            }
            if (value instanceof JSONArray
                    && !canCompactArrayLosslessly((JSONArray) value)) {
                return false;
            }
        }
        return true;
    }

    private static boolean isAmbiguousEnumValue(
            String key, Object value, String messageType) {
        if (!(value instanceof Number)) {
            return false;
        }
        return "kind".equals(key)
                || "source".equals(key)
                || "aeStateName".equals(key)
                || ("status".equals(key) && "photo_status".equals(messageType));
    }

    private static JSONObject compactObject(JSONObject input, boolean topLevel) throws JSONException {
        JSONObject output = new JSONObject();
        String messageType = input.optString("type", input.optString("t", ""));

        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = input.get(key);
            // Keep the absolute timestamp under its verbose key. Legacy peers recognize it and
            // therefore do not mistake it for the old session-relative `ts` representation.
            String shortKey =
                    topLevel && "timestamp".equals(key)
                            ? key
                            : LONG_TO_SHORT.getOrDefault(key, key);
            Object compacted = compactValue(key, value, messageType);
            output.put(shortKey, compacted);
        }
        return output;
    }

    private static Object compactValue(String longKey, Object value, String messageType)
            throws JSONException {
        if (value == JSONObject.NULL || value == null) {
            return JSONObject.NULL;
        }
        if (value instanceof JSONObject) {
            return compactObject((JSONObject) value, false);
        }
        if (value instanceof JSONArray) {
            return compactArray((JSONArray) value);
        }
        if (value instanceof Boolean || value instanceof Number) {
            return value;
        }
        String str = String.valueOf(value);
        if ("status".equals(longKey) && "photo_status".equals(messageType)) {
            Integer code = PHOTO_STATUS_TO_INT.get(str);
            if (code != null) {
                return code;
            }
        }
        if ("kind".equals(longKey)) {
            Integer code = KIND_TO_INT.get(str);
            if (code != null) {
                return code;
            }
        }
        if ("source".equals(longKey)) {
            Integer code = SOURCE_TO_INT.get(str);
            if (code != null) {
                return code;
            }
        }
        if ("aeStateName".equals(longKey)) {
            Integer code = AE_STATE_TO_INT.get(str);
            if (code != null) {
                return code;
            }
        }
        return str;
    }

    private static JSONArray compactArray(JSONArray array) throws JSONException {
        JSONArray out = new JSONArray();
        for (int i = 0; i < array.length(); i++) {
            Object value = array.get(i);
            if (value instanceof JSONObject) {
                out.put(compactObject((JSONObject) value, false));
            } else {
                out.put(value);
            }
        }
        return out;
    }

    private static JSONObject expandObject(JSONObject input, boolean topLevel) throws JSONException {
        JSONObject output = new JSONObject();
        String messageType = input.optString("type", input.optString("t", ""));

        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = input.get(key);
            if (topLevel && "ts".equals(key)) {
                output.put("ts", value);
                continue;
            }
            String longKey = SHORT_TO_LONG.getOrDefault(key, key);
            Object expanded = expandValue(longKey, value, messageType);
            output.put(longKey, expanded);
        }

        if (topLevel) {
            expandTimestamp(output);
            expandResolvedConfigHash(output);
            cacheResolvedConfigIfPresent(output);
        }
        return output;
    }

    private static void cacheResolvedConfigIfPresent(JSONObject output) throws JSONException {
        if (!(output.opt("resolvedConfig") instanceof JSONObject)) {
            return;
        }
        JSONObject resolvedConfig = output.getJSONObject("resolvedConfig");
        String hash = hashConfig(resolvedConfig);
        resolvedConfigByHash.put(hash, cloneObject(resolvedConfig));
    }

    private static void expandResolvedConfigHash(JSONObject output) throws JSONException {
        if (output.has("resolvedConfig") || !output.has(KEY_RESOLVED_CONFIG_HASH)) {
            return;
        }
        String hash = output.optString(KEY_RESOLVED_CONFIG_HASH, "");
        JSONObject cached = resolvedConfigByHash.get(hash);
        if (cached != null) {
            output.put("resolvedConfig", cloneObject(cached));
            output.remove(KEY_RESOLVED_CONFIG_HASH);
        }
    }

    private static Object expandValue(String longKey, Object value, String messageType)
            throws JSONException {
        if (value == JSONObject.NULL || value == null) {
            return JSONObject.NULL;
        }
        if (value instanceof JSONObject) {
            return expandObject((JSONObject) value, false);
        }
        if (value instanceof JSONArray) {
            JSONArray out = new JSONArray();
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) {
                Object item = array.get(i);
                if (item instanceof JSONObject) {
                    out.put(expandObject((JSONObject) item, false));
                } else {
                    out.put(item);
                }
            }
            return out;
        }
        if ("status".equals(longKey) && value instanceof Number && "photo_status".equals(messageType)) {
            String restored = PHOTO_STATUS_FROM_INT.get(((Number) value).intValue());
            return restored != null ? restored : value;
        }
        if ("kind".equals(longKey) && value instanceof Number) {
            String restored = KIND_FROM_INT.get(((Number) value).intValue());
            return restored != null ? restored : value;
        }
        if ("source".equals(longKey) && value instanceof Number) {
            String restored = SOURCE_FROM_INT.get(((Number) value).intValue());
            return restored != null ? restored : value;
        }
        if ("aeStateName".equals(longKey) && value instanceof Number) {
            String restored = AE_STATE_FROM_INT.get(((Number) value).intValue());
            return restored != null ? restored : value;
        }
        return value;
    }

    private static void expandTimestamp(JSONObject output) throws JSONException {
        if (!output.has("timestamp") && output.has("ts")) {
            Object timestamp = output.opt("ts");
            if (!(timestamp instanceof Number)) {
                output.put("timestamp", timestamp);
                output.remove("ts");
                return;
            }
            long delta = ((Number) timestamp).longValue();
            long absolute = sessionConnectEpochMs > 0 ? sessionConnectEpochMs + delta : delta;
            output.put("timestamp", absolute);
            output.remove("ts");
            if (sessionConnectEpochMs <= 0) {
                sessionConnectEpochMs = absolute - delta;
            }
        }
    }

    public static String hashConfig(JSONObject config) {
        try {
            return fnv1a32Hex(canonicalObject(config).toString());
        } catch (JSONException e) {
            return fnv1a32Hex(config.toString());
        }
    }

    private static JSONObject canonicalObject(JSONObject input) throws JSONException {
        List<String> keys = new ArrayList<>();
        Iterator<String> it = input.keys();
        while (it.hasNext()) {
            keys.add(it.next());
        }
        Collections.sort(keys);
        JSONObject out = new JSONObject();
        for (String key : keys) {
            Object value = input.get(key);
            if (value instanceof JSONObject) {
                out.put(key, canonicalObject((JSONObject) value));
            } else {
                out.put(key, value);
            }
        }
        return out;
    }

    private static JSONObject cloneObject(JSONObject input) throws JSONException {
        return new JSONObject(input.toString());
    }

    private static String fnv1a32Hex(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        int hash = 0x811c9dc5;
        for (byte b : bytes) {
            hash ^= (b & 0xff);
            hash *= 0x01000193;
        }
        return String.format("%08x", hash);
    }
}
