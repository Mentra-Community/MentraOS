package com.mentra.asg_client.io.bluetooth.managers;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class K900BluetoothManagerBaudPolicyTest {

    @Test
    public void alternateBootProbe_requiresCachedBaudCapableFirmware() {
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud(null)).isFalse();
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("")).isFalse();
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("17.26.7.4")).isFalse();
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("17.26.7.5")).isTrue();
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("17.26.7.20")).isTrue();
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("17.26.7.5-fix1")).isTrue();
    }

    @Test
    public void alternateBootProbe_prefersExactGateVersionOverDisplayVersion() {
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("17.26.7.5", "17.26.7.4"))
                .isTrue();
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("17.26.7.4", "17.26.7.5"))
                .isFalse();
        assertThat(K900BluetoothManager.shouldProbeAlternateBaud("", "17.26.7.5")).isTrue();
    }
}
