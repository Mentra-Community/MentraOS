package com.mentra.asg_client.io.bluetooth.managers;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;

import com.mentra.asg_client.AsgConstants;

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

    @Test
    public void runtimeRecovery_requiresConfirmedHighBaudGarbage() {
        long threshold = AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES;

        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, false, 1, threshold))
                .isTrue();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                460800, false, false, false, false, 1, threshold))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, true, false, false, false, 1, threshold))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, true, false, false, 1, threshold))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, true, false, 1, threshold))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, true, 1, threshold))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, false, 0, threshold))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, false, 1, threshold - 1))
                .isFalse();
    }
}
