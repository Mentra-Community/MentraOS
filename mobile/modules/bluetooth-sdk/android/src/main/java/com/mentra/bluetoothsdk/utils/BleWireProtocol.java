package com.mentra.bluetoothsdk.utils;

import java.nio.charset.StandardCharsets;

/**
 * BLE Wire Protocol v2 shared constants and binary frame helpers.
 * All multi-byte fields use little-endian byte order.
 */
public final class BleWireProtocol {

    private BleWireProtocol() {}

    public static final byte CMD_TYPE_BINARY_MSG = 0x40;

    public static final byte BLE_WIRE_FLAG_FIRST_FRAG = 0x01;
    public static final byte BLE_WIRE_FLAG_LAST_FRAG = 0x02;
    public static final byte BLE_WIRE_FLAG_WAKE = 0x04;
    public static final byte BLE_WIRE_FLAG_HANDSHAKE = 0x08;
    public static final byte BLE_WIRE_FLAG_ACK_REQUESTED = 0x10;

    public static final int BINARY_HEADER_SIZE = 7;
    public static final int MAX_FRAGMENT_PAYLOAD = 480;
    public static final int MTU_TARGET = 509;

    public static final String HANDSHAKE_PAYLOAD_V2 = "v2";
    public static final int PROTOCOL_V1 = 1;
    public static final int PROTOCOL_V2 = 2;

    public static class BinaryFragmentInfo {
        public byte flags;
        public int msgId;
        public int fragIdx;
        public int fragCount;
        public byte[] payload;
    }

    public static boolean isBinaryFrame(byte[] data) {
        return K900ProtocolUtils.isK900ProtocolFormat(data)
                && data.length >= 7
                && data[2] == CMD_TYPE_BINARY_MSG;
    }

    public static byte[] packBinaryFragment(
            byte flags, int msgId, int fragIdx, int fragCount, byte[] payload) {
        int payloadLen = payload != null ? payload.length : 0;
        byte[] inner = new byte[BINARY_HEADER_SIZE + payloadLen];
        inner[0] = flags;
        writeLe16(inner, 1, msgId);
        inner[3] = (byte) fragIdx;
        inner[4] = (byte) fragCount;
        writeLe16(inner, 5, payloadLen);
        if (payloadLen > 0) {
            System.arraycopy(payload, 0, inner, BINARY_HEADER_SIZE, payloadLen);
        }
        return K900ProtocolUtils.packDataToK900(
                inner, CMD_TYPE_BINARY_MSG, K900LengthCodec.Endian.LE);
    }

    public static BinaryFragmentInfo extractBinaryFragmentInfo(byte[] frame) {
        if (!isBinaryFrame(frame)) {
            return null;
        }

        int innerLen = readLe16(frame, 3);
        if (innerLen < BINARY_HEADER_SIZE || frame.length < 7 + innerLen) {
            return null;
        }

        int offset = 5;
        int payloadLen = readLe16(frame, offset + 5);
        if (BINARY_HEADER_SIZE + payloadLen > innerLen) {
            return null;
        }

        BinaryFragmentInfo info = new BinaryFragmentInfo();
        info.flags = frame[offset];
        info.msgId = readLe16(frame, offset + 1);
        info.fragIdx = frame[offset + 3] & 0xFF;
        info.fragCount = frame[offset + 4] & 0xFF;
        info.payload = new byte[payloadLen];
        if (payloadLen > 0) {
            System.arraycopy(frame, offset + BINARY_HEADER_SIZE, info.payload, 0, payloadLen);
        }
        return info;
    }

    public static byte[] extractBinaryPayload(byte[] frame) {
        BinaryFragmentInfo info = extractBinaryFragmentInfo(frame);
        return info != null ? info.payload : null;
    }

    public static boolean isHandshakeV2(BinaryFragmentInfo info) {
        if (info == null || (info.flags & BLE_WIRE_FLAG_HANDSHAKE) == 0) {
            return false;
        }
        String payload = new String(info.payload, StandardCharsets.UTF_8);
        return HANDSHAKE_PAYLOAD_V2.equals(payload);
    }

    static int readLe16(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    static void writeLe16(byte[] data, int offset, int value) {
        data[offset] = (byte) (value & 0xFF);
        data[offset + 1] = (byte) ((value >> 8) & 0xFF);
    }
}
