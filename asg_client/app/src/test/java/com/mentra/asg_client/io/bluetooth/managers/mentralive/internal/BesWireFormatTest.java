package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
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
    public void formatBinaryMessageForTransmission_dropsWrapperForRegularJson() throws Exception {
        BesWireFormat.setBinaryProtocolActive(true);
        String json = "{\"type\":\"glasses_ready\",\"timestamp\":1}";
        byte[] frame = BesWireFormat.formatBinaryMessageForTransmission(json);
        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(frame);

        assertThat(header.valid).isTrue();
        // v2 transport carries the compacted, wrapper-free wire payload (no C/V/B envelope).
        assertThat(new String(header.payload, StandardCharsets.UTF_8))
                .isEqualTo(BesWireFormat.createTransmissionWrapperJson(json));
    }

    @Test
    public void setFilePackSizeFromMtu_clampsToValidRange() {
        BesWireFormat.setFilePackSizeFromMtu(23);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(BesWireFormat.FILE_PACK_SIZE_MIN);

        BesWireFormat.setFilePackSizeFromMtu(512);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(BesWireFormat.FILE_PACK_SIZE_DEFAULT);

        BesWireFormat.setFilePackSizeFromMtu(200);
        assertThat(BesWireFormat.getFilePackSize()).isEqualTo(165);
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
        assertThat(wrapped).contains("\"t\":\"glasses_ready\"");
    }

    @Test
    public void createCWrappedJson_producesCFieldWrapper() {
        String wrapped = BesWireFormat.createCWrappedJson("hello");

        assertThat(wrapped).isEqualTo("{\"C\":\"hello\"}");
    }
}
