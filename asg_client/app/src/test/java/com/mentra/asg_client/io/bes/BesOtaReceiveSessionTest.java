package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator.ValidatedBesArtifact;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Regressions for stale recovery bytes crossing into a newly admitted raw OTA session. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaReceiveSessionTest {
    private BesOtaManager manager;
    private BesUartTransportCoordinator coordinator;
    private BesUartTransportCoordinator.OperationLease lease;
    private final List<byte[]> writes = new ArrayList<>();
    private final List<String> writeOwners = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        BesOtaManager.isBesOtaInProgress = false;
        coordinator = mock(BesUartTransportCoordinator.class);
        lease = mock(BesUartTransportCoordinator.OperationLease.class);
        K900BluetoothManager bluetooth = mock(K900BluetoothManager.class);
        when(bluetooth.getTransportCoordinator()).thenReturn(coordinator);
        manager =
                spy(
                        new BesOtaManager(
                                null, bluetooth, ApplicationProvider.getApplicationContext()));
        when(coordinator.promoteOtaAuthorizationToTransfer(lease)).thenReturn(true);
        when(coordinator.writeOta(eq(lease), any(byte[].class)))
                .thenAnswer(
                        invocation -> {
                            writes.add(((byte[]) invocation.getArgument(1)).clone());
                            writeOwners.add((String) field("activeOwnerSessionId"));
                            return true;
                        });
        prepareAuthorization("owner-a");
    }

    @After
    public void tearDown() throws Exception {
        invokeLocked("cleanup");
        BesOtaManager.isBesOtaInProgress = false;
    }

    @Test
    public void acknowledgedAdmissionDiscardsObservedFramedPrefixBeforeFirstQuery()
            throws Exception {
        poisonWithObservedRecoveryFrame();

        manager.onAuthorizationGranted();

        assertThat(buffered()).isZero();
        assertThat(writes).hasSize(1);
        assertThat(writes.get(0))
                .containsExactly((byte) 0x99, (byte) 0, (byte) 0, (byte) 0, (byte) 0);
        receiveVersion();
        assertVersionAdvancedOnce();
    }

    @Test
    public void missingAckAdmissionDiscardsTheSameObservedPrefix() throws Exception {
        poisonWithObservedRecoveryFrame();

        invokeLocked("beginAuthorizationRecoveryProbeLocked");

        assertThat(buffered()).isZero();
        receiveVersion();
        assertVersionAdvancedOnce();
    }

    @Test
    public void rejectedPromotionLeavesExistingParserSessionUntouched() throws Exception {
        poisonWithObservedRecoveryFrame();
        when(coordinator.promoteOtaAuthorizationToTransfer(lease)).thenReturn(false);

        manager.onAuthorizationGranted();

        assertThat(buffered()).isEqualTo(225);
        assertThat(writes).isEmpty();
    }

    @Test
    public void duplicateAuthorizationAndCompetingOwnerPreserveCurrentFragments() throws Exception {
        manager.onAuthorizationGranted();
        receivePart(0, 3);

        manager.onAuthorizationGranted();
        assertThat(manager.startFirmwareUpdate(mock(ValidatedBesArtifact.class), "owner-b"))
                .isFalse();

        assertThat(field("activeOwnerSessionId")).isEqualTo("owner-a");
        assertThat(buffered()).isEqualTo(3);
        verify(coordinator, times(1)).promoteOtaAuthorizationToTransfer(lease);
        receivePart(3, 9);
        assertVersionAdvancedOnce();
    }

    @Test
    public void eachSameSessionFragmentBoundaryStillDecodesExactlyOnce() throws Exception {
        for (int split = 1; split < 9; split++) {
            prepareAuthorization("owner-" + split);
            manager.onAuthorizationGranted();
            writes.clear();

            receivePart(0, split);
            assertThat(writes).isEmpty();
            assertThat(buffered()).isEqualTo(split);
            receivePart(split, 9);

            assertThat(writes).hasSize(1);
            assertThat(writes.get(0)).isEqualTo(manager.SCmd_SetUser());
            assertThat(buffered()).isZero();
            invokeLocked("cleanup");
        }
    }

    @Test
    public void scheduledReadOnlyProbeDoesNotResetAPartialResponse() throws Exception {
        manager.onAuthorizationGranted();
        receivePart(0, 3);

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));

        assertThat(writes).hasSize(2);
        assertThat(buffered()).isEqualTo(3);
        receivePart(3, 9);
        assertThat(writes).hasSize(3);
        assertThat(writes.get(2)).isEqualTo(manager.SCmd_SetUser());
        assertThat(field("authorizationRecoveryProbePending")).isEqualTo(false);
    }

    @Test
    public void decodedOldResponseDispatchesBeforeCleanupAndNewAdmission() throws Exception {
        manager.onAuthorizationGranted();
        CountDownLatch decoded = new CountDownLatch(1);
        CountDownLatch releaseReceive = new CountDownLatch(1);
        CountDownLatch replacing = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        doAnswer(
                        invocation -> {
                            Object message = invocation.callRealMethod();
                            decoded.countDown();
                            assertThat(releaseReceive.await(5, TimeUnit.SECONDS)).isTrue();
                            return message;
                        })
                .when(manager)
                .parseRecv(any(byte[].class), anyInt(), anyInt());
        Thread receive = new Thread(() -> runChecked(failure, this::receiveVersion));
        Thread replace =
                new Thread(
                        () ->
                                runChecked(
                                        failure,
                                        () -> {
                                            replacing.countDown();
                                            invokeLocked("cleanup");
                                            prepareAuthorization("owner-b");
                                            manager.onAuthorizationGranted();
                                        }));
        try {
            receive.start();
            assertThat(decoded.await(5, TimeUnit.SECONDS)).isTrue();
            replace.start();
            assertThat(replacing.await(5, TimeUnit.SECONDS)).isTrue();
            awaitBlocked(replace);
            assertThat(field("activeOwnerSessionId")).isEqualTo("owner-a");
        } finally {
            releaseReceive.countDown();
            receive.join(5000);
            replace.join(5000);
        }
        assertThat(receive.isAlive()).isFalse();
        assertThat(replace.isAlive()).isFalse();
        assertThat(failure.get()).isNull();
        assertThat(writes).hasSize(3);
        assertThat(writes.get(1)).isEqualTo(manager.SCmd_SetUser());
        assertThat(writeOwners).containsExactly("owner-a", "owner-a", "owner-b");
        assertThat(buffered()).isZero();
    }

    private void poisonWithObservedRecoveryFrame() throws Exception {
        // Hardware failure: 225 retained bytes began 23 23 30 00 2e. The parser treats
        // that framed prefix as a raw header with declared length 771764259.
        byte[] stale = new byte[225];
        System.arraycopy(new byte[] {0x23, 0x23, 0x30, 0, 0x2e}, 0, stale, 0, 5);
        manager.onOtaRecv(stale, stale.length);
        assertThat(buffered()).isEqualTo(225);
    }

    private void prepareAuthorization(String owner) throws Exception {
        setField("activeOwnerSessionId", owner);
        setField("transportLease", lease);
        setField("isWaitingForAuthorization", true);
        setField("bInit", true);
        BesOtaManager.isBesOtaInProgress = true;
    }

    private void receiveVersion() {
        receivePart(0, 9);
    }

    private void receivePart(int from, int to) {
        byte[] reply = {(byte) 0x9a, 4, 0, 0, 0, 0, 0, 0, 0};
        byte[] part = Arrays.copyOfRange(reply, from, to);
        manager.onOtaRecv(part, part.length);
    }

    private void assertVersionAdvancedOnce() throws Exception {
        assertThat(writes).hasSize(2);
        assertThat(writes.get(1)).isEqualTo(manager.SCmd_SetUser());
        assertThat(buffered()).isZero();
        assertThat(field("authorizationRecoveryProbePending")).isEqualTo(false);
    }

    private int buffered() throws Exception {
        return (int) field("curRecvLen");
    }

    private Object field(String name) throws Exception {
        Field field = BesOtaManager.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(manager);
    }

    private void setField(String name, Object value) throws Exception {
        Field field = BesOtaManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(manager, value);
    }

    private void invokeLocked(String name) throws Exception {
        synchronized (field("mTransferGate")) {
            Method method = BesOtaManager.class.getDeclaredMethod(name);
            method.setAccessible(true);
            method.invoke(manager);
        }
    }

    private static void awaitBlocked(Thread thread) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (thread.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) {
            Thread.yield();
        }
        assertThat(thread.getState()).isEqualTo(Thread.State.BLOCKED);
    }

    private static void runChecked(AtomicReference<Throwable> failure, CheckedRunnable action) {
        try {
            action.run();
        } catch (Throwable error) {
            failure.compareAndSet(null, error);
        }
    }

    private interface CheckedRunnable {
        void run() throws Exception;
    }
}
