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
    }

    @Test
    public void isK900ProtocolFormat_detectsStartMarkers() {
        byte[] packed = BesWireFormat.packDataCommand("hi".getBytes(StandardCharsets.UTF_8), BesWireFormat.CMD_TYPE_STRING);

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
        assertThat(packed[3]).isEqualTo((byte) 0x00);
        assertThat(packed[4]).isEqualTo((byte) payload.length);
        assertThat(packed[packed.length - 2]).isEqualTo((byte) 0x24);
        assertThat(packed[packed.length - 1]).isEqualTo((byte) 0x24);
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
    public void createCWrappedJson_producesCFieldWrapper() {
        String wrapped = BesWireFormat.createCWrappedJson("hello");

        assertThat(wrapped).isEqualTo("{\"C\":\"hello\"}");
    }
}
