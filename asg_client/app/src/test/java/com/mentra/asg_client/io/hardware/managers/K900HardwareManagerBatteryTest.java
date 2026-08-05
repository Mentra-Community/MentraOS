package com.mentra.asg_client.io.hardware.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
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
                            Thread thread =
                                    new Thread(
                                            () -> manager.notifyBatteryReading(82, 4100),
                                            "test-battery-response");
                            responseThread.set(thread);
                            thread.start();
                            return true;
                        })
                .when(transport)
                .sendMessage(any(byte[].class));
        manager.setTransport(transport);

        assertThat(manager.getBatteryLevel()).isEqualTo(82);
        responseThread.get().join(1_000);
        assertThat(responseThread.get().isAlive()).isFalse();
        verify(transport).sendMessage(any(byte[].class));
    }
}
