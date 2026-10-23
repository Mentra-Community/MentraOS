package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

import android.app.Application;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialSession;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.robolectric.Shadows.shadowOf;

/**
 * The BES applied and rebooted but the MTK did not reset, so the apply wait expired in the
 * authorization boot. A later BES frame must reopen the UART and an exact target-version reply must
 * reconcile the durable record to success.
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaApplyRebootTimeoutRecoveryTest {
    private static final String OWNER = "session-a";
    private static final String BOOT = "boot-a";
    private static final String OLD_VERSION = "26.7.30.3";
    private static final String TARGET = "26.7.30.4";
    private static final String ARTIFACT = "bes-26.7.30.4-update_ota.bin";
    private static final String SHA =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private final RecordingHost host = new RecordingHost();
    private BesOtaStateStore store;
    private K900BluetoothManager k900;
    private BesUartTransportCoordinator coordinator;

    @Before
    public void setUp() throws Exception {
        store = new BesOtaStateStore(new MemoryStorage(), () -> BOOT);
        k900 = mock(K900BluetoothManager.class, CALLS_REAL_METHODS);
        setField(k900, "besOtaStateStore", store);
        setField(k900, "currentBootId", BOOT);
        setField(k900, "liveBesOtaOwner", "");
        setField(k900, "linkState", new LinkStateMachine());
        Method invalidateProof =
                K900BluetoothManager.class.getDeclaredMethod("invalidateFramedPathProof");
        invalidateProof.setAccessible(true);
        host.onInvalidateLinkProof =
                () -> {
                    try {
                        invalidateProof.invoke(k900);
                    } catch (ReflectiveOperationException e) {
                        throw new IllegalStateException(e);
                    }
                };
        Method projectPolicy =
                K900BluetoothManager.class.getDeclaredMethod("currentBesOtaSafetyPolicy");
        projectPolicy.setAccessible(true);
        coordinator =
                new BesUartTransportCoordinator(
                        host,
                        () -> {
                            try {
                                return (BesUartTransportCoordinator.SafetyPolicy)
                                        projectPolicy.invoke(k900);
                            } catch (ReflectiveOperationException e) {
                                throw new IllegalStateException(e);
                            }
                        });
        setField(k900, "transportCoordinator", coordinator);
    }

    @After
    public void tearDown() {
        coordinator.shutdown();
    }

    @Test
    public void besFrameAfterApplyRebootTimeoutReleasesUartAndTargetProofSucceeds()
            throws Exception {
        SerialSession applySession = host.open(AsgConstants.UART_RENDEZVOUS_BAUD);
        coordinator.onSerialReady(applySession);
        srSyvr(OLD_VERSION, applySession);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);

        assertThat(store.reserveAuthorization(OWNER, BOOT, TARGET, ARTIFACT, SHA))
                .isEqualTo(BesOtaStateStore.TransitionResult.APPLIED);
        assertThat(store.markApplyPending(OWNER))
                .isEqualTo(BesOtaStateStore.TransitionResult.APPLIED);
        new BesOtaManager(k900::onBesOtaApplied, k900, ApplicationProvider.getApplicationContext());
        k900.onBesOtaApplied();
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.QUARANTINED);

        shadowOf(Looper.getMainLooper()).idleFor(61, TimeUnit.SECONDS);

        BesOtaStateStore.Snapshot timedOut = store.read();
        assertThat(timedOut.getState()).isEqualTo(BesOtaStateStore.State.TERMINAL);
        assertThat(timedOut.getTerminalStatus())
                .isEqualTo(BesOtaStateStore.TerminalStatus.FAILURE);
        assertThat(timedOut.getTerminalCode()).isEqualTo("apply_reboot_timeout");
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.QUARANTINED);
        assertThat(host.openedBauds).hasSize(1);
        host.controlCommands.clear();

        byte[] frame = "##sr_hrt".getBytes(StandardCharsets.UTF_8);
        k900.onSerialRead("/dev/ttyS1", frame, frame.length, applySession);

        SerialSession probeSession = awaitFramedProbeSession(applySession);
        srSyvr(TARGET, probeSession);

        BesOtaStateStore.Snapshot reconciled = store.read();
        assertThat(reconciled.getTerminalStatus())
                .isEqualTo(BesOtaStateStore.TerminalStatus.SUCCESS);
        assertThat(reconciled.getTerminalCode()).isEqualTo("verified");
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);
        assertThat(coordinator.isReadyForNormalUse()).isTrue();
    }

    private SerialSession awaitFramedProbeSession(SerialSession retired) throws Exception {
        long deadline = System.currentTimeMillis() + 8_000;
        while (System.currentTimeMillis() < deadline && host.countControl("cs_syvr") < 1) {
            Thread.sleep(10);
        }
        assertThat(host.openedBauds)
                .containsExactly(
                        AsgConstants.UART_RENDEZVOUS_BAUD, AsgConstants.UART_RENDEZVOUS_BAUD);
        assertThat(host.rawWrites).hasSize(3);
        assertThat(host.countControl("cs_syvr")).isEqualTo(1);
        SerialSession current = coordinator.getSerialSession();
        assertThat(current).isNotNull().isNotSameAs(retired);
        return current;
    }

    private void srSyvr(String version, SerialSession session) throws Exception {
        Method handle =
                K900BluetoothManager.class.getDeclaredMethod(
                        "handleSrSyvrResponse", byte[].class, SerialSession.class);
        handle.setAccessible(true);
        handle.invoke(
                k900,
                ("{\"C\":\"sr_syvr\",\"B\":{\"version\":\"" + version + "\"}}")
                        .getBytes(StandardCharsets.UTF_8),
                session);
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field field = K900BluetoothManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static final class MemoryStorage implements BesOtaStateStore.Storage {
        private String raw;

        @Override
        public String get() {
            return raw;
        }

        @Override
        public boolean put(String value) {
            raw = value;
            return true;
        }

        @Override
        public boolean remove() {
            raw = null;
            return true;
        }
    }

    private static final class RecordingHost implements BesUartTransportCoordinator.Host {
        final List<Integer> openedBauds = new CopyOnWriteArrayList<>();
        final List<String> controlCommands = new CopyOnWriteArrayList<>();
        final List<byte[]> rawWrites = new CopyOnWriteArrayList<>();
        volatile Runnable onInvalidateLinkProof = () -> {};
        private volatile SerialSession current;
        private volatile int baud = AsgConstants.UART_RENDEZVOUS_BAUD;
        private long nextId = 1;

        SerialSession open(int newBaud) {
            try {
                Constructor<SerialSession> constructor =
                        SerialSession.class.getDeclaredConstructor(
                                long.class, String.class, int.class);
                constructor.setAccessible(true);
                openedBauds.add(newBaud);
                baud = newBaud;
                current = constructor.newInstance(nextId++, "/dev/ttyS1", newBaud);
                return current;
            } catch (ReflectiveOperationException e) {
                throw new IllegalStateException(e);
            }
        }

        long countControl(String command) {
            return controlCommands.stream().filter(value -> value.contains(command)).count();
        }

        @Override
        public int currentBaud() {
            return baud;
        }

        @Override
        public boolean isSerialOpen() {
            return current != null;
        }

        @Override
        public SerialSession openAtBaud(int newBaud) {
            return open(newBaud);
        }

        @Override
        public boolean startReader(SerialSession session) {
            return session == current;
        }

        @Override
        public void closeSession(SerialSession session) {}

        @Override
        public void invalidateLinkProof() {
            onInvalidateLinkProof.run();
        }

        @Override
        public void resetParser() {}

        @Override
        public boolean writeControlCommand(byte[] json) {
            controlCommands.add(new String(json, StandardCharsets.UTF_8));
            return true;
        }

        @Override
        public boolean writeRawBytes(byte[] data) {
            rawWrites.add(data);
            return true;
        }

        @Override
        public void setFastReceive(boolean enabled) {}

        @Override
        public boolean supportsFastBaud(String firmwareVersion) {
            return false;
        }

        @Override
        public boolean queueAfterOutboundWrites(Runnable action) {
            action.run();
            return true;
        }
    }
}
