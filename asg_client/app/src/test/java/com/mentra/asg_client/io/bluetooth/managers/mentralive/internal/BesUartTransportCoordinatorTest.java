package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import com.mentra.asg_client.AsgConstants;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesUartTransportCoordinatorTest {
    private FakeHost host;
    private BesUartTransportCoordinator coordinator;

    @Before
    public void setUp() {
        host = new FakeHost();
        coordinator = new BesUartTransportCoordinator(host);
    }

    @After
    public void tearDown() {
        coordinator.shutdown();
    }

    @Test
    public void supportedFirmware_startsSwitchWithoutPublishingReadyWindow() throws Exception {
        coordinator.onSerialReady(host.session);

        BesUartTransportCoordinator.SystemVersionResult result = systemVersion("17.26.7.23");

        assertThat(result).isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        assertThat(coordinator.isReady()).isFalse();
        awaitControlCommandCount("cs_baud", 1);
        assertThat(host.controlCommands).anyMatch(command -> command.contains("cs_baud"));
        assertThat(coordinator.runNormalWrite(() -> true)).isFalse();
    }

    @Test
    public void rejectedFastSwitch_returnsToStableRendezvousState() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        awaitControlCommandCount("cs_baud", 1);

        assertThat(
                        coordinator.onBaudResponse(
                                1, AsgConstants.UART_FAST_BAUD, coordinator.getSerialSession()))
                .isTrue();

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);
        assertThat(coordinator.isReady()).isTrue();
    }

    @Test
    public void acceptedFastSwitch_reopensAndRequiresASecondVersionProof() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        awaitControlCommandCount("cs_baud", 1);

        assertThat(
                        coordinator.onBaudResponse(
                                0, AsgConstants.UART_FAST_BAUD, coordinator.getSerialSession()))
                .isTrue();
        assertThat(coordinator.isReady()).isFalse();
        awaitState(BesUartTransportCoordinator.State.VERIFYING_FAST);
        awaitSerialSessionAtBaud(AsgConstants.UART_FAST_BAUD);

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.READY_FAST);
    }

    @Test
    public void duplicateVersionReply_doesNotCancelPendingBaudSwitch() throws Exception {
        coordinator.onSerialReady(host.session);
        SerialSession session = coordinator.getSerialSession();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        awaitControlCommandCount("cs_baud", 1);

        assertThat(coordinator.onSystemVersion("17.26.7.23", session, null))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.IGNORED);

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        assertThat(countControlCommands("cs_baud")).isEqualTo(1);

        assertThat(coordinator.onBaudResponse(0, AsgConstants.UART_FAST_BAUD, session)).isTrue();
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.WAITING_FAST_REOPEN);
        assertThat(coordinator.onSystemVersion("17.26.7.23", session, null))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.IGNORED);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.WAITING_FAST_REOPEN);
    }

    @Test
    public void failedBaudRequestWrite_entersRecoveryWithoutPublishingReady() throws Exception {
        host.failBaudWrites = true;
        coordinator.onSerialReady(host.session);

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);

        awaitState(BesUartTransportCoordinator.State.RECOVERING);
        assertThat(coordinator.isReady()).isFalse();
    }

    @Test
    public void fileTransfer_defersFastSwitchUntilLeaseEnds() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease lease = coordinator.beginFileTransfer();
        assertThat(lease).isNotNull();
        assertThat(host.fastReceive).isTrue();

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);
        assertThat(host.controlCommands).noneMatch(command -> command.contains("cs_baud"));

        coordinator.endFileTransfer(lease);

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        assertThat(host.fastReceive).isFalse();
        awaitControlCommandCount("cs_baud", 1);
        assertThat(host.controlCommands).anyMatch(command -> command.contains("cs_baud"));
    }

    @Test
    public void fileTerminalWrite_flushesDeferredNormalBeforeFastSwitch() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease lease = coordinator.beginFileTransfer();
        assertThat(lease).isNotNull();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);

        ExecutorService caller = Executors.newSingleThreadExecutor();
        Future<Boolean> normalWrite =
                caller.submit(
                        () ->
                                coordinator.runNormalWrite(
                                        () -> {
                                            host.controlCommands.add("normal_response");
                                            return true;
                                        }));

        try {
            awaitDeferredNormalWriteCount(1);
            assertThat(normalWrite.isDone()).isFalse();
            assertThat(
                            coordinator.endFileTransferWithFinalWrite(
                                    lease,
                                    () -> {
                                        assertThat(coordinator.getOperation())
                                                .isEqualTo(
                                                        BesUartTransportCoordinator.Operation
                                                                .FILE_TRANSFER);
                                        host.controlCommands.add("terminal_status");
                                        return true;
                                    }))
                    .isTrue();
            assertThat(normalWrite.get(1, TimeUnit.SECONDS)).isTrue();

            awaitControlCommandCount("cs_baud", 1);
            assertThat(host.controlCommands.indexOf("terminal_status"))
                    .isLessThan(host.controlCommands.indexOf("normal_response"));
            assertThat(host.controlCommands.indexOf("normal_response"))
                    .isLessThan(indexOfControlCommand("cs_baud"));
        } finally {
            coordinator.endFileTransfer(lease);
            caller.shutdownNow();
        }
    }

    @Test
    public void leaseRelease_drainsSiblingOutboundWritesBeforeFastSwitch() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease lease = coordinator.beginFileTransfer();
        assertThat(lease).isNotNull();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        host.deferOutboundDrains = true;

        ExecutorService caller = Executors.newSingleThreadExecutor();
        Future<Boolean> firstWrite =
                caller.submit(
                        () ->
                                coordinator.runNormalWrite(
                                        () -> {
                                            host.controlCommands.add("first_response");
                                            return true;
                                        }));

        try {
            awaitDeferredNormalWriteCount(1);
            coordinator.endFileTransfer(lease);
            assertThat(firstWrite.get(1, TimeUnit.SECONDS)).isTrue();

            assertThat(
                            coordinator.runNormalWrite(
                                    () -> {
                                        host.controlCommands.add("sibling_response");
                                        return true;
                                    }))
                    .isTrue();
            assertThat(host.controlCommands).noneMatch(command -> command.contains("cs_baud"));

            host.runNextOutboundDrain();
            awaitControlCommandCount("cs_baud", 1);
            assertThat(host.controlCommands.indexOf("first_response"))
                    .isLessThan(host.controlCommands.indexOf("sibling_response"));
            assertThat(host.controlCommands.indexOf("sibling_response"))
                    .isLessThan(indexOfControlCommand("cs_baud"));
        } finally {
            coordinator.endFileTransfer(lease);
            caller.shutdownNow();
        }
    }

    @Test
    public void serialClose_cancelsDeferredNormalWriteWithoutRunningIt() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease lease = coordinator.beginFileTransfer();
        assertThat(lease).isNotNull();

        ExecutorService caller = Executors.newSingleThreadExecutor();
        Future<Boolean> normalWrite =
                caller.submit(
                        () ->
                                coordinator.runNormalWrite(
                                        () -> {
                                            host.controlCommands.add("stale_normal_response");
                                            return true;
                                        }));

        try {
            awaitDeferredNormalWriteCount(1);
            coordinator.onSerialClosed();

            assertThat(normalWrite.get(1, TimeUnit.SECONDS)).isFalse();
            assertThat(host.controlCommands).doesNotContain("stale_normal_response");
        } finally {
            caller.shutdownNow();
        }
    }

    @Test
    public void fileTerminalWriteFailure_stillReleasesLease() {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease firstLease = coordinator.beginFileTransfer();
        assertThat(firstLease).isNotNull();

        assertThat(
                        coordinator.endFileTransferWithFinalWrite(
                                firstLease,
                                () -> {
                                    throw new IllegalStateException("write failed");
                                }))
                .isFalse();

        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.NONE);
        assertThat(host.fastReceive).isFalse();
        BesUartTransportCoordinator.OperationLease secondLease = coordinator.beginFileTransfer();
        assertThat(secondLease).isNotNull();
        assertThat(coordinator.endFileTransferWithFinalWrite(secondLease, null)).isFalse();
        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.NONE);
    }

    @Test
    public void staleFileRelease_cannotReleaseNewLease() {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease firstLease = coordinator.beginFileTransfer();
        assertThat(firstLease).isNotNull();
        assertThat(coordinator.endFileTransferWithFinalWrite(firstLease, () -> true)).isTrue();

        BesUartTransportCoordinator.OperationLease secondLease = coordinator.beginFileTransfer();
        assertThat(secondLease).isNotNull();
        coordinator.endFileTransfer(firstLease);

        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.FILE_TRANSFER);
        assertThat(coordinator.runFileWrite(firstLease, () -> true)).isFalse();
        assertThat(coordinator.runFileWrite(secondLease, () -> true)).isTrue();
        coordinator.endFileTransfer(secondLease);
    }

    @Test
    public void staleOtaReleaseAfterSerialReset_cannotReleaseNewFileLease() {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease otaLease = coordinator.beginOtaAuthorization();
        assertThat(otaLease).isNotNull();

        coordinator.onSerialClosed();
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease fileLease = coordinator.beginFileTransfer();
        assertThat(fileLease).isNotNull();

        coordinator.endOta(otaLease);

        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.FILE_TRANSFER);
        assertThat(coordinator.runFileWrite(fileLease, () -> true)).isTrue();
        coordinator.endFileTransfer(fileLease);
    }

    @Test
    public void otaAuthorization_promotesToExclusiveRawRouting() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);

        BesUartTransportCoordinator.OperationLease otaLease = coordinator.beginOtaAuthorization();
        assertThat(otaLease).isNotNull();
        assertThat(coordinator.beginFileTransfer()).isNull();
        assertThat(coordinator.runOtaAuthorizationWrite(otaLease, () -> true)).isTrue();
        assertThat(coordinator.promoteOtaAuthorizationToTransfer(otaLease)).isTrue();
        assertThat(coordinator.inboundRoute(host.session))
                .isEqualTo(BesUartTransportCoordinator.InboundRoute.OTA);
        assertThat(host.fastReceive).isTrue();

        ExecutorService caller = Executors.newSingleThreadExecutor();
        Future<Boolean> normalWrite = caller.submit(() -> coordinator.runNormalWrite(() -> true));
        try {
            awaitDeferredNormalWriteCount(1);
            assertThat(normalWrite.isDone()).isFalse();

            byte[] packet = {1, 2, 3};
            assertThat(coordinator.writeOta(otaLease, packet)).isTrue();
            assertThat(host.rawWrites).containsExactly(packet);

            coordinator.endOta(otaLease);
            assertThat(normalWrite.get(1, TimeUnit.SECONDS)).isTrue();
        } finally {
            coordinator.endOta(otaLease);
            caller.shutdownNow();
        }
        assertThat(coordinator.inboundRoute(host.session))
                .isEqualTo(BesUartTransportCoordinator.InboundRoute.NORMAL);
        assertThat(host.fastReceive).isFalse();
        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.NONE);
    }

    @Test
    public void failedAuthorizationWriteDoesNotImplicitlyReleaseTheOtaLease() {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease otaLease = coordinator.beginOtaAuthorization();
        assertThat(otaLease).isNotNull();

        assertThat(coordinator.runOtaAuthorizationWrite(otaLease, () -> false)).isFalse();

        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.OTA_AUTHORIZATION);
        assertThat(coordinator.beginFileTransfer()).isNull();
        coordinator.endOta(otaLease);
    }

    @Test
    public void otaPromotion_drainsAuthorizationWriteBeforeRawRouting() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease otaLease = coordinator.beginOtaAuthorization();
        assertThat(otaLease).isNotNull();

        ExecutorService callers = Executors.newFixedThreadPool(2);
        CountDownLatch writeStarted = new CountDownLatch(1);
        CountDownLatch releaseWrite = new CountDownLatch(1);
        Future<Boolean> write =
                callers.submit(
                        () ->
                                coordinator.runOtaAuthorizationWrite(
                                        otaLease,
                                        () -> {
                                            writeStarted.countDown();
                                            try {
                                                return releaseWrite.await(2, TimeUnit.SECONDS);
                                            } catch (InterruptedException e) {
                                                Thread.currentThread().interrupt();
                                                return false;
                                            }
                                        }));

        try {
            assertThat(writeStarted.await(1, TimeUnit.SECONDS)).isTrue();
            Future<Boolean> promotion =
                    callers.submit(() -> coordinator.promoteOtaAuthorizationToTransfer(otaLease));

            assertThat(coordinator.inboundRoute(host.session))
                    .isEqualTo(BesUartTransportCoordinator.InboundRoute.NORMAL);
            assertThat(promotion.isDone()).isFalse();

            releaseWrite.countDown();
            assertThat(write.get(1, TimeUnit.SECONDS)).isTrue();
            assertThat(promotion.get(1, TimeUnit.SECONDS)).isTrue();
            assertThat(coordinator.inboundRoute(host.session))
                    .isEqualTo(BesUartTransportCoordinator.InboundRoute.OTA);
        } finally {
            releaseWrite.countDown();
            callers.shutdownNow();
            coordinator.endOta(otaLease);
        }
    }

    @Test
    public void parserRecovery_reopensAndRejectsRetiredReader() throws Exception {
        host.baud = AsgConstants.UART_FAST_BAUD;
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        SerialSession retiredSession = coordinator.getSerialSession();
        BesUartTransportCoordinator.OperationLease lease = coordinator.beginFileTransfer();
        assertThat(lease).isNotNull();

        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES, coordinator.getSerialSession());
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.READY_FAST);

        coordinator.endFileTransfer(lease);
        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES, coordinator.getSerialSession());
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);
        awaitOpenAttemptCount(AsgConstants.UART_FAST_BAUD, 1);
        SerialSession replacementSession = coordinator.getSerialSession();
        assertThat(replacementSession).isNotSameAs(retiredSession);
        assertThat(coordinator.inboundRoute(retiredSession))
                .isEqualTo(BesUartTransportCoordinator.InboundRoute.REJECTED);
        assertThat(coordinator.inboundRoute(replacementSession))
                .isEqualTo(BesUartTransportCoordinator.InboundRoute.NORMAL);

        coordinator.onValidFrame(retiredSession);
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);

        coordinator.onValidFrame(replacementSession);
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.READY_FAST);
    }

    @Test
    public void validFrame_provesBaudWithoutCancellingVersionDiscovery() throws Exception {
        coordinator.onSerialReady(host.session);

        coordinator.onValidFrame(coordinator.getSerialSession());

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);
        awaitControlCommandCount("cs_syvr", 2);
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
    }

    @Test
    public void recoveryAtRendezvous_canNegotiateFastAgain() throws Exception {
        establishFastLink();

        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES, coordinator.getSerialSession());
        awaitBaud(AsgConstants.UART_RENDEZVOUS_BAUD);
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        awaitControlCommandCount("cs_baud", 2);
        assertThat(countControlCommands("cs_baud")).isEqualTo(2);
    }

    @Test
    public void postOtaRendezvousOpenFailure_remainsRecoverable() throws Exception {
        coordinator.onSerialReady(host.session);
        host.openFailuresRemaining = 1;

        coordinator.onBesOtaApplied();

        awaitState(BesUartTransportCoordinator.State.RECOVERING);
        assertThat(coordinator.getState()).isNotEqualTo(BesUartTransportCoordinator.State.CLOSED);
        assertThat(host.openAttempts).contains(AsgConstants.UART_RENDEZVOUS_BAUD);
    }

    @Test
    public void recoveryParkOpenFailure_doesNotBecomeClosed() throws Exception {
        establishFastLink();
        host.openFailuresRemaining = 2;

        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES, coordinator.getSerialSession());
        awaitOpenAttemptCount(AsgConstants.UART_RENDEZVOUS_BAUD, 2);

        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);
        assertThat(coordinator.getState()).isNotEqualTo(BesUartTransportCoordinator.State.CLOSED);
    }

    @Test
    public void validFrameAtParkedRendezvous_doesNotCancelVersionDiscovery() throws Exception {
        establishFastLink();
        host.controlCommands.clear();
        host.openFailuresRemaining = 2;

        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES, coordinator.getSerialSession());
        awaitOpenAttemptCount(AsgConstants.UART_RENDEZVOUS_BAUD, 2);
        coordinator.onValidFrame(coordinator.getSerialSession());

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);
        awaitControlCommandCount("cs_syvr", AsgConstants.UART_RUNTIME_RECOVERY_PROBES_PER_BAUD);
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        awaitControlCommandCount("cs_baud", 1);
    }

    @Test
    public void retiredSession_cannotMutateNewSession() {
        coordinator.onSerialReady(host.session);
        SerialSession retiredSession = coordinator.getSerialSession();
        coordinator.onBesOtaApplied();
        boolean[] prepared = {false};

        BesUartTransportCoordinator.SystemVersionResult result =
                coordinator.onSystemVersion("17.26.7.23", retiredSession, () -> prepared[0] = true);

        assertThat(result).isEqualTo(BesUartTransportCoordinator.SystemVersionResult.IGNORED);
        assertThat(prepared[0]).isFalse();
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.DISCOVERING);
    }

    @Test
    public void longNormalWrite_allowsReceiveAndOrdersBaudCommandAfterWrite() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);

        ExecutorService callers = Executors.newFixedThreadPool(2);
        CountDownLatch writeStarted = new CountDownLatch(1);
        CountDownLatch releaseWrite = new CountDownLatch(1);
        Future<Boolean> write =
                callers.submit(
                        () ->
                                coordinator.runNormalWrite(
                                        () -> {
                                            writeStarted.countDown();
                                            try {
                                                return releaseWrite.await(2, TimeUnit.SECONDS);
                                            } catch (InterruptedException e) {
                                                Thread.currentThread().interrupt();
                                                return false;
                                            }
                                        }));

        try {
            assertThat(writeStarted.await(1, TimeUnit.SECONDS)).isTrue();
            Future<BesUartTransportCoordinator.SystemVersionResult> version =
                    callers.submit(() -> systemVersion("17.26.7.23"));

            assertThat(version.get(1, TimeUnit.SECONDS))
                    .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
            assertThat(coordinator.getState())
                    .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
            assertThat(countControlCommands("cs_baud")).isZero();

            releaseWrite.countDown();
            assertThat(write.get(1, TimeUnit.SECONDS)).isTrue();
            awaitControlCommandCount("cs_baud", 1);
        } finally {
            releaseWrite.countDown();
            callers.shutdownNow();
        }
    }

    @Test
    public void versionProbes_pauseForFileTransferAndResumeAfterLease() throws Exception {
        coordinator.onSerialReady(host.session);
        coordinator.onValidFrame(coordinator.getSerialSession());
        BesUartTransportCoordinator.OperationLease lease = coordinator.beginFileTransfer();
        assertThat(lease).isNotNull();
        host.controlCommands.clear();

        Thread.sleep(1_000);

        assertThat(countControlCommands("cs_syvr")).isZero();
        coordinator.endFileTransfer(lease);
        awaitControlCommandCount("cs_syvr", 1);
    }

    @Test
    public void serialClose_beforeFileCleanup_doesNotResumeDeferredBaudSwitch() {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        BesUartTransportCoordinator.OperationLease lease = coordinator.beginFileTransfer();
        assertThat(lease).isNotNull();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);

        coordinator.onSerialClosed();
        coordinator.endFileTransfer(lease);

        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.CLOSED);
        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.NONE);
        assertThat(host.fastReceive).isFalse();
        assertThat(countControlCommands("cs_baud")).isZero();
    }

    @Test
    public void recoveryRetry_usesCappedExponentialBackoff() {
        assertThat(BesUartTransportCoordinator.recoveryRetryDelayMs(0)).isEqualTo(3_000);
        assertThat(BesUartTransportCoordinator.recoveryRetryDelayMs(1)).isEqualTo(6_000);
        assertThat(BesUartTransportCoordinator.recoveryRetryDelayMs(2)).isEqualTo(12_000);
        assertThat(BesUartTransportCoordinator.recoveryRetryDelayMs(4)).isEqualTo(48_000);
        assertThat(BesUartTransportCoordinator.recoveryRetryDelayMs(5)).isEqualTo(60_000);
        assertThat(BesUartTransportCoordinator.recoveryRetryDelayMs(30)).isEqualTo(60_000);
    }

    private void awaitState(BesUartTransportCoordinator.State expected) throws Exception {
        long deadline = System.currentTimeMillis() + 1_000;
        while (System.currentTimeMillis() < deadline && coordinator.getState() != expected) {
            Thread.sleep(10);
        }
        assertThat(coordinator.getState()).isEqualTo(expected);
    }

    private void awaitDeferredNormalWriteCount(int expected) throws Exception {
        long deadline = System.currentTimeMillis() + 1_000;
        while (System.currentTimeMillis() < deadline
                && coordinator.getDeferredNormalWriteCount() < expected) {
            Thread.sleep(10);
        }
        assertThat(coordinator.getDeferredNormalWriteCount()).isGreaterThanOrEqualTo(expected);
    }

    private void awaitSerialSessionAtBaud(int expected) throws Exception {
        long deadline = System.currentTimeMillis() + 2_000;
        SerialSession session = coordinator.getSerialSession();
        while (System.currentTimeMillis() < deadline
                && (session == null || session.getBaud() != expected || !session.isActive())) {
            Thread.sleep(10);
            session = coordinator.getSerialSession();
        }
        assertThat(session).isNotNull();
        assertThat(session.getBaud()).isEqualTo(expected);
        assertThat(session.isActive()).isTrue();
    }

    private void establishFastLink() throws Exception {
        coordinator.onSerialReady(host.session);
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        awaitControlCommandCount("cs_baud", 1);
        assertThat(
                        coordinator.onBaudResponse(
                                0, AsgConstants.UART_FAST_BAUD, coordinator.getSerialSession()))
                .isTrue();
        awaitState(BesUartTransportCoordinator.State.VERIFYING_FAST);
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
    }

    private void awaitBaud(int expected) throws Exception {
        long deadline = System.currentTimeMillis() + 2_000;
        while (System.currentTimeMillis() < deadline && host.baud != expected) {
            Thread.sleep(10);
        }
        assertThat(host.baud).isEqualTo(expected);
    }

    private void awaitControlCommandCount(String command, int expected) throws Exception {
        long deadline = System.currentTimeMillis() + 1_000;
        while (System.currentTimeMillis() < deadline && countControlCommands(command) < expected) {
            Thread.sleep(10);
        }
        assertThat(countControlCommands(command)).isGreaterThanOrEqualTo(expected);
    }

    private void awaitOpenAttemptCount(int baud, int expected) throws Exception {
        long deadline = System.currentTimeMillis() + 2_000;
        while (System.currentTimeMillis() < deadline && countOpenAttempts(baud) < expected) {
            Thread.sleep(10);
        }
        assertThat(countOpenAttempts(baud)).isGreaterThanOrEqualTo(expected);
    }

    private long countControlCommands(String command) {
        return host.controlCommands.stream().filter(value -> value.contains(command)).count();
    }

    private int indexOfControlCommand(String command) {
        for (int i = 0; i < host.controlCommands.size(); i++) {
            if (host.controlCommands.get(i).contains(command)) {
                return i;
            }
        }
        return -1;
    }

    private long countOpenAttempts(int baud) {
        return host.openAttempts.stream().filter(value -> value == baud).count();
    }

    private BesUartTransportCoordinator.SystemVersionResult systemVersion(String version) {
        return coordinator.onSystemVersion(version, coordinator.getSerialSession(), null);
    }

    private static final class FakeHost implements BesUartTransportCoordinator.Host {
        volatile int baud = AsgConstants.UART_RENDEZVOUS_BAUD;
        volatile boolean open = true;
        volatile boolean fastReceive;
        volatile boolean failBaudWrites;
        volatile int openFailuresRemaining;
        volatile int invalidations;
        volatile boolean deferOutboundDrains;
        volatile long nextSessionId = 1;
        volatile SerialSession session = new SerialSession(1, "/dev/ttyS1", baud);
        final List<String> controlCommands = new CopyOnWriteArrayList<>();
        final List<Integer> openAttempts = new CopyOnWriteArrayList<>();
        final List<byte[]> rawWrites = new CopyOnWriteArrayList<>();
        final Queue<Runnable> outboundDrains = new ConcurrentLinkedQueue<>();

        @Override
        public int currentBaud() {
            return baud;
        }

        @Override
        public boolean isSerialOpen() {
            return open;
        }

        @Override
        public SerialSession openAtBaud(int newBaud) {
            openAttempts.add(newBaud);
            if (openFailuresRemaining > 0) {
                openFailuresRemaining--;
                open = false;
                return null;
            }
            open = true;
            baud = newBaud;
            session = new SerialSession(++nextSessionId, "/dev/ttyS1", baud);
            return session;
        }

        @Override
        public boolean startReader(SerialSession openedSession) {
            return openedSession == session;
        }

        @Override
        public void closeSession(SerialSession openedSession) {
            openedSession.retire();
            if (openedSession == session) {
                open = false;
            }
        }

        @Override
        public void invalidateLinkProof() {
            invalidations++;
        }

        @Override
        public void resetParser() {}

        @Override
        public boolean writeControlCommand(byte[] json) {
            String command = new String(json, StandardCharsets.UTF_8);
            controlCommands.add(command);
            return !failBaudWrites || !command.contains("cs_baud");
        }

        @Override
        public boolean writeRawBytes(byte[] data) {
            rawWrites.add(data);
            return true;
        }

        @Override
        public void setFastReceive(boolean enabled) {
            fastReceive = enabled;
        }

        @Override
        public boolean supportsFastBaud(String firmwareVersion) {
            return !"17.26.7.4".equals(firmwareVersion);
        }

        @Override
        public boolean queueAfterOutboundWrites(Runnable action) {
            if (deferOutboundDrains) {
                outboundDrains.add(action);
            } else {
                action.run();
            }
            return true;
        }

        void runNextOutboundDrain() {
            outboundDrains.remove().run();
        }
    }
}
