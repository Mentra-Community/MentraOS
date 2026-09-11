package com.mentra.bluetoothsdk.utils;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class K900ProtocolUtilsTest {

    @Test
    public void packDataToK900_usesBigEndianLengthAt256ByteBoundary() {
        byte[] payload = new byte[256];

        byte[] packet = K900ProtocolUtils.packDataToK900(payload, K900ProtocolUtils.CMD_TYPE_STRING);

        assertThat(packet).hasSize(263);
        assertThat(packet[0]).isEqualTo((byte) '#');
        assertThat(packet[1]).isEqualTo((byte) '#');
        assertThat(packet[2]).isEqualTo(K900ProtocolUtils.CMD_TYPE_STRING);
        assertThat(packet[3]).isEqualTo((byte) 0x01);
        assertThat(packet[4]).isEqualTo((byte) 0x00);
        assertThat(packet[261]).isEqualTo((byte) '$');
        assertThat(packet[262]).isEqualTo((byte) '$');
    }
}
