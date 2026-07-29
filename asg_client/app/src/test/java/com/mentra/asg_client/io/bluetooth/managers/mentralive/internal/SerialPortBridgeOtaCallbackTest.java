package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import android.app.Application;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.ByteArrayInputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class SerialPortBridgeOtaCallbackTest {

    @Test
    public void otaApplied_notifiesNormalSerialOwner() {
        SerialPortBridge bridge = new SerialPortBridge(ApplicationProvider.getApplicationContext());
        SerialListener listener = mock(SerialListener.class);
        bridge.registerListener(listener);

        bridge.notifyBesOtaApplied();

        verify(listener).onBesOtaApplied();
    }

    @Test
    public void openAtBaudOnClosedPort_attemptsExactBaudAndReportsDriverFailure() {
        SerialPortBridge bridge = new SerialPortBridge(ApplicationProvider.getApplicationContext());

        // Robolectric has no native serial driver, so the exact open fails. The important contract
        // is that a previously closed bridge is allowed to make the attempt and remains
        // restartable.
        assertThat(bridge.isOpen()).isFalse();
        assertThat(bridge.openAtBaud(SerialPortBridge.DEFAULT_BAUDRATE)).isFalse();
        assertThat(bridge.isOpen()).isFalse();
    }

    @Test
    public void readerCarriesItsCreationGenerationIntoCallback() throws Exception {
        SerialPortBridge bridge = new SerialPortBridge(ApplicationProvider.getApplicationContext());
        CountDownLatch received = new CountDownLatch(1);
        AtomicLong callbackGeneration = new AtomicLong(-1);
        bridge.registerListener(
                new SerialListener() {
                    @Override
                    public void onSerialOpen(
                            boolean success, int code, String serialPath, String message) {}

                    @Override
                    public void onSerialReady(String serialPath, long readerGeneration) {}

                    @Override
                    public void onSerialRead(
                            String serialPath, byte[] data, int size, long readerGeneration) {
                        callbackGeneration.set(readerGeneration);
                        received.countDown();
                    }

                    @Override
                    public void onSerialClose(String serialPath) {}
                });
        SerialPortBridge.RecvThread reader =
                bridge.new RecvThread(new ByteArrayInputStream(new byte[] {1}), 42);

        reader.start();
        assertThat(received.await(1, TimeUnit.SECONDS)).isTrue();
        reader.setStop();
        reader.interrupt();

        assertThat(callbackGeneration.get()).isEqualTo(42);
    }
}
