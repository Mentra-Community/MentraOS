package com.mentra.asg_client.io.hardware.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
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
            assertThat(manager.getBatteryLevel()).isEqualTo(82);
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
            assertThat(manager.getBatteryLevel()).isEqualTo(64);
        } finally {
            Thread thread = responseThread.get();
            if (thread != null) {
                thread.join(1_000);
                assertThat(thread.isAlive()).isFalse();
            }
        }
    }
}
