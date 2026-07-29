package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;

import com.mentra.asg_client.AsgConstants;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

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
    public void supportedFirmware_startsSwitchWithoutPublishingReadyWindow() {
        coordinator.onSerialReady();

        BesUartTransportCoordinator.SystemVersionResult result = systemVersion("17.26.7.23");

        assertThat(result).isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        assertThat(coordinator.isReady()).isFalse();
        assertThat(host.controlCommands).anyMatch(command -> command.contains("cs_baud"));
        assertThat(coordinator.runNormalWrite(() -> true)).isFalse();
    }

    @Test
    public void rejectedFastSwitch_returnsToStableRendezvousState() {
        coordinator.onSerialReady();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);

        assertThat(
                        coordinator.onBaudResponse(
                                1, AsgConstants.UART_FAST_BAUD, coordinator.getSerialGeneration()))
                .isTrue();

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);
        assertThat(coordinator.isReady()).isTrue();
    }

    @Test
    public void acceptedFastSwitch_reopensAndRequiresASecondVersionProof() throws Exception {
        coordinator.onSerialReady();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);

        assertThat(
                        coordinator.onBaudResponse(
                                0, AsgConstants.UART_FAST_BAUD, coordinator.getSerialGeneration()))
                .isTrue();
        assertThat(coordinator.isReady()).isFalse();
        awaitState(BesUartTransportCoordinator.State.VERIFYING_FAST);
        assertThat(host.baud).isEqualTo(AsgConstants.UART_FAST_BAUD);

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.READY_FAST);
    }

    @Test
    public void duplicateVersionReply_doesNotCancelPendingBaudSwitch() {
        coordinator.onSerialReady();
        long generation = coordinator.getSerialGeneration();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);

        assertThat(coordinator.onSystemVersion("17.26.7.23", generation, null))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.IGNORED);

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        assertThat(countControlCommands("cs_baud")).isEqualTo(1);

        assertThat(coordinator.onBaudResponse(0, AsgConstants.UART_FAST_BAUD, generation)).isTrue();
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.WAITING_FAST_REOPEN);
        assertThat(coordinator.onSystemVersion("17.26.7.23", generation, null))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.IGNORED);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.WAITING_FAST_REOPEN);
    }

    @Test
    public void failedBaudRequestWrite_entersRecoveryWithoutPublishingReady() {
        host.failBaudWrites = true;
        coordinator.onSerialReady();

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);

        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);
        assertThat(coordinator.isReady()).isFalse();
    }

    @Test
    public void fileTransfer_defersFastSwitchUntilLeaseEnds() throws Exception {
        coordinator.onSerialReady();
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        assertThat(coordinator.beginFileTransfer()).isTrue();
        assertThat(host.fastReceive).isTrue();

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.READY_RENDEZVOUS);
        assertThat(host.controlCommands).noneMatch(command -> command.contains("cs_baud"));

        coordinator.endFileTransfer();

        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        assertThat(host.fastReceive).isFalse();
        assertThat(host.controlCommands).anyMatch(command -> command.contains("cs_baud"));
    }

    @Test
    public void otaAuthorization_promotesToExclusiveRawRouting() {
        coordinator.onSerialReady();
        assertThat(systemVersion("17.26.7.4"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);

        assertThat(coordinator.beginOtaAuthorization()).isTrue();
        assertThat(coordinator.beginFileTransfer()).isFalse();
        assertThat(coordinator.promoteOtaAuthorizationToTransfer()).isTrue();
        assertThat(host.otaRoute).isTrue();
        assertThat(host.fastReceive).isTrue();
        assertThat(coordinator.runNormalWrite(() -> true)).isFalse();

        byte[] packet = {1, 2, 3};
        assertThat(coordinator.writeOta(packet)).isTrue();
        assertThat(host.rawWrites).containsExactly(packet);

        coordinator.endOta();
        assertThat(host.otaRoute).isFalse();
        assertThat(host.fastReceive).isFalse();
        assertThat(coordinator.getOperation())
                .isEqualTo(BesUartTransportCoordinator.Operation.NONE);
    }

    @Test
    public void parserRecovery_waitsUntilExclusiveOperationEnds() {
        host.baud = AsgConstants.UART_FAST_BAUD;
        coordinator.onSerialReady();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.READY);
        assertThat(coordinator.beginFileTransfer()).isTrue();

        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES,
                coordinator.getSerialGeneration());
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.READY_FAST);

        coordinator.endFileTransfer();
        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES,
                coordinator.getSerialGeneration());
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);

        coordinator.onValidFrame(coordinator.getSerialGeneration());
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.READY_FAST);
    }

    @Test
    public void validFrame_provesBaudWithoutCancellingVersionDiscovery() throws Exception {
        coordinator.onSerialReady();

        coordinator.onValidFrame(coordinator.getSerialGeneration());

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
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES,
                coordinator.getSerialGeneration());
        awaitBaud(AsgConstants.UART_RENDEZVOUS_BAUD);
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);

        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        assertThat(coordinator.getState())
                .isEqualTo(BesUartTransportCoordinator.State.SWITCH_REQUESTED);
        assertThat(countControlCommands("cs_baud")).isEqualTo(2);
    }

    @Test
    public void postOtaRendezvousOpenFailure_remainsRecoverable() {
        coordinator.onSerialReady();
        host.openFailuresRemaining = 1;

        coordinator.onBesOtaApplied();

        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);
        assertThat(coordinator.getState()).isNotEqualTo(BesUartTransportCoordinator.State.CLOSED);
        assertThat(host.openAttempts).contains(AsgConstants.UART_RENDEZVOUS_BAUD);
    }

    @Test
    public void recoveryParkOpenFailure_doesNotBecomeClosed() throws Exception {
        establishFastLink();
        host.openFailuresRemaining = 2;

        coordinator.onDiscardedBytes(
                AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES,
                coordinator.getSerialGeneration());
        awaitOpenAttemptCount(AsgConstants.UART_RENDEZVOUS_BAUD, 2);

        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.RECOVERING);
        assertThat(coordinator.getState()).isNotEqualTo(BesUartTransportCoordinator.State.CLOSED);
    }

    @Test
    public void retiredReaderGeneration_cannotMutateNewSession() {
        coordinator.onSerialReady();
        long retiredGeneration = coordinator.getSerialGeneration();
        coordinator.onBesOtaApplied();
        boolean[] prepared = {false};

        BesUartTransportCoordinator.SystemVersionResult result =
                coordinator.onSystemVersion(
                        "17.26.7.23", retiredGeneration, () -> prepared[0] = true);

        assertThat(result).isEqualTo(BesUartTransportCoordinator.SystemVersionResult.IGNORED);
        assertThat(prepared[0]).isFalse();
        assertThat(coordinator.getState()).isEqualTo(BesUartTransportCoordinator.State.DISCOVERING);
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

    private void establishFastLink() throws Exception {
        coordinator.onSerialReady();
        assertThat(systemVersion("17.26.7.23"))
                .isEqualTo(BesUartTransportCoordinator.SystemVersionResult.TRANSITIONING);
        assertThat(
                        coordinator.onBaudResponse(
                                0, AsgConstants.UART_FAST_BAUD, coordinator.getSerialGeneration()))
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

    private long countOpenAttempts(int baud) {
        return host.openAttempts.stream().filter(value -> value == baud).count();
    }

    private BesUartTransportCoordinator.SystemVersionResult systemVersion(String version) {
        return coordinator.onSystemVersion(version, coordinator.getSerialGeneration(), null);
    }

    private static final class FakeHost implements BesUartTransportCoordinator.Host {
        int baud = AsgConstants.UART_RENDEZVOUS_BAUD;
        boolean open = true;
        boolean otaRoute;
        boolean fastReceive;
        boolean failBaudWrites;
        int openFailuresRemaining;
        int invalidations;
        final List<String> controlCommands = new ArrayList<>();
        final List<Integer> openAttempts = new ArrayList<>();
        final List<byte[]> rawWrites = new ArrayList<>();

        @Override
        public int currentBaud() {
            return baud;
        }

        @Override
        public boolean isSerialOpen() {
            return open;
        }

        @Override
        public boolean openAtBaud(int newBaud) {
            openAttempts.add(newBaud);
            if (openFailuresRemaining > 0) {
                openFailuresRemaining--;
                open = false;
                return false;
            }
            open = true;
            baud = newBaud;
            return true;
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
        public void setOtaReceiveRoute(boolean enabled) {
            otaRoute = enabled;
        }

        @Override
        public void setFastReceive(boolean enabled) {
            fastReceive = enabled;
        }

        @Override
        public boolean supportsFastBaud(String firmwareVersion) {
            return !"17.26.7.4".equals(firmwareVersion);
        }
    }
}
