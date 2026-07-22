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
    public void runtimeRecovery_acceptsSmallRepeatedWrongBaudBursts() {
        long threshold = AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES;
        int events = AsgConstants.UART_RUNTIME_RECOVERY_DISCARD_EVENTS;

        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, false, 1, threshold, 1))
                .isTrue();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, false, 1, 1, events))
                .isTrue();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, false, 1, threshold - 1, events - 1))
                .isFalse();
    }

    @Test
    public void runtimeRecovery_requiresConfirmedIdleHighBaudTransport() {
        long threshold = AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES;
        int events = AsgConstants.UART_RUNTIME_RECOVERY_DISCARD_EVENTS;

        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                460800, false, false, false, false, 1, threshold, events))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, true, false, false, false, 1, threshold, events))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, true, false, false, 1, threshold, events))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, true, false, 1, threshold, events))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, true, 1, threshold, events))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldStartRuntimeBaudRecovery(
                                1152000, false, false, false, false, 0, threshold, events))
                .isFalse();
    }

    @Test
    public void idleHealthCheck_usesTheSameSafetyGatesWithoutRequiringGarbage() {
        assertThat(
                        K900BluetoothManager.shouldRunHighBaudHealthCheck(
                                1152000, false, false, false, false, 1))
                .isTrue();
        assertThat(
                        K900BluetoothManager.shouldRunHighBaudHealthCheck(
                                460800, false, false, false, false, 1))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldRunHighBaudHealthCheck(
                                1152000, true, false, false, false, 1))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldRunHighBaudHealthCheck(
                                1152000, false, true, false, false, 1))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldRunHighBaudHealthCheck(
                                1152000, false, false, true, false, 1))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldRunHighBaudHealthCheck(
                                1152000, false, false, false, true, 1))
                .isFalse();
        assertThat(
                        K900BluetoothManager.shouldRunHighBaudHealthCheck(
                                1152000, false, false, false, false, 0))
                .isFalse();
    }
}
