package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import com.mentra.asg_client.io.bluetooth.utils.BleJsonCompact;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Utility class for K900 BES2700 protocol formatting. Used for communication between AugmentOS Core
 * and ASG Client.
 */
public class BesWireFormat {

    // Protocol constants
    public static final byte[] CMD_START_CODE = new byte[] {0x23, 0x23}; // ##
    public static final byte[] CMD_END_CODE = new byte[] {0x24, 0x24}; // $$
    public static final byte CMD_TYPE_STRING = 0x30; // String/JSON type
    public static final byte CMD_TYPE_PHOTO = 0x31; // Photo file type
    public static final byte CMD_TYPE_VIDEO = 0x32; // Video file type
    public static final byte CMD_TYPE_MUSIC = 0x33; // Music file type
    public static final byte CMD_TYPE_AUDIO = 0x34; // Audio file type
    public static final byte CMD_TYPE_DATA = 0x35; // Generic data type
    public static final byte CMD_TYPE_BINARY_MSG = 0x40; // BLE Wire Protocol v2

    // BLE Wire Protocol v2 — binary fragment flags (little-endian wire)
    public static final byte FLAG_FIRST_FRAG = 0x01;
    public static final byte FLAG_LAST_FRAG = 0x02;
    public static final byte FLAG_WAKE = 0x04;
    public static final byte FLAG_HANDSHAKE = 0x08;
    public static final byte FLAG_ACK_REQUESTED = 0x10;

    public static final int BINARY_HEADER_SIZE = 7;
    public static final int LENGTH_CMD_MIN_SIZE = 7; // ## + type + innerLen(2) + $$
    public static final int PROTOCOL_VERSION_V1 = 1;
    public static final int PROTOCOL_VERSION_V2 = 2;
    public static final String HANDSHAKE_PAYLOAD_V2 = "v2";

    private static final AtomicInteger ACTIVE_PROTOCOL_VERSION =
            new AtomicInteger(PROTOCOL_VERSION_V1);
    private static final AtomicInteger NEXT_BINARY_MSG_ID = new AtomicInteger(1);

    // File transfer constants. Legacy peers use 400-byte payloads. Firmware that advertises
    // wire_caps.file_payload_v2 can use all 474 data bytes available at ATT MTU 509, or a larger
    // payload selected from the actual CoC transmit MTU.
    public static final int FILE_PACK_SIZE_LEGACY = 400;
    public static final int FILE_PACK_SIZE_GATT_MAX = 474;
    public static final int FILE_PACK_SIZE_COC_MAX = 800;
    public static final int FILE_PACK_SIZE_MAX = FILE_PACK_SIZE_COC_MAX;
    public static final int FILE_PACK_SIZE_DEFAULT = FILE_PACK_SIZE_LEGACY;
    public static final int FILE_PACK_SIZE_MIN = 100; // Minimum safe packet size
    // File frame flags bit 0: sender streams push-mode and accepts batched acks
    // (BES >= 17.26.7.6 then acks every 8th pack instead of each one).
    public static final int FILE_FLAG_PUSH_BATCH_ACK = 0x0001;
    // Bit 1 declares that fileSize and packet indices use this transfer's packSize instead of the
    // OEM's hardcoded 400-byte packet-count convention.
    public static final int FILE_FLAG_DYNAMIC_PAYLOAD = 0x0002;
    private static int filePackSize = FILE_PACK_SIZE_DEFAULT; // Configurable packet size

    /**
     * Convert a BES file-transfer response index to the sender's zero-based packet index.
     * Success responses are cumulative and carry the next expected index. Failure responses
     * already carry the exact packet index BES needs retransmitted.
     */
    public static int fileAckPacketIndex(int state, int responseIndex) {
        return state == 1 ? responseIndex - 1 : responseIndex;
    }
    public static final int LENGTH_FILE_START = 2;

    /**
     * Get the current file pack size (data portion only, not including protocol overhead). Protocol
     * overhead is 32 bytes: ## (2) + type (1) + packSize (2) + packIndex (2) + fileSize (4) +
     * fileName (16) + flags (2) + verify (1) + $$ (2)
     */
    public static int getFilePackSize() {
        return filePackSize;
    }

    /**
     * Set the file pack size based on BLE MTU. The pack size is MTU - 3 (ATT header) - 32 (protocol
     * overhead).
     *
     * @param mtu The negotiated BLE MTU from the phone
     */
    public static void setFilePackSizeFromMtu(int mtu, boolean dynamicPayloadSupported) {
        // MTU - 3 (ATT header) - 32 (protocol overhead) = max data size
        int newPackSize = mtu - 3 - 32;

        // Clamp to valid range
        if (newPackSize < FILE_PACK_SIZE_MIN) {
            newPackSize = FILE_PACK_SIZE_MIN;
        }
        int maximum =
                dynamicPayloadSupported ? FILE_PACK_SIZE_GATT_MAX : FILE_PACK_SIZE_LEGACY;
        if (newPackSize > maximum) {
            newPackSize = maximum;
        }

        filePackSize = newPackSize;
        Log.i(
                "BesWireFormat",
                "📦 File pack size set to "
                        + filePackSize
                        + " bytes (MTU="
                        + mtu
                        + ", dynamic="
                        + dynamicPayloadSupported
                        + ")");
    }

