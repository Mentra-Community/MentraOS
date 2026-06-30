package com.mentra.bluetoothsdk.utils;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;

public class K900ProtocolUtilsEndiannessTest {

    @Test
    public void packDataCommandUsesLittleEndianLength() {
        byte[] payload = new byte[0x123];
        byte[] packed = K900ProtocolUtils.packDataCommand(payload, K900ProtocolUtils.CMD_TYPE_STRING);

        assertEquals(0x23, packed[3] & 0xFF);
        assertEquals(0x01, packed[4] & 0xFF);
    }

    @Test
    public void extractPayloadUsesLittleEndianLength() {
        byte[] payload = "{\"t\":\"ping\"}".getBytes(StandardCharsets.UTF_8);
        byte[] packed = K900ProtocolUtils.packDataToK900(payload, K900ProtocolUtils.CMD_TYPE_STRING);
        byte[] extracted = K900ProtocolUtils.extractPayload(packed);

        assertNotNull(extracted);
        assertArrayEquals(payload, extracted);
    }

    @Test
    public void processReceivedBytesToJsonUsesLittleEndianLength() throws Exception {
        String inner = "{\"type\":\"ping\"}";
        byte[] packed = K900ProtocolUtils.packDataToK900(
                inner.getBytes(StandardCharsets.UTF_8),
                K900ProtocolUtils.CMD_TYPE_STRING);

        JSONObject json = K900ProtocolUtils.processReceivedBytesToJson(packed);

        assertNotNull(json);
        assertEquals("ping", json.getString("type"));
    }

    @Test
    public void packAndExtractBinaryFragmentRoundTrip() {
        byte[] payload = "v2".getBytes(StandardCharsets.UTF_8);
        byte flags = (byte) (BleWireProtocol.BLE_WIRE_FLAG_HANDSHAKE
                | BleWireProtocol.BLE_WIRE_FLAG_FIRST_FRAG
                | BleWireProtocol.BLE_WIRE_FLAG_LAST_FRAG);
        byte[] frame = K900ProtocolUtils.packBinaryFragment(flags, 0, 0, 1, payload);

        assertTrue(K900ProtocolUtils.isBinaryFrame(frame));

        BleWireProtocol.BinaryFragmentInfo info = K900ProtocolUtils.extractBinaryFragmentInfo(frame);
        assertNotNull(info);
        assertEquals(flags, info.flags);
        assertEquals(0, info.msgId);
        assertEquals(0, info.fragIdx);
        assertEquals(1, info.fragCount);
        assertArrayEquals(payload, info.payload);
        assertTrue(BleWireProtocol.isHandshakeV2(info));
    }
}
