package com.mentra.bluetoothsdk.utils;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.util.Log;
import android.os.Build;

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
    public static final byte CMD_TYPE_PHOTO = 0x31; // Photo file type
    public static final byte CMD_TYPE_VIDEO = 0x32; // Video file type
    public static final byte CMD_TYPE_MUSIC = 0x33; // Music file type
    public static final byte CMD_TYPE_AUDIO = 0x34; // Audio file type
    public static final byte CMD_TYPE_DATA = 0x35; // Generic data type
    public static final byte CMD_TYPE_BINARY_MSG = BleWireProtocol.CMD_TYPE_BINARY_MSG;

    // File transfer constants
    // Negotiated file protocol ceiling. Legacy/GATT transfers remain smaller; 800-byte frames are
    // accepted only after file_payload_v2 negotiation and an open CoC channel.
    public static final int FILE_PACK_SIZE = 800;
    public static final int LENGTH_FILE_START = 2;
    public static final int LENGTH_FILE_TYPE = 1;
    public static final int LENGTH_FILE_PACKSIZE = 2;
    public static final int LENGTH_FILE_PACKINDEX = 2;
    public static final int LENGTH_FILE_SIZE = 4;
    public static final int LENGTH_FILE_NAME = 16;
    public static final int LENGTH_FILE_FLAG = 2;
    public static final int LENGTH_FILE_VERIFY = 1;
    public static final int LENGTH_FILE_END = 2;

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
        return packJsonCommand(jsonData, K900LengthCodec.Endian.BE);
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
        // Default to legacy big-endian until wire_caps negotiates little-endian.
        return packDataCommand(data, cmdType, K900LengthCodec.Endian.BE);
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
     * Pack raw byte data with K900 BES2700 protocol format for phone-to-device communication
     * Format: ## + command_type + length(2bytes) + data + $$
     * Uses little-endian byte order for length field
     *
     * @param data The raw data to pack
     * @param cmdType The command type (use CMD_TYPE_STRING for JSON)
     * @return Byte array with packed data according to protocol format
     */
    public static byte[] packDataToK900(byte[] data, byte cmdType) {
        return packDataToK900(data, cmdType, K900LengthCodec.Endian.BE);
    }

    /**
     * Pack raw byte data with K900 BES2700 protocol format for phone-to-device communication.
     * Format: ## + command_type + length(2bytes) + data + $$
     */
    public static byte[] packDataToK900(byte[] data, byte cmdType, K900LengthCodec.Endian endian) {
        return packDataCommand(data, cmdType, endian);
    }

    /**
     * Pack a JSON string for phone-to-K900 device communication
     * 1. Wrap with C-field: {"C": jsonData}
     * 2. Then pack with BES2700 protocol using little-endian: ## + type + length + {"C": jsonData} + $$
     *
     * @param jsonData The JSON string to pack
     * @return Byte array with packed data according to protocol format
     */
    public static byte[] packJsonToK900(String jsonData, boolean wakeup) {
        return packJsonToK900(jsonData, wakeup, K900LengthCodec.Endian.BE);
    }

    /**
     * Pack a C-wrapped JSON string for phone-to-glasses transmission, writing the STRING frame
     * length with the negotiated per-link endianness. Legacy big-endian glasses require BE until
     * they advertise {@code wire_caps.k900_le}.
     */
    public static byte[] packJsonToK900(String jsonData, boolean wakeup, K900LengthCodec.Endian endian) {
        if (jsonData == null) {
            return null;
        }

        try {
            // First wrap with C-field
            JSONObject wrapper = new JSONObject();
            wrapper.put(FIELD_C, jsonData);
            if (wakeup) {
                wrapper.put("W", 1); // Add W field as seen in MentraLiveSGC
            }

            // Convert to string
            String wrappedJson = wrapper.toString();

            // Then pack with BES2700 protocol format using the negotiated endianness
            byte[] jsonBytes = wrappedJson.getBytes(StandardCharsets.UTF_8);
            return packDataCommand(jsonBytes, CMD_TYPE_STRING, endian);

        } catch (JSONException e) {
            android.util.Log.e("K900ProtocolUtils", "Error creating JSON wrapper for K900", e);
            return null;
        }
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
        return formatMessageForTransmission(jsonData, K900LengthCodec.Endian.BE);
    }

    /**
     * Format an ASG-client JSON message for transmission, writing the STRING frame length with the
     * negotiated per-link endianness.
     */
    public static byte[] formatMessageForTransmission(String jsonData, K900LengthCodec.Endian endian) {
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
            byte[] result =
                    packDataCommand(
                            wrappedJson.getBytes(StandardCharsets.UTF_8), CMD_TYPE_STRING, endian);

            // Log some bytes for debugging
            StringBuilder hexDump = new StringBuilder();
            for (int i = 0; i < Math.min(result.length, 30); i++) {
                hexDump.append(String.format("%02X ", result[i]));
            }
            //android.util.Log.e("K900ProtocolUtils", "🔄 After protocol formatting (first 30 bytes): " + hexDump);
            //android.util.Log.e("K900ProtocolUtils", "🔄 Final length: " + result.length + " bytes");

            return result;

        } catch (JSONException e) {
            android.util.Log.e("K900ProtocolUtils", "❌ Error in formatMessageForTransmission", e);
            // Fallback: if json is invalid, still try to pack it without validation
            return packJsonCommand(jsonData, endian);
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
        return extractPayload(protocolData, K900LengthCodec.Endian.BE);
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
     * endianness. Safe RX entry point when the peer endianness is not yet negotiated (fixes the
     * "Extracted length=9472" misframe against legacy big-endian BES firmware).
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
     * Extract payload from K900 protocol formatted data received from device
     * Uses little-endian byte order for length field
     * @return Raw payload data or null if format is invalid
     */
    public static byte[] extractPayloadFromK900(byte[] protocolData) {
        // Retained for backward compatibility: device-to-phone frames may arrive in either
        // endianness depending on firmware vintage, so auto-detect rather than assuming LE.
        return extractPayloadAuto(protocolData);
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

        // Extract the length, auto-detecting endianness so we parse both legacy big-endian and
        // wire-v2 little-endian frames.
        K900LengthCodec.Detected detected = K900LengthCodec.detectLength(data);
        int payloadLength =
                detected != null
                        ? detected.length
                        : ((data[3] & 0xFF) | ((data[4] & 0xFF) << 8));

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
            android.util.Log.d("K900ProtocolUtils", "Extracted JSON payload bytes: " + payloadLength);
        } catch (Exception e) {
            android.util.Log.e("K900ProtocolUtils", "Error converting payload to string", e);
            return null;
        }

        // Check if it's valid JSON
        if (!payloadStr.startsWith("{") || !payloadStr.endsWith("}")) {
            android.util.Log.d("K900ProtocolUtils", "Payload is not valid JSON");
            return null;
        }

        try {
            // Parse the JSON payload
            JSONObject json = new JSONObject(payloadStr);

            // Check if this is C-wrapped format {"C": "..."}
            if (json.has(FIELD_C)) {
                String innerContent = json.optString(FIELD_C, "");
                android.util.Log.d("K900ProtocolUtils", "Detected C-wrapped format");

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
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.registerReceiver(testReceiver,
                            new IntentFilter("com.xy.xsetting.response"),
                            Context.RECEIVER_NOT_EXPORTED);
                } else {
                    context.registerReceiver(testReceiver,
                            new IntentFilter("com.xy.xsetting.response"),
                            Context.RECEIVER_NOT_EXPORTED);
                }

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

    public static boolean isBinaryFrame(byte[] data) {
        return BleWireProtocol.isBinaryFrame(data);
    }

    public static byte[] packBinaryFragment(
            byte flags, int msgId, int fragIdx, int fragCount, byte[] payload) {
        return BleWireProtocol.packBinaryFragment(flags, msgId, fragIdx, fragCount, payload);
    }

    public static BleWireProtocol.BinaryFragmentInfo extractBinaryFragmentInfo(byte[] frame) {
        return BleWireProtocol.extractBinaryFragmentInfo(frame);
    }

    public static byte[] extractBinaryPayload(byte[] frame) {
        return BleWireProtocol.extractBinaryPayload(frame);
    }

    /**
     * Inner class to represent file packet information
     */
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
     * Pack a file packet according to K900 file transfer protocol
     * Format: ## + fileType + packSize + packIndex + fileSize + fileName + flags + data + verify + $$
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
    public static byte[] packFilePacket(byte[] fileData, int packIndex, int packSize,
                                       int fileSize, String fileName, int flags, byte fileType) {
        if (fileData == null || packSize > FILE_PACK_SIZE) {
            return null;
        }

        // Calculate total packet size
        int totalSize = LENGTH_FILE_START + LENGTH_FILE_TYPE + LENGTH_FILE_PACKSIZE +
                       LENGTH_FILE_PACKINDEX + LENGTH_FILE_SIZE + LENGTH_FILE_NAME +
                       LENGTH_FILE_FLAG + packSize + LENGTH_FILE_VERIFY + LENGTH_FILE_END;

        byte[] packet = new byte[totalSize];
        int pos = 0;

        // Start code ##
        System.arraycopy(CMD_START_CODE, 0, packet, pos, LENGTH_FILE_START);
        pos += LENGTH_FILE_START;

        // File type
        packet[pos] = fileType;
        pos += LENGTH_FILE_TYPE;

        // Pack size (2 bytes, big-endian like reference implementation)
        packet[pos] = (byte)((packSize >> 8) & 0xFF);
        packet[pos + 1] = (byte)(packSize & 0xFF);
        pos += LENGTH_FILE_PACKSIZE;

        // Pack index (2 bytes, big-endian)
        packet[pos] = (byte)((packIndex >> 8) & 0xFF);
        packet[pos + 1] = (byte)(packIndex & 0xFF);
        pos += LENGTH_FILE_PACKINDEX;

        // File size (4 bytes, big-endian)
        packet[pos] = (byte)((fileSize >> 24) & 0xFF);
        packet[pos + 1] = (byte)((fileSize >> 16) & 0xFF);
        packet[pos + 2] = (byte)((fileSize >> 8) & 0xFF);
        packet[pos + 3] = (byte)(fileSize & 0xFF);
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
        packet[pos] = (byte)((flags >> 8) & 0xFF);
        packet[pos + 1] = (byte)(flags & 0xFF);
        pos += LENGTH_FILE_FLAG;

        // Data
        System.arraycopy(fileData, 0, packet, pos, packSize);
        pos += packSize;

        // Calculate verify code (checksum of data bytes)
        int checkSum = 0;
        for (int i = 0; i < packSize; i++) {
            checkSum += (fileData[i] & 0xFF);
        }
        packet[pos] = (byte)(checkSum & 0xFF);
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
            Log.e("K900ProtocolUtils", "extractFilePacket: Invalid format or too short. Length=" +
                  (protocolData != null ? protocolData.length : 0) +
                  ", isK900Format=" + isK900ProtocolFormat(protocolData));
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
        info.fileSize = ((protocolData[pos] & 0xFF) << 24) |
                       ((protocolData[pos + 1] & 0xFF) << 16) |
                       ((protocolData[pos + 2] & 0xFF) << 8) |
                       (protocolData[pos + 3] & 0xFF);
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
            Log.e("K900ProtocolUtils", "File packet too short for data. Need: " +
                  (pos + info.packSize + LENGTH_FILE_VERIFY + LENGTH_FILE_END) +
                  ", Have: " + protocolData.length +
                  ", packSize=" + info.packSize + ", pos=" + pos);
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
        byte calculatedVerify = (byte)(checkSum & 0xFF);

        info.isValid = (calculatedVerify == info.verifyCode);

        if (!info.isValid) {
            Log.e("K900ProtocolUtils", "File packet checksum failed. Expected: " +
                  String.format("%02X", info.verifyCode) + ", Calculated: " +
                  String.format("%02X", calculatedVerify));
        } else if (info.packIndex == 0
                || info.packIndex % 32 == 0
                || info.packIndex == (info.fileSize + FILE_PACK_SIZE - 1) / FILE_PACK_SIZE - 1) {
            Log.d("K900ProtocolUtils", "File packet extracted successfully: index=" + info.packIndex +
                  ", size=" + info.packSize + ", fileName=" + info.fileName);
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
            Log.e("K900ProtocolUtils", "Error creating file transfer ack", e);
            return null;
        }
    }
}
