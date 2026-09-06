package com.mentra.asg_client.io.hardware.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import android.os.SystemClock;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import java.time.Duration;
import org.robolectric.shadows.ShadowSystemClock;
import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class K900HardwareManagerBatteryTest {
    private K900HardwareManager connectedManager() {
        K900HardwareManager manager = new K900HardwareManager(RuntimeEnvironment.getApplication());
        K900BluetoothManager transport = mock(K900BluetoothManager.class);
        when(transport.isConnected()).thenReturn(true);
        when(transport.isCurrentUartEvidence(anyLong())).thenReturn(true);
        manager.setTransport(transport);
        return manager;
    }

    @Test
    public void cameraBoundaries_preserveFifteenAndUnknownButNeverExemptTheFloor() {
        K900HardwareManager manager = connectedManager();
        for (boolean charging : new boolean[] {false, true}) {
            for (int level : new int[] {-1, 0, 3, 4, 14, 15, 19, 20, 100}) {
                manager.notifyBatteryReading(level, 4200, charging, SystemClock.elapsedRealtime());
                boolean blocked = level >= 0 && level < 15 && (level <= 3 || !charging);
                assertThat(BatteryConstants.isCameraBatteryLow(level, manager)).isEqualTo(blocked);
                if (level < 0) assertThat(manager.allowsLowBatteryCamera(level)).isFalse();
            }
        }
    }

    @Test
    public void missingFieldOrHighVoltageCannotGrantException() {
        K900HardwareManager manager = connectedManager();
        manager.notifyBatteryReading(4, 4200);
        assertThat(manager.getChargingStatus()).isTrue(); // Legacy display heuristic is unchanged.
        assertThat(BatteryConstants.isCameraBatteryLow(4, manager)).isTrue();
    }

    @Test
    public void staleFutureAndMismatchedSocCannotGrantException() {
        K900HardwareManager manager = connectedManager();
        long now = SystemClock.elapsedRealtime();
        manager.notifyBatteryReading(4, 3700, true, now + 1);
        assertThat(manager.allowsLowBatteryCamera(4)).isFalse();
        manager.notifyBatteryReading(4, 3700, true, now);
        assertThat(manager.allowsLowBatteryCamera(5)).isFalse();
        assertThat(manager.allowsLowBatteryCamera(4)).isTrue();
        ShadowSystemClock.advanceBy(Duration.ofMillis(AsgConstants.CAMERA_ACTIVE_CHARGE_MAX_AGE_MS));
        assertThat(manager.allowsLowBatteryCamera(4)).isFalse();
        // Re-consuming an old queued event cannot restart its validity window.
        manager.notifyBatteryReading(4, 3700, true, now);
        assertThat(manager.allowsLowBatteryCamera(4)).isFalse();
    }

    @Test
    public void negativeOrLegacyReplyRevokesPriorChargingEvidence() {
        K900HardwareManager manager = connectedManager();
        manager.notifyBatteryReading(4, 3700, true, SystemClock.elapsedRealtime());
        assertThat(manager.allowsLowBatteryCamera(4)).isTrue();
        manager.notifyBatteryReading(4, 3700, false, SystemClock.elapsedRealtime());
        assertThat(manager.allowsLowBatteryCamera(4)).isFalse();
        manager.notifyBatteryReading(4, 3700, true, SystemClock.elapsedRealtime());
        manager.notifyBatteryReading(5, 4200);
        assertThat(manager.allowsLowBatteryCamera(5)).isFalse();
    }

    @Test
    public void olderQueuedPositiveCannotOverwriteNewerChargerLoss() {
        K900HardwareManager manager = connectedManager();
        long oldReceipt = SystemClock.elapsedRealtime();
        manager.notifyBatteryReading(4, 3700, true, oldReceipt);
        ShadowSystemClock.advanceBy(Duration.ofMillis(1));
        manager.notifyBatteryReading(4, 3700, false, SystemClock.elapsedRealtime());
        manager.notifyBatteryReading(4, 3700, true, oldReceipt);
        assertThat(manager.allowsLowBatteryCamera(4)).isFalse();
    }

    @Test
    public void lowBatteryRefreshesChargerBeforeNormalTwoMinuteCacheExpires() {
        K900HardwareManager manager = new K900HardwareManager(RuntimeEnvironment.getApplication());
        K900BluetoothManager transport = mock(K900BluetoothManager.class);
        when(transport.isConnected()).thenReturn(true);
        when(transport.isCurrentUartEvidence(anyLong())).thenReturn(true);
        manager.setTransport(transport);
        manager.notifyBatteryReading(4, 3700, true, SystemClock.elapsedRealtime());
        ShadowSystemClock.advanceBy(Duration.ofMillis(AsgConstants.CAMERA_BATTERY_REFRESH_MS));
        assertThat(manager.allowsLowBatteryCamera(4)).isTrue();
        verify(transport).sendMessage(any(byte[].class), any(IBluetoothManager.SendMessageCallback.class));
        when(transport.isConnected()).thenReturn(false);
        when(transport.isCurrentUartEvidence(anyLong())).thenReturn(false);
        assertThat(manager.allowsLowBatteryCamera(4)).isFalse();
    }

    @Test
    public void uartProofInvalidationRejectsOldQueuedEvidenceAfterReconnection() throws Exception {
        K900BluetoothManager transport = mock(K900BluetoothManager.class, org.mockito.Mockito.CALLS_REAL_METHODS);
        doReturn(true).when(transport).isConnected();
        java.lang.reflect.Field proof = K900BluetoothManager.class.getDeclaredField("framedPathProven");
        proof.setAccessible(true);
        proof.setBoolean(transport, true);
        ShadowSystemClock.advanceBy(Duration.ofMillis(1));
        long received = SystemClock.elapsedRealtime();
        assertThat(transport.isCurrentUartEvidence(received)).isTrue();
        java.lang.reflect.Method invalidate = K900BluetoothManager.class.getDeclaredMethod("invalidateFramedPathProof");
        invalidate.setAccessible(true);
        invalidate.invoke(transport);
        assertThat(transport.isCurrentUartEvidence(received)).isFalse();
        proof.setBoolean(transport, true); // New UART proof must not revive the old sample.
        assertThat(transport.isCurrentUartEvidence(received)).isFalse();
        ShadowSystemClock.advanceBy(Duration.ofMillis(1));
        assertThat(transport.isCurrentUartEvidence(SystemClock.elapsedRealtime())).isTrue();
        doReturn(false).when(transport).isConnected();
        assertThat(transport.isCurrentUartEvidence(SystemClock.elapsedRealtime())).isFalse();
    }

    @Test
    public void coldCache_allowsUartReaderToDeliverBatteryResponse() throws Exception {
        K900HardwareManager manager =
                new K900HardwareManager(RuntimeEnvironment.getApplication());
        K900BluetoothManager transport = mock(K900BluetoothManager.class);
        AtomicReference<Thread> responseThread = new AtomicReference<>();
        when(transport.isConnected()).thenReturn(true);
        doAnswer(
                        invocation -> {
                            IBluetoothManager.SendMessageCallback callback =
                                    invocation.getArgument(1);
                            Thread thread =
                                    new Thread(
                                            () -> {
                                                callback.onSendComplete(true);
                                                manager.notifyBatteryReading(82, 4100);
                                            },
                                            "test-battery-response");
                            responseThread.set(thread);
                            thread.start();
                            return true;
                        })
                .when(transport)
                .sendMessage(
                        any(byte[].class), any(IBluetoothManager.SendMessageCallback.class));
        manager.setTransport(transport);

        try {
            assertThat(manager.queryBatteryLevel()).isEqualTo(82);
            verify(transport)
                    .sendMessage(
                            any(byte[].class),
                            any(IBluetoothManager.SendMessageCallback.class));
        } finally {
            Thread thread = responseThread.get();
            if (thread != null) {
                thread.join(1_000);
                assertThat(thread.isAlive()).isFalse();
            }
        }
    }

    @Test
    public void queuedSendDelay_preservesFullBatteryResponseBudget() throws Exception {
        K900HardwareManager manager =
                new K900HardwareManager(RuntimeEnvironment.getApplication());
        K900BluetoothManager transport = mock(K900BluetoothManager.class);
        AtomicReference<Thread> responseThread = new AtomicReference<>();
        when(transport.isConnected()).thenReturn(true);
        doAnswer(
                        invocation -> {
                            IBluetoothManager.SendMessageCallback callback =
                                    invocation.getArgument(1);
                            Thread thread =
                                    new Thread(
                                            () -> {
                                                try {
                                                    Thread.sleep(300);
                                                    callback.onSendComplete(true);
                                                    Thread.sleep(100);
                                                    manager.notifyBatteryReading(64, 4000);
                                                } catch (InterruptedException e) {
                                                    Thread.currentThread().interrupt();
                                                }
                                            },
                                            "test-delayed-battery-response");
                            responseThread.set(thread);
                            thread.start();
                            return true;
                        })
                .when(transport)
                .sendMessage(
                        any(byte[].class), any(IBluetoothManager.SendMessageCallback.class));
        manager.setTransport(transport);

        try {
            assertThat(manager.queryBatteryLevel()).isEqualTo(64);
        } finally {
            Thread thread = responseThread.get();
            if (thread != null) {
                thread.join(1_000);
                assertThat(thread.isAlive()).isFalse();
            }
        }
    }

    @Test
    public void coldCachedGetter_queuesRefreshWithoutWaitingForSendCompletion() {
        K900HardwareManager manager =
                new K900HardwareManager(RuntimeEnvironment.getApplication());
        K900BluetoothManager transport = mock(K900BluetoothManager.class);
        when(transport.isConnected()).thenReturn(true);
        when(transport.sendMessage(
                        any(byte[].class), any(IBluetoothManager.SendMessageCallback.class)))
                .thenReturn(true);
        manager.setTransport(transport);

        assertThat(manager.getBatteryLevel()).isEqualTo(-1);
        verify(transport)
                .sendMessage(
                        any(byte[].class), any(IBluetoothManager.SendMessageCallback.class));
    }
}
