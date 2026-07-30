package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

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
import java.util.concurrent.atomic.AtomicReference;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class SerialPortBridgeSessionTest {

    @Test
    public void openAtBaudOnClosedPort_attemptsExactBaudAndReportsDriverFailure() {
        SerialPortBridge bridge = new SerialPortBridge(ApplicationProvider.getApplicationContext());

        // Robolectric has no native serial driver, so the exact open fails. The important contract
        // is that a previously closed bridge is allowed to make the attempt and remains
        // restartable.
        assertThat(bridge.isOpen()).isFalse();
        assertThat(bridge.openAtBaud(SerialPortBridge.DEFAULT_BAUDRATE)).isNull();
        assertThat(bridge.isOpen()).isFalse();
    }

    @Test
    public void readerCarriesItsCreationSessionIntoCallback() throws Exception {
        SerialPortBridge bridge = new SerialPortBridge(ApplicationProvider.getApplicationContext());
        CountDownLatch received = new CountDownLatch(1);
        AtomicReference<SerialSession> callbackSession = new AtomicReference<>();
        bridge.registerListener(
                new SerialListener() {
                    @Override
                    public void onSerialOpen(
                            boolean success, int code, String serialPath, String message) {}

                    @Override
                    public void onSerialReady(String serialPath, SerialSession session) {}

                    @Override
                    public void onSerialRead(
                            String serialPath, byte[] data, int size, SerialSession session) {
                        callbackSession.set(session);
                        received.countDown();
                    }

                    @Override
                    public void onSerialClose(String serialPath) {}
                });
        SerialSession session = new SerialSession(42, "/dev/ttyS1", 460800);
        SerialPortBridge.RecvThread reader =
                bridge.new RecvThread(new ByteArrayInputStream(new byte[] {1}), session);

        reader.start();
        assertThat(received.await(1, TimeUnit.SECONDS)).isTrue();
        reader.setStop();
        reader.interrupt();

        assertThat(callbackSession.get()).isSameAs(session);
    }

    @Test
    public void retiredSession_suppressesBytesAlreadyReadByItsReader() throws Exception {
        SerialPortBridge bridge = new SerialPortBridge(ApplicationProvider.getApplicationContext());
        CountDownLatch received = new CountDownLatch(1);
        bridge.registerListener(
                new SerialListener() {
                    @Override
                    public void onSerialOpen(
                            boolean success, int code, String serialPath, String message) {}

                    @Override
                    public void onSerialReady(String serialPath, SerialSession session) {}

                    @Override
                    public void onSerialRead(
                            String serialPath, byte[] data, int size, SerialSession session) {
                        received.countDown();
                    }

                    @Override
                    public void onSerialClose(String serialPath) {}
                });
        SerialSession session = new SerialSession(7, "/dev/ttyS1", 460800);
        session.retire();
        SerialPortBridge.RecvThread reader =
                bridge.new RecvThread(new ByteArrayInputStream(new byte[] {1}), session);

        reader.start();
        assertThat(received.await(200, TimeUnit.MILLISECONDS)).isFalse();
        reader.setStop();
        reader.interrupt();
    }
}
