package com.mentra.asg_client.service.utils;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class SysPropTest {

    @Test
    public void normalizeDeviceSerial_keepsProvisionedAndroidSerial() {
        assertThat(SysProp.normalizeDeviceSerial(" ML394037B ")).isEqualTo("ML394037B");
    }

    @Test
    public void normalizeDeviceSerial_rejectsMissingAndFactoryDefaultValues() {
        assertThat(SysProp.normalizeDeviceSerial(null)).isEmpty();
        assertThat(SysProp.normalizeDeviceSerial(" unknown ")).isEmpty();
        assertThat(SysProp.normalizeDeviceSerial("0000000000")).isEmpty();
        assertThat(SysProp.normalizeDeviceSerial("0123456789ABCDEF")).isEmpty();
        assertThat(SysProp.normalizeDeviceSerial(" 0123456789abcdef ")).isEmpty();
    }

    @Test
    public void normalizeBesBtMac_canonicalizesValidAddress() {
        assertThat(SysProp.normalizeBesBtMac(" aa:bb:cc:dd:ee:ff "))
                .isEqualTo("AA:BB:CC:DD:EE:FF");
    }

    @Test
    public void normalizeBesBtMac_rejectsInvalidAndEmptyAddresses() {
        assertThat(SysProp.normalizeBesBtMac("")).isEmpty();
        assertThat(SysProp.normalizeBesBtMac("unknown")).isEmpty();
        assertThat(SysProp.normalizeBesBtMac("00:00:00:00:00:00")).isEmpty();
    }
}