    /** Select an explicitly negotiated payload, clamped to the protocol ceiling. */
    public static void setFilePackSize(int payloadSize) {
        filePackSize =
                Math.max(
                        FILE_PACK_SIZE_MIN,
                        Math.min(payloadSize, FILE_PACK_SIZE_COC_MAX));
        Log.i("BesWireFormat", "📦 File pack size set to " + filePackSize + " bytes");
    }

    /** Reset file pack size to default safe BLE payload size. */
    public static void resetFilePackSize() {
        filePackSize = FILE_PACK_SIZE_DEFAULT;
        Log.i("BesWireFormat", "📦 File pack size reset to default: " + filePackSize + " bytes");
    }

    public static final int LENGTH_FILE_TYPE = 1;
    public static final int LENGTH_FILE_PACKSIZE = 2;
    public static final int LENGTH_FILE_PACKINDEX = 2;
    public static final int LENGTH_FILE_SIZE = 4;
    public static final int LENGTH_FILE_NAME = 16;
    public static final int LENGTH_FILE_FLAG = 2;
    public static final int LENGTH_FILE_VERIFY = 1;
    public static final int LENGTH_FILE_END = 2;

    // JSON Field constants
    public static final String FIELD_C = "C"; // Command/Content field
    public static final String FIELD_V = "V"; // Version field
    public static final String FIELD_B = "B"; // Body field

    public static boolean isBinaryProtocolActive() {
        return ACTIVE_PROTOCOL_VERSION.get() >= PROTOCOL_VERSION_V2;
    }

    public static void setBinaryProtocolActive(boolean active) {
        ACTIVE_PROTOCOL_VERSION.set(active ? PROTOCOL_VERSION_V2 : PROTOCOL_VERSION_V1);
        if (active) {
            BleJsonCompact.markSessionConnected(System.currentTimeMillis());
        } else {
            BleJsonCompact.resetSession();
        }
        Log.i(
                "BesWireFormat",
                "BLE wire protocol set to v" + ACTIVE_PROTOCOL_VERSION.get());
    }

    public static int getActiveProtocolVersion() {
        return ACTIVE_PROTOCOL_VERSION.get();
    }

    public static void resetBinaryProtocol() {
        ACTIVE_PROTOCOL_VERSION.set(PROTOCOL_VERSION_V1);
        BleJsonCompact.resetSession();
    }

    public static int allocateBinaryMsgId() {
        return NEXT_BINARY_MSG_ID.getAndIncrement() & 0xFFFF;
    }

    /** Parsed header for {@link #CMD_TYPE_BINARY_MSG} frames. */
    public static final class BinaryHeader {
        public final byte flags;
        public final int msgId;
        public final int fragIdx;
        public final int fragCount;
        public final int payloadLen;
        public final byte[] payload;
        public final boolean valid;

        BinaryHeader(
                byte flags,
                int msgId,
                int fragIdx,
                int fragCount,
                int payloadLen,
                byte[] payload,
                boolean valid) {
            this.flags = flags;
            this.msgId = msgId;
            this.fragIdx = fragIdx;
            this.fragCount = fragCount;
            this.payloadLen = payloadLen;
            this.payload = payload;
            this.valid = valid;
        }
    }

    public static boolean isBinaryWireFrame(byte[] data) {
        return data != null
                && data.length >= LENGTH_CMD_MIN_SIZE + BINARY_HEADER_SIZE
                && isK900ProtocolFormat(data)
                && data[2] == CMD_TYPE_BINARY_MSG;
    }

    /**
     * Validate a frame strongly enough to use it as evidence that both UART endpoints agree on
     * baud. Marker-shaped garbage is insufficient: STRING frames must have an exact encoded length
     * and a JSON command field, while binary frames must have an exact fragment length and sane
     * fragment indices.
     */
    public static boolean isValidLinkHealthFrame(byte[] frame) {
        if (isBinaryWireFrame(frame)) {
            BinaryHeader header = parseBinaryHeader(frame);
            return header.valid
                    && header.fragCount > 0
                    && header.fragIdx < header.fragCount
                    && frame.length == LENGTH_CMD_MIN_SIZE + BINARY_HEADER_SIZE + header.payloadLen;
        }
        if (!isK900ProtocolFormat(frame) || frame[2] != CMD_TYPE_STRING) {
            return false;
        }
        K900LengthCodec.Detected detected = K900LengthCodec.detectLength(frame);
        if (detected == null || frame.length != detected.length + K900LengthCodec.FRAME_OVERHEAD) {
            return false;
        }
        try {
            byte[] payload = new byte[detected.length];
            System.arraycopy(
                    frame,
                    K900LengthCodec.PAYLOAD_OFFSET,
                    payload,
                    0,
                    detected.length);
            return new JSONObject(new String(payload, StandardCharsets.UTF_8)).has(FIELD_C);
        } catch (JSONException e) {
            return false;
        }
    }

