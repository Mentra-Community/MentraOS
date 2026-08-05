package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

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

    @Test
    public void openAtBaud_waitsForClosedReaderBeforeOpeningReplacement() throws Exception {
        BlockingInputStream firstInput = new BlockingInputStream(true);
        FakeSerialDriver driver =
                new FakeSerialDriver(firstInput, new ByteArrayInputStream(new byte[0]));
        SerialPortBridge bridge =
                new SerialPortBridge(
                        ApplicationProvider.getApplicationContext(), driver, 200 /* timeoutMs */);

        assertThat(bridge.start()).isTrue();
        assertThat(firstInput.awaitRead()).isTrue();
        SerialSession firstSession = bridge.getCurrentSession();

        SerialSession replacement = bridge.openAtBaud(921600);

        assertThat(replacement).isNotNull();
        assertThat(firstInput.awaitReadExit()).isTrue();
        assertThat(firstSession.isActive()).isFalse();
        assertThat(bridge.getCurrentSession()).isSameAs(replacement);
        assertThat(driver.openBauds).containsExactly(SerialPortBridge.DEFAULT_BAUDRATE, 921600);

        assertThat(bridge.startReader(replacement)).isTrue();
        bridge.stop();
    }

    @Test
    public void openAtBaud_refusesReplacementWhileClosedReaderIsStillAlive() throws Exception {
        BlockingInputStream stuckInput = new BlockingInputStream(false);
        FakeSerialDriver driver =
                new FakeSerialDriver(stuckInput, new ByteArrayInputStream(new byte[0]));
        SerialPortBridge bridge =
                new SerialPortBridge(
                        ApplicationProvider.getApplicationContext(), driver, 25 /* timeoutMs */);

        assertThat(bridge.start()).isTrue();
        assertThat(stuckInput.awaitRead()).isTrue();
        SerialSession firstSession = bridge.getCurrentSession();

        assertThat(bridge.openAtBaud(921600)).isNull();

        assertThat(firstSession.isActive()).isFalse();
        assertThat(bridge.isOpen()).isFalse();
        assertThat(bridge.getCurrentSession()).isNull();
        assertThat(driver.openBauds).containsExactly(SerialPortBridge.DEFAULT_BAUDRATE);

        // Once the native read really exits, the retained reader handle permits a safe retry.
        stuckInput.release();
        SerialSession replacement = bridge.openAtBaud(921600);
        assertThat(replacement).isNotNull();
        assertThat(driver.openBauds).containsExactly(SerialPortBridge.DEFAULT_BAUDRATE, 921600);
        bridge.closeSession(replacement);
    }

    private static final class FakeSerialDriver implements SerialPortBridge.SerialDriver {
        private final Queue<InputStream> inputs;
        private InputStream activeInput;
        final List<Integer> openBauds = new ArrayList<>();

        FakeSerialDriver(InputStream... inputs) {
            this.inputs = new ArrayDeque<>(Arrays.asList(inputs));
        }

        @Override
        public boolean open(String path, int baud) {
            openBauds.add(baud);
            activeInput = inputs.remove();
            return true;
        }

        @Override
        public InputStream getInputStream(String path) {
            return activeInput;
        }

        @Override
        public OutputStream getOutputStream(String path) {
            return new ByteArrayOutputStream();
        }

        @Override
        public void close(String path) {
            try {
                activeInput.close();
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    /** A native-read stand-in that may either obey or ignore descriptor close and interruption. */
    private static final class BlockingInputStream extends InputStream {
        private final boolean closeReleases;
        private final CountDownLatch readEntered = new CountDownLatch(1);
        private final CountDownLatch readExited = new CountDownLatch(1);
        private boolean released;

        BlockingInputStream(boolean closeReleases) {
            this.closeReleases = closeReleases;
        }

        @Override
        public int read() {
            readEntered.countDown();
            try {
                synchronized (this) {
                    while (!released) {
                        try {
                            wait();
                        } catch (InterruptedException ignored) {
                            // Model a native read that Java interruption alone cannot unblock.
                        }
                    }
                }
                return -1;
            } finally {
                readExited.countDown();
            }
        }

        @Override
        public void close() {
            if (closeReleases) {
                release();
            }
        }

        synchronized void release() {
            released = true;
            notifyAll();
        }

        boolean awaitRead() throws InterruptedException {
            return readEntered.await(1, TimeUnit.SECONDS);
        }

        boolean awaitReadExit() throws InterruptedException {
            return readExited.await(1, TimeUnit.SECONDS);
        }
    }
}
