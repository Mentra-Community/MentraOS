package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesWireFormatTest {

    @After
    public void tearDown() {
        BesWireFormat.resetFilePackSize();
        BesWireFormat.resetBinaryProtocol();
    }

    @Test
    public void isK900ProtocolFormat_detectsStartMarkers() {
        byte[] packed =
                BesWireFormat.packDataCommand(
                        "hi".getBytes(StandardCharsets.UTF_8), BesWireFormat.CMD_TYPE_STRING);

        assertThat(BesWireFormat.isK900ProtocolFormat(packed)).isTrue();
        assertThat(BesWireFormat.isK900ProtocolFormat(new byte[] {0x00, 0x23, 0x23})).isFalse();
        assertThat(BesWireFormat.isK900ProtocolFormat(null)).isFalse();
    }

    @Test
    public void packDataCommand_wrapsPayloadWithMarkersAndLength() {
        byte[] payload = "{\"ping\":1}".getBytes(StandardCharsets.UTF_8);
        byte[] packed = BesWireFormat.packDataCommand(payload, BesWireFormat.CMD_TYPE_STRING);

        assertThat(packed).isNotNull();
        assertThat(packed[0]).isEqualTo((byte) 0x23);
        assertThat(packed[1]).isEqualTo((byte) 0x23);
        assertThat(packed[2]).isEqualTo(BesWireFormat.CMD_TYPE_STRING);
        assertThat(packed[3]).isEqualTo((byte) (payload.length & 0xFF));
        assertThat(packed[4]).isEqualTo((byte) ((payload.length >> 8) & 0xFF));
        assertThat(packed[packed.length - 2]).isEqualTo((byte) 0x24);
        assertThat(packed[packed.length - 1]).isEqualTo((byte) 0x24);
    }

    @Test
    public void packBinaryFragment_usesLittleEndianLengthAndHeader() {
        byte[] payload = "hello".getBytes(StandardCharsets.UTF_8);
        byte flags = (byte) (BesWireFormat.FLAG_FIRST_FRAG | BesWireFormat.FLAG_LAST_FRAG);
        byte[] frame = BesWireFormat.packBinaryFragment(flags, 0x1234, 0, 1, payload);

        assertThat(frame[2]).isEqualTo(BesWireFormat.CMD_TYPE_BINARY_MSG);
        int innerLen = (frame[3] & 0xFF) | ((frame[4] & 0xFF) << 8);
        assertThat(innerLen).isEqualTo(BesWireFormat.BINARY_HEADER_SIZE + payload.length);
        assertThat(frame.length).isEqualTo(BesWireFormat.LENGTH_CMD_MIN_SIZE + innerLen);

        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(frame);
        assertThat(header.valid).isTrue();
        assertThat(header.msgId).isEqualTo(0x1234);
        assertThat(header.payloadLen).isEqualTo(payload.length);
        assertThat(header.payload).isEqualTo(payload);
    }

    @Test
    public void packV2HandshakeFrame_containsHandshakePayload() {
        byte[] frame = BesWireFormat.packV2HandshakeFrame();
        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(frame);

        assertThat(header.valid).isTrue();
        assertThat(header.flags & BesWireFormat.FLAG_HANDSHAKE).isNotZero();
        assertThat(BesWireFormat.isV2HandshakePayload(header.payload)).isTrue();
    }

    @Test
    public void formatBinaryMessageForTransmission_dropsWrapperForHighRoiJson() throws Exception {
        BesWireFormat.setBinaryProtocolActive(true);
        String json = "{\"type\":\"photo_status\",\"status\":\"capturing\",\"timestamp\":1}";
        byte[] frame = BesWireFormat.formatBinaryMessageForTransmission(json);
        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(frame);

        assertThat(header.valid).isTrue();
        assertThat(new String(header.payload, StandardCharsets.UTF_8))
                .isEqualTo(BesWireFormat.createTransmissionWrapperJson(json));
    }

    @Test
    public void createTransmissionWrapperJson_keepsLowRoiExpandedOnV2() throws Exception {
        BesWireFormat.setBinaryProtocolActive(true);
        String json = "{\"type\":\"ping\"}";
        String wrapped = BesWireFormat.createTransmissionWrapperJson(json);

        assertThat(wrapped).doesNotContain("\"V\"");
        assertThat(wrapped).doesNotContain("\"B\"");
        assertThat(wrapped).contains("\"type\":\"ping\"");
        assertThat(wrapped).doesNotContain("\"t\":\"ping\"");
    }

    @Test
    public void createTransmissionWrapperJson_compactsHighRoiOnV2() throws Exception {
        BesWireFormat.setBinaryProtocolActive(true);
        String json = "{\"type\":\"photo_status\",\"status\":\"capturing\"}";
        String wrapped = BesWireFormat.createTransmissionWrapperJson(json);

        assertThat(wrapped).contains("\"t\":\"photo_status\"");
        assertThat(wrapped).contains("\"s\":3");
    }

    @Test
    public void setFilePackSizeFromMtu_clampsToValidRange() {
        BesWireFormat.setFilePackSizeFromMtu(23, true);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(BesWireFormat.FILE_PACK_SIZE_MIN);

        BesWireFormat.setFilePackSizeFromMtu(509, true);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(474);

        BesWireFormat.setFilePackSizeFromMtu(509, false);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(400);

        BesWireFormat.setFilePackSizeFromMtu(200, true);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(165);
    }

    @Test
    public void setFilePackSize_clampsToNegotiatedMaximum() {
        BesWireFormat.setFilePackSize(832);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(800);

        BesWireFormat.setFilePackSize(640);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(640);
    }

    @Test
    public void fileAckPacketIndex_usesAsymmetricBesSemantics() {
        assertThat(BesWireFormat.fileAckPacketIndex(1, 16)).isEqualTo(15);
        assertThat(BesWireFormat.fileAckPacketIndex(0, 16)).isEqualTo(16);
    }

    @Test
    public void packJsonCommand_wrapsWithCField() {
        byte[] packed = BesWireFormat.packJsonCommand("{\"type\":\"ping\"}");

        assertThat(packed).isNotNull();
        assertThat(BesWireFormat.isK900ProtocolFormat(packed)).isTrue();
        String inner = new String(packed, 5, packed.length - 7, StandardCharsets.UTF_8);
        assertThat(inner).contains("\"C\"");
        assertThat(inner).contains("ping");
    }

    @Test
    public void createTransmissionWrapperJson_dropsVersionAndBodyWhenV2() throws Exception {
        BesWireFormat.setBinaryProtocolActive(true);
        String json = "{\"type\":\"glasses_ready\",\"timestamp\":1}";
        String wrapped = BesWireFormat.createTransmissionWrapperJson(json);

        assertThat(wrapped).doesNotContain("\"V\"");
        assertThat(wrapped).doesNotContain("\"B\"");
        assertThat(wrapped).contains("\"type\":\"glasses_ready\"");
        assertThat(wrapped).doesNotContain("\"t\":\"glasses_ready\"");
    }

    @Test
    public void createCWrappedJson_producesCFieldWrapper() {
        String wrapped = BesWireFormat.createCWrappedJson("hello");

        assertThat(wrapped).isEqualTo("{\"C\":\"hello\"}");
    }

    @Test
    public void packDataCommand_bigEndianWritesLengthMsbFirst() {
        byte[] payload = "{\"ping\":1}".getBytes(StandardCharsets.UTF_8);
        byte[] packed =
                BesWireFormat.packDataCommand(
                        payload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.BE);

        assertThat(packed[3]).isEqualTo((byte) ((payload.length >> 8) & 0xFF));
        assertThat(packed[4]).isEqualTo((byte) (payload.length & 0xFF));
    }

    @Test
    public void formatMessageForTransmission_fallbackKeepsNegotiatedEndian() {
        byte[] packed =
                BesWireFormat.formatMessageForTransmission("{bad", K900LengthCodec.Endian.BE);
        int length = K900LengthCodec.readLength(packed, 3, K900LengthCodec.Endian.BE);

        assertThat(packed[2]).isEqualTo(BesWireFormat.CMD_TYPE_STRING);
        assertThat(packed[3]).isEqualTo((byte) ((length >> 8) & 0xFF));
        assertThat(packed[4]).isEqualTo((byte) (length & 0xFF));
    }

    @Test
    public void otaAuthorizationRequest_usesLegacyBigEndianStringFrameBeforeWireCaps()
            throws Exception {
        String authRequest =
                new JSONObject().put("C", "mh_ota").put("V", 1).put("B", "{}").toString();
        byte[] payload = authRequest.getBytes(StandardCharsets.UTF_8);

        byte[] packed =
                BesWireFormat.packDataCommand(
                        payload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.BE);

        assertThat(packed[2]).isEqualTo(BesWireFormat.CMD_TYPE_STRING);
        assertThat(K900LengthCodec.readLength(packed, 3, K900LengthCodec.Endian.BE))
                .isEqualTo(payload.length);
        assertThat(K900LengthCodec.readLength(packed, 3, K900LengthCodec.Endian.LE))
                .isGreaterThan(K900LengthCodec.MAX_STRING_LENGTH);
        byte[] extracted = BesWireFormat.extractPayloadAuto(packed);
        assertThat(extracted).isEqualTo(payload);

        JSONObject parsed = new JSONObject(new String(extracted, StandardCharsets.UTF_8));
        assertThat(parsed.getString("C")).isEqualTo("mh_ota");
        assertThat(parsed.getInt("V")).isEqualTo(1);
        assertThat(parsed.getString("B")).isEqualTo("{}");
    }

    @Test
    public void extractPayload_roundTripsForBothEndianness() {
        byte[] payload = "{\"type\":\"ping\"}".getBytes(StandardCharsets.UTF_8);

        byte[] be =
                BesWireFormat.packDataCommand(
                        payload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.BE);
        byte[] le =
                BesWireFormat.packDataCommand(
                        payload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.LE);

        assertThat(BesWireFormat.extractPayload(be, K900LengthCodec.Endian.BE)).isEqualTo(payload);
        assertThat(BesWireFormat.extractPayload(le, K900LengthCodec.Endian.LE)).isEqualTo(payload);
    }

    @Test
    public void extractPayloadAuto_detectsBigEndianLegacyFrame() {
        byte[] payload = "{\"type\":\"cs_syvr\"}".getBytes(StandardCharsets.UTF_8);
        byte[] be =
                BesWireFormat.packDataCommand(
                        payload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.BE);

        assertThat(BesWireFormat.extractPayloadAuto(be)).isEqualTo(payload);
    }

    @Test
    public void extractPayloadAuto_detectsLittleEndianWireV2Frame() {
        byte[] payload = "{\"type\":\"cs_syvr\"}".getBytes(StandardCharsets.UTF_8);
        byte[] le =
                BesWireFormat.packDataCommand(
                        payload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.LE);

        assertThat(BesWireFormat.extractPayloadAuto(le)).isEqualTo(payload);
    }

    @Test
    public void linkHealthFrame_rejectsMarkerShapedGarbage() {
        byte[] markerShapedGarbage = {'#', '#', 0x30, 0x00, 0x01, 'x', '$', '$'};

        assertThat(BesWireFormat.extractPayloadAuto(markerShapedGarbage))
                .containsExactly((byte) 'x');
        assertThat(BesWireFormat.isValidLinkHealthFrame(markerShapedGarbage)).isFalse();
    }

    @Test
    public void linkHealthFrame_acceptsExactJsonAndBinaryFrames() {
        byte[] jsonPayload = "{\"C\":\"sr_syvr\"}".getBytes(StandardCharsets.UTF_8);
        byte[] jsonFrame =
                BesWireFormat.packDataCommand(
                        jsonPayload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.BE);
        byte[] binaryFrame =
                BesWireFormat.packBinaryFragment(
                        (byte) (BesWireFormat.FLAG_FIRST_FRAG | BesWireFormat.FLAG_LAST_FRAG),
                        7,
                        0,
                        1,
                        new byte[] {1, 2, 3});

        assertThat(BesWireFormat.isValidLinkHealthFrame(jsonFrame)).isTrue();
        assertThat(BesWireFormat.isValidLinkHealthFrame(binaryFrame)).isTrue();
    }

    @Test
    public void repackStringFrame_transcodesLengthEndiannessOnly() {
        byte[] payload = "{\"type\":\"ping\"}".getBytes(StandardCharsets.UTF_8);
        byte[] be =
                BesWireFormat.packDataCommand(
                        payload, BesWireFormat.CMD_TYPE_STRING, K900LengthCodec.Endian.BE);

        byte[] le =
                K900LengthCodec.repackStringFrame(
                        be, K900LengthCodec.Endian.BE, K900LengthCodec.Endian.LE);

        // Length bytes swapped, payload untouched.
        assertThat(le[3]).isEqualTo((byte) (payload.length & 0xFF));
        assertThat(le[4]).isEqualTo((byte) ((payload.length >> 8) & 0xFF));
        assertThat(BesWireFormat.extractPayload(le, K900LengthCodec.Endian.LE)).isEqualTo(payload);
    }
}