    public static boolean isCameraCommand(String jsonData) {
        if (jsonData == null || jsonData.isEmpty()) {
            return false;
        }
        return jsonData.contains("cs_pho")
                || jsonData.contains("cs_cpho")
                || jsonData.contains("cs_vid")
                || jsonData.contains("\"type\":\"take_photo\"");
    }

    public static byte[] packBinaryFragment(
            byte flags, int msgId, int fragIdx, int fragCount, byte[] payload) {
        int payloadLen = payload != null ? payload.length : 0;
        int innerLen = BINARY_HEADER_SIZE + payloadLen;
        int total = LENGTH_CMD_MIN_SIZE + innerLen;
        byte[] frame = new byte[total];

        frame[0] = CMD_START_CODE[0];
        frame[1] = CMD_START_CODE[1];
        frame[2] = CMD_TYPE_BINARY_MSG;
        writeLe16(frame, 3, innerLen);

        int headerOffset = 5;
        frame[headerOffset] = flags;
        writeLe16(frame, headerOffset + 1, msgId);
        frame[headerOffset + 3] = (byte) fragIdx;
        frame[headerOffset + 4] = (byte) fragCount;
        writeLe16(frame, headerOffset + 5, payloadLen);

        if (payloadLen > 0 && payload != null) {
            System.arraycopy(payload, 0, frame, headerOffset + BINARY_HEADER_SIZE, payloadLen);
        }

        frame[total - 2] = CMD_END_CODE[0];
        frame[total - 1] = CMD_END_CODE[1];
        return frame;
    }

    public static byte[] packV2HandshakeFrame() {
        byte[] payload = HANDSHAKE_PAYLOAD_V2.getBytes(StandardCharsets.UTF_8);
        byte flags = (byte) (FLAG_FIRST_FRAG | FLAG_LAST_FRAG | FLAG_HANDSHAKE);
        return packBinaryFragment(flags, allocateBinaryMsgId(), 0, 1, payload);
    }

    public static boolean isV2HandshakePayload(byte[] payload) {
        if (payload == null) {
            return false;
        }
        return HANDSHAKE_PAYLOAD_V2.equals(new String(payload, StandardCharsets.UTF_8));
    }

    public static BinaryHeader parseBinaryHeader(byte[] frame) {
        if (!isBinaryWireFrame(frame)) {
            return new BinaryHeader((byte) 0, 0, 0, 0, 0, null, false);
        }

        int innerLen = readLe16(frame, 3);
        if (innerLen < BINARY_HEADER_SIZE) {
            return new BinaryHeader((byte) 0, 0, 0, 0, 0, null, false);
        }
        if (LENGTH_CMD_MIN_SIZE + innerLen > frame.length) {
            return new BinaryHeader((byte) 0, 0, 0, 0, 0, null, false);
        }

        int headerOffset = 5;
        byte flags = frame[headerOffset];
        int msgId = readLe16(frame, headerOffset + 1);
        int fragIdx = frame[headerOffset + 3] & 0xFF;
        int fragCount = frame[headerOffset + 4] & 0xFF;
        int payloadLen = readLe16(frame, headerOffset + 5);

        if (BINARY_HEADER_SIZE + payloadLen > innerLen) {
            return new BinaryHeader((byte) 0, 0, 0, 0, 0, null, false);
        }

        if (frame[headerOffset + innerLen] != CMD_END_CODE[0]
                || frame[headerOffset + innerLen + 1] != CMD_END_CODE[1]) {
            return new BinaryHeader((byte) 0, 0, 0, 0, 0, null, false);
        }

        byte[] payload = new byte[payloadLen];
        if (payloadLen > 0) {
            System.arraycopy(
                    frame, headerOffset + BINARY_HEADER_SIZE, payload, 0, payloadLen);
        }

        return new BinaryHeader(
                flags, msgId, fragIdx, fragCount, payloadLen, payload, true);
    }

    public static byte[] extractBinaryPayload(byte[] frame) {
        BinaryHeader header = parseBinaryHeader(frame);
        return header.valid ? header.payload : null;
    }

    /**
     * Pack a JSON string into the proper K900 format: 1. Wrap with C-field: {"C": jsonData} 2. Then
     * pack with BES2700 protocol: ## + type + length + {"C": jsonData} + $$
     *
     * @param jsonData The JSON string to pack
     * @return Byte array with packed data according to protocol format
     */
    public static byte[] packJsonCommand(String jsonData) {
        return packJsonCommand(jsonData, K900LengthCodec.Endian.LE);
    }

    public static byte[] packJsonCommand(String jsonData, K900LengthCodec.Endian endian) {
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
            return packDataCommand(jsonBytes, CMD_TYPE_STRING, endian);

        } catch (JSONException e) {
            Log.e("BesWireFormat", "Error creating JSON wrapper", e);
            return null;
        }
    }

    /**
     * Pack raw byte data with K900 BES2700 protocol format Format: ## + command_type +
     * length(2bytes) + data + $$
     *
     * @param data The raw data to pack
     * @param cmdType The command type (use CMD_TYPE_STRING for JSON)
     * @return Byte array with packed data according to protocol format
     */
    public static byte[] packDataCommand(byte[] data, byte cmdType) {
        // Historic default is little-endian (the wire-v2 convention). Callers that
        // know the negotiated link endianness should use the overload below.
        return packDataCommand(data, cmdType, K900LengthCodec.Endian.LE);
    }

    /**
     * Pack raw byte data with K900 BES2700 protocol format, writing the 2-byte length field with an
     * explicit endianness. Use the negotiated per-link endianness so both legacy big-endian and
     * wire-v2 little-endian peers can parse the frame.
     */
    public static byte[] packDataCommand(byte[] data, byte cmdType, K900LengthCodec.Endian endian) {
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

        // Length (2 bytes, negotiated endianness)
        K900LengthCodec.writeLength(result, 3, dataLength, endian);

        // Copy the data
        System.arraycopy(data, 0, result, 5, dataLength);

        // End code $$
        result[5 + dataLength] = CMD_END_CODE[0]; // $
        result[6 + dataLength] = CMD_END_CODE[1]; // $

        return result;
    }

    /**
     * Formats a standard ASG-client JSON message for transmission to MentraLiveSGC This does both:
     * 1. Wrap with C-field: {"C": jsonData} 2. Format with BES2700 protocol: ## + type + length +
     * data + $$
     *
     * @param jsonData The JSON string to format (must be valid JSON)
     * @return Formatted bytes ready for transmission
     */
    public static byte[] formatMessageForTransmission(String jsonData) {
        return formatMessageForTransmission(jsonData, K900LengthCodec.Endian.BE);
    }

    /**
     * Format an ASG-client JSON message for transmission, writing STRING frame lengths with the
     * negotiated per-link endianness. Binary v2 frames are always little-endian and ignore the
     * {@code endian} argument.
     */
    public static byte[] formatMessageForTransmission(String jsonData, K900LengthCodec.Endian endian) {
        try {
            Log.d("BesWireFormat", "🔄 Formatting message: " + jsonData);

            if (isBinaryProtocolActive()) {
                return formatBinaryMessageForTransmission(jsonData);
            }

            String wrappedJson = createTransmissionWrapperJson(jsonData);
            Log.d("BesWireFormat", "🔄 After C-wrapping: " + wrappedJson);

            // Now format with BES2700 protocol
            byte[] result =
                    packDataCommand(
                            wrappedJson.getBytes(StandardCharsets.UTF_8), CMD_TYPE_STRING, endian);

            // Log some bytes for debugging
            StringBuilder hexDump = new StringBuilder();
            for (int i = 0; i < Math.min(result.length, 30); i++) {
                hexDump.append(String.format("%02X ", result[i]));
            }
            // Log.e("BesWireFormat", "🔄 After protocol formatting (first 30 bytes): " + hexDump);
            // Log.e("BesWireFormat", "🔄 Final length: " + result.length + " bytes");

            return result;

        } catch (JSONException e) {
            Log.e("BesWireFormat", "❌ Error in formatMessageForTransmission", e);
            // Fallback: if json is invalid, still try to pack it without validation
            return packJsonCommand(jsonData, endian);
        }
    }

    /**
     * Create the JSON envelope used by formatMessageForTransmission before BES2700 packing.
     *
     * @param jsonData The JSON string to wrap (must be valid JSON)
     * @return Full K900 transmission wrapper: {"C": jsonData, "V": 1, "B": {}}
     */
    public static String createTransmissionWrapperJson(String jsonData) throws JSONException {
        // Validate that input is proper JSON before embedding it as the C payload.
        JSONObject message = new JSONObject(jsonData);
        String wirePayload =
                isBinaryProtocolActive()
                        ? BleJsonCompact.encode(message).toString()
                        : jsonData;

        if (isBinaryProtocolActive() && !isCameraCommand(jsonData)) {
            return wirePayload;
        }

        JSONObject wrapper = new JSONObject();
        wrapper.put(FIELD_C, wirePayload);
        if (!isBinaryProtocolActive()) {
            wrapper.put(FIELD_V, 1);
            wrapper.put(FIELD_B, new JSONObject());
        }
        return wrapper.toString();
    }

    /** Build outbound payload bytes for v2 binary transport (Phase 3: no C/V/B except camera). */
    public static byte[] buildOutboundPayloadBytes(String jsonData) throws JSONException {
        String wireJson = createTransmissionWrapperJson(jsonData);
        return wireJson.getBytes(StandardCharsets.UTF_8);
    }

    public static byte[] formatBinaryMessageForTransmission(String jsonData) throws JSONException {
        byte[] payload = buildOutboundPayloadBytes(jsonData);
        byte flags = (byte) (FLAG_FIRST_FRAG | FLAG_LAST_FRAG);
        return packBinaryFragment(flags, allocateBinaryMsgId(), 0, 1, payload);
    }

    private static void writeLe16(byte[] buffer, int offset, int value) {
        buffer[offset] = (byte) (value & 0xFF);
        buffer[offset + 1] = (byte) ((value >> 8) & 0xFF);
    }

    private static int readLe16(byte[] buffer, int offset) {
        return (buffer[offset] & 0xFF) | ((buffer[offset + 1] & 0xFF) << 8);
    }

    private static JSONObject expandCompactWireJson(JSONObject json) throws JSONException {
        if (!isBinaryProtocolActive()) {
            return json;
        }
        return BleJsonCompact.decodeIfSupported(json);
    }

    /**
     * Create a C-wrapped JSON object ready for protocol formatting Format: {"C": content}
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
            Log.e("BesWireFormat", "Error creating C-wrapped JSON", e);
            return null;
        }
    }

    /**
     * Check if data follows the K900 BES2700 protocol format Verifies if data starts with ##
     * markers
     */
    public static boolean isK900ProtocolFormat(byte[] data) {
        if (data == null || data.length < 7) { // Minimum protocol size
            return false;
        }

        return data[0] == CMD_START_CODE[0] && data[1] == CMD_START_CODE[1];
    }

    /**
     * Check if a JSON string is already properly formatted for K900 protocol This can either be: 1.
     * Simple C-wrapped format: {"C": "content"} 2. Full K900 format: {"C": "command", "V": value,
     * "B": body}
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
     *
     * @return Raw payload data or null if format is invalid
     */
    public static byte[] extractPayload(byte[] protocolData) {
        return extractPayload(protocolData, K900LengthCodec.Endian.LE);
    }

    /**
     * Extract payload from a K900 STRING frame, reading the length field with an explicit
     * endianness. Prefer {@link #extractPayloadAuto} on receive when the peer endianness is not yet
     * negotiated.
     */
    public static byte[] extractPayload(byte[] protocolData, K900LengthCodec.Endian endian) {
        if (!isK900ProtocolFormat(protocolData) || protocolData.length < 7) {
            return null;
        }

        int length = K900LengthCodec.readLength(protocolData, 3, endian);

        if (length + 7 > protocolData.length) {
            return null; // Invalid length
        }

        byte[] payload = new byte[length];
        System.arraycopy(protocolData, 5, payload, 0, length);
        return payload;
    }

    /**
     * Extract payload from a K900 STRING frame, heuristically detecting the length field's
     * endianness. This is the safe RX entry point when talking to a peer of unknown vintage (fixes
     * the {@code Extracted length=9472} misframe against legacy big-endian BES firmware).
     */
    public static byte[] extractPayloadAuto(byte[] protocolData) {
        if (!isK900ProtocolFormat(protocolData) || protocolData.length < 7) {
            return null;
        }
        K900LengthCodec.Detected detected = K900LengthCodec.detectLength(protocolData);
        if (detected == null) {
            return null;
        }
        byte[] payload = new byte[detected.length];
        System.arraycopy(protocolData, 5, payload, 0, detected.length);
        return payload;
    }

    /**
     * Extract payload from K900 protocol formatted data received from device Uses little-endian
     * byte order for length field
     *
     * @return Raw payload data or null if format is invalid
     */
    public static byte[] extractPayloadFromK900(byte[] protocolData) {
        // Retained for backward compatibility: device-to-phone frames may arrive in either
        // endianness depending on firmware vintage, so auto-detect rather than assuming LE.
        return extractPayloadAuto(protocolData);
    }

    /**
     * Process received bytes from Bluetooth into a JSON object Handles K900 protocol format
     * detection, payload extraction, and C-field unwrapping
     *
     * @param data The raw bytes received from Bluetooth
     * @return Parsed JSON object or null if not valid protocol data or valid JSON
     */
    public static JSONObject processReceivedBytesToJson(byte[] data) {
        Log.d("BesWireFormat", "Processing received bytes for JSON extraction");

        // Check for null or too small data
        if (data == null || data.length < 7) {
            Log.d("BesWireFormat", "Received data is null or too short to be valid protocol data");
            return null;
        }

        // Verify if this is K900 protocol format (starts with ##)
        if (!isK900ProtocolFormat(data)) {
            Log.d("BesWireFormat", "Not in K900 protocol format (missing ## markers)");
            return null;
        }

        // Extract the command type
        byte commandType = data[2];

        if (commandType == CMD_TYPE_BINARY_MSG) {
            Log.d("BesWireFormat", "Binary wire frame — use parseBinaryHeader()");
            return null;
        }

        // Extract the length, auto-detecting endianness so we parse both legacy big-endian
        // and wire-v2 little-endian frames.
        K900LengthCodec.Detected detected = K900LengthCodec.detectLength(data);
        int payloadLength =
                detected != null
                        ? detected.length
                        : ((data[3] & 0xFF) | ((data[4] & 0xFF) << 8));

        Log.d(
                "BesWireFormat",
                "Command type: 0x"
                        + String.format("%02X", commandType)
                        + ", Payload length: "
                        + payloadLength);

        // Verify we have enough data and the right command type
        if (commandType != CMD_TYPE_STRING) {
            Log.d(
                    "BesWireFormat",
                    "Not a JSON/string command type (0x30), got: 0x"
                            + String.format("%02X", commandType));
            return null;
        }

        if (data.length < payloadLength + 7) {
            Log.d(
                    "BesWireFormat",
                    "Received data size ("
                            + data.length
                            + ") is less than expected size ("
                            + (payloadLength + 7)
                            + ")");
            return null;
        }

        // Check for end markers ($$)
        if (data[5 + payloadLength] != CMD_END_CODE[0]
                || data[6 + payloadLength] != CMD_END_CODE[1]) {
            Log.d("BesWireFormat", "End markers ($$) not found where expected");
            return null;
        }

        // Extract the payload
        byte[] payload = new byte[payloadLength];
        System.arraycopy(data, 5, payload, 0, payloadLength);

        // Convert to string
        String payloadStr;
        try {
            payloadStr = new String(payload, StandardCharsets.UTF_8);
            Log.d("BesWireFormat", "Extracted payload: " + payloadStr);
        } catch (Exception e) {
            Log.e("BesWireFormat", "Error converting payload to string", e);
            return null;
        }

        // Check if it's valid JSON
        if (!payloadStr.startsWith("{") || !payloadStr.endsWith("}")) {
            Log.d("BesWireFormat", "Payload is not valid JSON: " + payloadStr);
            return null;
        }

        try {
            // Parse the JSON payload
            JSONObject json = new JSONObject(payloadStr);

            // Check if this is C-wrapped format {"C": "..."}
            if (json.has(FIELD_C)) {
                String innerContent = json.optString(FIELD_C, "");
                Log.d("BesWireFormat", "Detected C-wrapped format, inner content: " + innerContent);

                // Try to parse the inner content as JSON
                try {
                    JSONObject innerJson = new JSONObject(innerContent);
                    return expandCompactWireJson(innerJson);
                } catch (JSONException e) {
                    Log.d(
                            "BesWireFormat",
                            "Inner content is not JSON, returning outer JSON object");
                    // If inner content is not JSON, return the outer JSON
                    return json;
                }
            } else {
                // Not C-wrapped, return the JSON directly
                return expandCompactWireJson(json);
            }
        } catch (JSONException e) {
            Log.e("BesWireFormat", "Error parsing JSON payload: " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * Unified method to prepare data for transmission according to K900 protocol This handles all
     * formatting cases: 1. Data already in protocol format 2. JSON data that needs C-wrapping 3.
     * Raw data that needs protocol packaging
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
                Log.d("BesWireFormat", "📦 JSON DATA BEFORE C-WRAPPING: " + originalData);
                byte[] formattedData = formatMessageForTransmission(originalData);

                // Debug log the formatting results if needed
                if (Log.isLoggable("BesWireFormat", Log.DEBUG)) {
                    StringBuilder hexDump = new StringBuilder();
                    for (int i = 0; i < Math.min(formattedData.length, 50); i++) {
                        hexDump.append(String.format("%02X ", formattedData[i]));
                    }
                    Log.d(
                            "BesWireFormat",
                            "📦 AFTER C-WRAPPING & PROTOCOL FORMATTING (first 50 bytes): "
                                    + hexDump.toString());
                    Log.d(
                            "BesWireFormat",
                            "📦 Total formatted length: " + formattedData.length + " bytes");
                }

                return formattedData;
            } else {
                // Otherwise just apply protocol formatting
                Log.d("BesWireFormat", "📦 Data already C-wrapped or not JSON: " + originalData);
                Log.d("BesWireFormat", "Formatting data with K900 protocol (adding ##...)");
                return packDataCommand(data, CMD_TYPE_STRING);
            }
        } catch (Exception e) {
            // If we can't interpret as string, just apply protocol formatting to raw bytes
            Log.d("BesWireFormat", "Applying protocol format to raw bytes");
            return packDataCommand(data, CMD_TYPE_STRING);
        }
    }

    /**
     * Check if the device is a K900
     *
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
                BroadcastReceiver testReceiver =
                        new BroadcastReceiver() {
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
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.registerReceiver(
                            testReceiver,
                            new IntentFilter("com.xy.xsetting.response"),
                            Context.RECEIVER_NOT_EXPORTED);
                } else {
                    context.registerReceiver(
                            testReceiver,
                            new IntentFilter("com.xy.xsetting.response"),
                            Context.RECEIVER_NOT_EXPORTED);
                }

                // Send a test probe
                Intent testIntent = new Intent("com.xy.xsetting.action");
                testIntent.setPackage("com.android.systemui");
                testIntent.putExtra("cmd", "test_k900");
                context.sendBroadcast(testIntent);

                // In a real implementation, we would wait for a response
                // For now, we check device properties as a fallback
                String model =
                        (android.os.Build.MODEL != null ? android.os.Build.MODEL : "")
                                .toLowerCase();
                String product =
                        (android.os.Build.PRODUCT != null ? android.os.Build.PRODUCT : "")
                                .toLowerCase();
                String device =
                        (android.os.Build.DEVICE != null ? android.os.Build.DEVICE : "")
                                .toLowerCase();
                String display =
                        (android.os.Build.DISPLAY != null ? android.os.Build.DISPLAY : "")
                                .toLowerCase();
                String fingerprint =
                        (android.os.Build.FINGERPRINT != null ? android.os.Build.FINGERPRINT : "")
                                .toLowerCase();
                String manufacturer =
                        (android.os.Build.MANUFACTURER != null ? android.os.Build.MANUFACTURER : "")
                                .toLowerCase();

                // Check for K900 variants, XY glasses identifiers, and MentraLive rebrands
                return model.contains("k900")
                        || product.contains("k900")
                        || device.contains("k900")
                        || display.contains("k900")
                        || fingerprint.contains("k900")
                        || model.contains("xyglasses")
                        || manufacturer.contains("xyglasses")
                        || manufacturer.contains("xyaiglasses")
                        || product.contains("mentralive")
                        || device.contains("mentralive")
                        || display.contains("mentralive")
                        || fingerprint.contains("mentralive");
            } catch (Exception e) {
                Log.e("BesWireFormat", "Error checking for K900 specific broadcast", e);
            }
        } catch (Exception e) {
            Log.d("BesWireFormat", "Not a K900 device: " + e.getMessage());
        }

        return false;
    }

    /** Inner class to represent file packet information */
    public static class FilePacketInfo {
        public byte fileType;
        public int packSize;
        public int packIndex;
        public int fileSize;
        public String fileName;
        public int flags;
        public byte[] data;
        public byte verifyCode;
        public boolean isValid;

        public FilePacketInfo() {
            this.isValid = false;
        }
    }

    /**
     * Pack a file packet according to K900 file transfer protocol Format: ## + fileType + packSize
     * + packIndex + fileSize + fileName + flags + data + verify + $$
     *
     * @param fileData The file data chunk to send (max 400 bytes)
     * @param packIndex The index of this packet (0-based)
     * @param packSize The size of data in this packet
     * @param fileSize The total file size
     * @param fileName The file name (max 16 chars)
     * @param flags Optional flags
     * @param fileType The file type (CMD_TYPE_PHOTO, etc)
     * @return Packed byte array ready for transmission
     */
    public static byte[] packFilePacket(
            byte[] fileData,
            int packIndex,
            int packSize,
            int fileSize,
            String fileName,
            int flags,
            byte fileType) {
        if (fileData == null || packSize > FILE_PACK_SIZE_MAX) {
            return null;
        }

        // Calculate total packet size
        int totalSize =
                LENGTH_FILE_START
                        + LENGTH_FILE_TYPE
                        + LENGTH_FILE_PACKSIZE
                        + LENGTH_FILE_PACKINDEX
                        + LENGTH_FILE_SIZE
                        + LENGTH_FILE_NAME
                        + LENGTH_FILE_FLAG
                        + packSize
                        + LENGTH_FILE_VERIFY
                        + LENGTH_FILE_END;

        byte[] packet = new byte[totalSize];
        int pos = 0;

        // Start code ##
        System.arraycopy(CMD_START_CODE, 0, packet, pos, LENGTH_FILE_START);
        pos += LENGTH_FILE_START;

        // File type
        packet[pos] = fileType;
        pos += LENGTH_FILE_TYPE;

        // Pack size (2 bytes, big-endian like reference implementation)
        packet[pos] = (byte) ((packSize >> 8) & 0xFF);
        packet[pos + 1] = (byte) (packSize & 0xFF);
        pos += LENGTH_FILE_PACKSIZE;

        // Pack index (2 bytes, big-endian)
        packet[pos] = (byte) ((packIndex >> 8) & 0xFF);
        packet[pos + 1] = (byte) (packIndex & 0xFF);
        pos += LENGTH_FILE_PACKINDEX;

        // File size (4 bytes, big-endian)
        packet[pos] = (byte) ((fileSize >> 24) & 0xFF);
        packet[pos + 1] = (byte) ((fileSize >> 16) & 0xFF);
        packet[pos + 2] = (byte) ((fileSize >> 8) & 0xFF);
        packet[pos + 3] = (byte) (fileSize & 0xFF);
        pos += LENGTH_FILE_SIZE;

        // File name (16 bytes, padded with zeros)
        byte[] nameBytes = fileName.getBytes(StandardCharsets.UTF_8);
        int nameLen = Math.min(nameBytes.length, LENGTH_FILE_NAME);
        System.arraycopy(nameBytes, 0, packet, pos, nameLen);
        // Pad with zeros if name is shorter than 16 bytes
        for (int i = nameLen; i < LENGTH_FILE_NAME; i++) {
            packet[pos + i] = 0;
        }
        pos += LENGTH_FILE_NAME;

        // Flags (2 bytes, big-endian)
        packet[pos] = (byte) ((flags >> 8) & 0xFF);
        packet[pos + 1] = (byte) (flags & 0xFF);
        pos += LENGTH_FILE_FLAG;

        // Data
        System.arraycopy(fileData, 0, packet, pos, packSize);
        pos += packSize;

        // Calculate verify code (checksum of data bytes)
        int checkSum = 0;
        for (int i = 0; i < packSize; i++) {
            checkSum += (fileData[i] & 0xFF);
        }
        packet[pos] = (byte) (checkSum & 0xFF);
        pos += LENGTH_FILE_VERIFY;

        // End code $$
        System.arraycopy(CMD_END_CODE, 0, packet, pos, LENGTH_FILE_END);

        return packet;
    }

    /**
     * Extract file packet information from received protocol data
     *
     * @param protocolData The raw protocol data received
     * @return FilePacketInfo object with parsed data, or null if invalid
     */
    public static FilePacketInfo extractFilePacket(byte[] protocolData) {
        if (!isK900ProtocolFormat(protocolData) || protocolData.length < 31) {
            Log.e(
                    "BesWireFormat",
                    "extractFilePacket: Invalid format or too short. Length="
                            + (protocolData != null ? protocolData.length : 0)
                            + ", isK900Format="
                            + isK900ProtocolFormat(protocolData));
            return null;
        }

        FilePacketInfo info = new FilePacketInfo();
        int pos = LENGTH_FILE_START; // Skip start code

        // File type
        info.fileType = protocolData[pos];
        pos += LENGTH_FILE_TYPE;

        // Pack size (big-endian)
        info.packSize = ((protocolData[pos] & 0xFF) << 8) | (protocolData[pos + 1] & 0xFF);
        pos += LENGTH_FILE_PACKSIZE;

        // Pack index (big-endian)
        info.packIndex = ((protocolData[pos] & 0xFF) << 8) | (protocolData[pos + 1] & 0xFF);
        pos += LENGTH_FILE_PACKINDEX;

        // File size (big-endian)
        info.fileSize =
                ((protocolData[pos] & 0xFF) << 24)
                        | ((protocolData[pos + 1] & 0xFF) << 16)
                        | ((protocolData[pos + 2] & 0xFF) << 8)
                        | (protocolData[pos + 3] & 0xFF);
        pos += LENGTH_FILE_SIZE;

        // File name
        byte[] nameBytes = new byte[LENGTH_FILE_NAME];
        System.arraycopy(protocolData, pos, nameBytes, 0, LENGTH_FILE_NAME);
        // Find null terminator
        int nameLen = 0;
        for (int i = 0; i < LENGTH_FILE_NAME; i++) {
            if (nameBytes[i] == 0) break;
            nameLen++;
        }
        info.fileName = new String(nameBytes, 0, nameLen, StandardCharsets.UTF_8);
        pos += LENGTH_FILE_NAME;

        // Flags (big-endian)
        info.flags = ((protocolData[pos] & 0xFF) << 8) | (protocolData[pos + 1] & 0xFF);
        pos += LENGTH_FILE_FLAG;

        // Verify packet has enough data
        if (protocolData.length < pos + info.packSize + LENGTH_FILE_VERIFY + LENGTH_FILE_END) {
            Log.e(
                    "BesWireFormat",
                    "File packet too short for data. Need: "
                            + (pos + info.packSize + LENGTH_FILE_VERIFY + LENGTH_FILE_END)
                            + ", Have: "
                            + protocolData.length
                            + ", packSize="
                            + info.packSize
                            + ", pos="
                            + pos);
            return null;
        }

        // Data
        info.data = new byte[info.packSize];
        System.arraycopy(protocolData, pos, info.data, 0, info.packSize);
        pos += info.packSize;

        // Verify code
        info.verifyCode = protocolData[pos];
        pos += LENGTH_FILE_VERIFY;

        // Check end code
        if (protocolData[pos] != CMD_END_CODE[0] || protocolData[pos + 1] != CMD_END_CODE[1]) {
            return null;
        }

        // Calculate and verify checksum
        int checkSum = 0;
        for (int i = 0; i < info.packSize; i++) {
            checkSum += (info.data[i] & 0xFF);
        }
        byte calculatedVerify = (byte) (checkSum & 0xFF);

        info.isValid = (calculatedVerify == info.verifyCode);

        if (!info.isValid) {
            Log.e(
                    "BesWireFormat",
                    "File packet checksum failed. Expected: "
                            + String.format("%02X", info.verifyCode)
                            + ", Calculated: "
                            + String.format("%02X", calculatedVerify));
        } else {
            Log.d(
                    "BesWireFormat",
                    "File packet extracted successfully: index="
                            + info.packIndex
                            + ", size="
                            + info.packSize
                            + ", fileName="
                            + info.fileName);
        }

        return info;
    }

    /**
     * Create a file transfer acknowledgment message
     *
     * @param state 1 for success, 0 for failure
     * @param index The packet index being acknowledged
     * @return JSON string ready to be sent
     */
    public static String createFileTransferAck(int state, int index) {
        try {
            JSONObject body = new JSONObject();
            body.put("state", state);
            body.put("index", index);

            JSONObject message = new JSONObject();
            message.put("C", "cs_flts");
            message.put("B", body); // Send as JSON object, not string

            return message.toString();
        } catch (JSONException e) {
            Log.e("BesWireFormat", "Error creating file transfer ack", e);
            return null;
        }
    }
}
