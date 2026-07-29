package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;

import com.mentra.asg_client.AsgConstants;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Single policy owner for the ASG-to-BES UART.
 *
 * <p>The coordinator serializes writes, baud changes, parser resets, discovery, recovery,
 * file-transfer ownership, and BES OTA ownership behind one monitor. Timers only enqueue events on
 * the coordinator executor; they never mutate transport state independently.
 */
public final class BesUartTransportCoordinator {
    private static final String TAG = "BES-UART";

    /** Stable and transitional states of the physical ASG-to-BES UART. */
    public enum State {
        CLOSED,
        DISCOVERING,
        READY_RENDEZVOUS,
        SWITCH_REQUESTED,
        WAITING_FAST_REOPEN,
        VERIFYING_FAST,
        READY_FAST,
        RECOVERING
    }

    /** Long-lived operation currently preventing transport reconfiguration. */
    public enum Operation {
        NONE,
        FILE_TRANSFER,
        OTA_AUTHORIZATION,
        OTA_TRANSFER
    }

    /** Outcome of consuming a generation-matched BES system-version reply. */
    public enum SystemVersionResult {
        IGNORED,
        READY,
        TRANSITIONING
    }

    /** A write performed while the coordinator holds the transport monitor. */
    @FunctionalInterface
    public interface WriteAction {
        boolean write();
    }

    /** Hardware/protocol hooks implemented by {@code K900BluetoothManager}. */
    public interface Host {
        int currentBaud();

        boolean isSerialOpen();

        /**
         * Replace the physical serial port at exactly {@code baud}, even if it is currently closed.
         */
        boolean openAtBaud(int baud);

        /** Invalidate the current link proof before a transition can be observed by consumers. */
        void invalidateLinkProof();

        /** Clear partial receive framing without reopening the port. */
        void resetParser();

        /** Write one coordinator-owned K900 control command synchronously. */
        boolean writeControlCommand(byte[] json);

        /** Write raw BES protocol bytes synchronously. */
        boolean writeRawBytes(byte[] data);

        /** Route receive bytes to the raw BES OTA parser instead of the normal K900 parser. */
        void setOtaReceiveRoute(boolean enabled);

        /** Adjust receive polling for high-throughput file or OTA traffic. */
        void setFastReceive(boolean enabled);

        /** Whether this firmware version implements the negotiated fast-baud contract. */
        boolean supportsFastBaud(String firmwareVersion);
    }

    private static final int[] RECOVERY_BAUDS = {
        AsgConstants.UART_FAST_BAUD, AsgConstants.UART_RENDEZVOUS_BAUD
    };

    private final Object monitor = new Object();
    private final Host host;
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();

    private State state = State.CLOSED;
    private Operation operation = Operation.NONE;
    private long serialGeneration = 0;
    private long phaseGeneration = 0;
    private long versionGeneration = -1;
    private long fastSwitchAttemptGeneration = -1;
    private int recoveryIndex = 0;
    private int recoveryRetryAttempt = 0;
    private String firmwareVersion = "";
    private long discardedBytes = 0;
    private int discardEvents = 0;

    private ScheduledFuture<?> phaseTimeout;
    private ScheduledFuture<?> healthTimeout;

    public BesUartTransportCoordinator(Host host) {
        if (host == null) {
            throw new IllegalArgumentException("host is required");
        }
        this.host = host;
    }

    public State getState() {
        synchronized (monitor) {
            return state;
        }
    }

    public Operation getOperation() {
        synchronized (monitor) {
            return operation;
        }
    }

    public boolean isReady() {
        synchronized (monitor) {
            return isReadyLocked();
        }
    }

    /** Generation captured by receive callbacks so retired serial readers cannot mutate state. */
    public long getSerialGeneration() {
        synchronized (monitor) {
            return serialGeneration;
        }
    }

    public boolean isCurrentSerialGeneration(long generation) {
        synchronized (monitor) {
            return generation == serialGeneration;
        }
    }

    /** Run a receive-side mutation atomically only for the current serial reader. */
    public boolean runForCurrentSerialGeneration(long generation, Runnable action) {
        synchronized (monitor) {
            if (generation != serialGeneration || action == null) {
                return false;
            }
            action.run();
            return true;
        }
    }

    /** Start discovery at the rendezvous baud when the serial driver opens. */
    public void onSerialReady() {
        synchronized (monitor) {
            cancelAllTimersLocked();
            operation = Operation.NONE;
            host.setOtaReceiveRoute(false);
            host.setFastReceive(false);
            state = State.DISCOVERING;
            versionGeneration = -1;
            fastSwitchAttemptGeneration = -1;
            firmwareVersion = "";
            discardedBytes = 0;
            discardEvents = 0;
            serialGeneration++;
            long phase = ++phaseGeneration;
            Log.i(TAG, "Serial ready; discovering BES at rendezvous baud");
            scheduleProbeBurstLocked(
                    phase,
                    AsgConstants.UART_RENDEZVOUS_BAUD,
                    0,
                    AsgConstants.UART_RECOVERY_PROBES_PER_BURST,
                    AsgConstants.UART_RECOVERY_PROBE_SPACING_MS);
            phaseTimeout =
                    executor.schedule(
                            () -> startRecoveryIfCurrent(phase, "startup_discovery_timeout"),
                            AsgConstants.UART_BOOT_RECOVERY_INITIAL_DELAY_MS,
                            TimeUnit.MILLISECONDS);
        }
    }

    public void onSerialClosed() {
        synchronized (monitor) {
            cancelAllTimersLocked();
            phaseGeneration++;
            serialGeneration++;
            versionGeneration = -1;
            fastSwitchAttemptGeneration = -1;
            firmwareVersion = "";
            state = State.CLOSED;
            operation = Operation.NONE;
            host.setOtaReceiveRoute(false);
            host.setFastReceive(false);
            Log.i(TAG, "Serial closed");
        }
    }

    /**
     * Consume an {@code sr_syvr}. The preparation callback runs only for the current serial
     * generation and before any resulting baud transition. A reply that starts a baud switch never
     * creates a transient ready edge.
     */
    public SystemVersionResult onSystemVersion(
            String version, long receiveGeneration, Runnable beforeTransition) {
        synchronized (monitor) {
            if (receiveGeneration != serialGeneration
                    || state == State.CLOSED
                    || state == State.SWITCH_REQUESTED
                    || state == State.WAITING_FAST_REOPEN
                    || !host.isSerialOpen()) {
                return SystemVersionResult.IGNORED;
            }
            if (beforeTransition != null) {
                beforeTransition.run();
            }
            firmwareVersion = version == null ? "" : version.trim();
            versionGeneration = serialGeneration;
            discardedBytes = 0;
            discardEvents = 0;
            cancelPhaseTimeoutLocked();
            phaseGeneration++;
            recoveryRetryAttempt = 0;

            int baud = host.currentBaud();
            if (baud == AsgConstants.UART_FAST_BAUD) {
                state = State.READY_FAST;
                scheduleHealthCheckLocked();
                Log.i(TAG, "UART link ready at fast baud " + baud);
                return SystemVersionResult.READY;
            }

            state = State.READY_RENDEZVOUS;
            if (baud != AsgConstants.UART_RENDEZVOUS_BAUD) {
                Log.w(TAG, "Unexpected proven baud " + baud + "; treating as rendezvous-ready");
            }

            advanceLocked();
            if (isReadyLocked()) {
                Log.i(TAG, "UART link ready at rendezvous baud " + baud);
                return SystemVersionResult.READY;
            }
            return SystemVersionResult.TRANSITIONING;
        }
    }

    /** Consume the old-baud acknowledgement for a pending {@code cs_baud}. */
    public boolean onBaudResponse(int status, int acknowledgedBaud, long receiveGeneration) {
        synchronized (monitor) {
            if (receiveGeneration != serialGeneration || state != State.SWITCH_REQUESTED) {
                Log.w(TAG, "Ignoring sr_baud while state=" + state);
                return false;
            }
            cancelPhaseTimeoutLocked();
            if (status != 0 || acknowledgedBaud != AsgConstants.UART_FAST_BAUD) {
                state = State.READY_RENDEZVOUS;
                Log.w(
                        TAG,
                        "Fast-baud request rejected status="
                                + status
                                + " baud="
                                + acknowledgedBaud);
                return true;
            }

            state = State.WAITING_FAST_REOPEN;
            host.invalidateLinkProof();
            long phase = ++phaseGeneration;
            phaseTimeout =
                    executor.schedule(
                            () -> reopenFastAndVerifyIfCurrent(phase, "sr_baud"),
                            AsgConstants.UART_BAUD_REOPEN_DELAY_MS,
                            TimeUnit.MILLISECONDS);
            Log.i(TAG, "Fast-baud request accepted; waiting to reopen ASG UART");
            return true;
        }
    }

    /** Reset health accounting and accept a structurally valid frame as current-baud proof. */
    public void onValidFrame(long receiveGeneration) {
        synchronized (monitor) {
            if (receiveGeneration != serialGeneration) {
                return;
            }
            discardedBytes = 0;
            discardEvents = 0;
            if (state == State.DISCOVERING
                    || state == State.VERIFYING_FAST
                    || state == State.RECOVERING) {
                cancelPhaseTimeoutLocked();
                if (host.currentBaud() == AsgConstants.UART_FAST_BAUD) {
                    state = State.READY_FAST;
                    scheduleHealthCheckLocked();
                } else {
                    state = State.READY_RENDEZVOUS;
                }
                recoveryRetryAttempt = 0;
                Log.i(TAG, "Structurally valid frame proved UART link at " + host.currentBaud());
                return;
            }
            if (state == State.READY_FAST) {
                scheduleHealthCheckLocked();
            }
        }
    }

    /** Trigger recovery after repeated wrong-baud-looking parser discards. */
    public void onDiscardedBytes(long count, long receiveGeneration) {
        synchronized (monitor) {
            if (receiveGeneration != serialGeneration || count <= 0 || state != State.READY_FAST) {
                return;
            }
            discardedBytes += count;
            discardEvents++;
            if (operation != Operation.NONE
                    || (discardedBytes < AsgConstants.UART_RUNTIME_RECOVERY_DISCARDED_BYTES
                            && discardEvents < AsgConstants.UART_RUNTIME_RECOVERY_DISCARD_EVENTS)) {
                return;
            }
            startRecoveryLocked("parser_discards");
        }
    }

    public boolean runNormalWrite(WriteAction action) {
        synchronized (monitor) {
            if (!isReadyLocked() || operation == Operation.OTA_TRANSFER) {
                Log.w(TAG, "Rejecting normal write state=" + state + " operation=" + operation);
                return false;
            }
            return action != null && action.write();
        }
    }

    /** Raw BES protocol query outside an OTA transfer. */
    public boolean writeRawControl(byte[] data) {
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.NONE || data == null) {
                Log.w(
                        TAG,
                        "Rejecting raw control write state=" + state + " operation=" + operation);
                return false;
            }
            return host.writeRawBytes(data);
        }
    }

    public boolean runFileWrite(WriteAction action) {
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.FILE_TRANSFER) {
                Log.w(TAG, "Rejecting file write state=" + state + " operation=" + operation);
                return false;
            }
            return action != null && action.write();
        }
    }

    public boolean writeOta(byte[] data) {
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.OTA_TRANSFER || data == null) {
                Log.w(TAG, "Rejecting OTA write state=" + state + " operation=" + operation);
                return false;
            }
            return host.writeRawBytes(data);
        }
    }

    public boolean beginFileTransfer() {
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.NONE) {
                return false;
            }
            operation = Operation.FILE_TRANSFER;
            host.setFastReceive(true);
            cancelHealthTimeoutLocked();
            return true;
        }
    }

    public void endFileTransfer() {
        endOperation(Operation.FILE_TRANSFER);
    }

    public boolean beginOtaAuthorization() {
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.NONE) {
                return false;
            }
            operation = Operation.OTA_AUTHORIZATION;
            cancelHealthTimeoutLocked();
            Log.i(TAG, "BES OTA authorization owns stable UART");
            return true;
        }
    }

    public boolean promoteOtaAuthorizationToTransfer() {
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.OTA_AUTHORIZATION) {
                return false;
            }
            operation = Operation.OTA_TRANSFER;
            host.setOtaReceiveRoute(true);
            host.setFastReceive(true);
            Log.i(TAG, "BES OTA authorization promoted to raw transfer routing");
            return true;
        }
    }

    public void endOta() {
        synchronized (monitor) {
            if (operation != Operation.OTA_AUTHORIZATION && operation != Operation.OTA_TRANSFER) {
                return;
            }
            host.setOtaReceiveRoute(false);
            host.setFastReceive(false);
            operation = Operation.NONE;
            resumeAfterOperationLocked();
        }
    }

    /**
     * BES rebooted after applying OTA; return to rendezvous and rediscover one coherent session.
     */
    public void onBesOtaApplied() {
        synchronized (monitor) {
            cancelAllTimersLocked();
            host.setOtaReceiveRoute(false);
            host.setFastReceive(false);
            operation = Operation.NONE;
            versionGeneration = -1;
            fastSwitchAttemptGeneration = -1;
            firmwareVersion = "";
            host.invalidateLinkProof();
            serialGeneration++;
            state = State.DISCOVERING;
            long phase = ++phaseGeneration;
            host.resetParser();
            if (!host.openAtBaud(AsgConstants.UART_RENDEZVOUS_BAUD)) {
                state = State.RECOVERING;
                recoveryIndex = 0;
                recoveryRetryAttempt = 0;
                phaseTimeout =
                        executor.schedule(
                                () -> runRecoveryCandidate(phase),
                                AsgConstants.BES_OTA_RECONNECT_DELAY_MS,
                                TimeUnit.MILLISECONDS);
                Log.w(TAG, "Rendezvous open failed after BES OTA; recovery will retry");
                return;
            }
            scheduleProbeBurstLocked(
                    phase,
                    AsgConstants.UART_RENDEZVOUS_BAUD,
                    AsgConstants.BES_OTA_RECONNECT_DELAY_MS,
                    AsgConstants.UART_RECOVERY_PROBES_PER_BURST,
                    AsgConstants.UART_RECOVERY_PROBE_SPACING_MS);
            phaseTimeout =
                    executor.schedule(
                            () -> startRecoveryIfCurrent(phase, "bes_ota_reconnect_timeout"),
                            AsgConstants.BES_OTA_RECONNECT_DELAY_MS
                                    + AsgConstants.UART_BOOT_RECOVERY_INITIAL_DELAY_MS,
                            TimeUnit.MILLISECONDS);
        }
    }

    public void shutdown() {
        synchronized (monitor) {
            cancelAllTimersLocked();
            state = State.CLOSED;
            operation = Operation.NONE;
            phaseGeneration++;
            serialGeneration++;
        }
        executor.shutdownNow();
    }

    private void endOperation(Operation expected) {
        synchronized (monitor) {
            if (operation != expected) {
                return;
            }
            operation = Operation.NONE;
            host.setFastReceive(false);
            resumeAfterOperationLocked();
        }
    }

    private void resumeAfterOperationLocked() {
        if (state == State.READY_FAST) {
            scheduleHealthCheckLocked();
        }
        advanceLocked();
    }

    /** Advance immediately from current facts; no deferred intent survives outside the monitor. */
    private void advanceLocked() {
        if (state != State.READY_RENDEZVOUS
                || operation != Operation.NONE
                || versionGeneration != serialGeneration
                || fastSwitchAttemptGeneration == serialGeneration
                || firmwareVersion.isEmpty()
                || !host.supportsFastBaud(firmwareVersion)) {
            return;
        }
        beginFastSwitchLocked();
    }

    private void beginFastSwitchLocked() {
        fastSwitchAttemptGeneration = serialGeneration;
        state = State.SWITCH_REQUESTED;
        host.invalidateLinkProof();
        long phase = ++phaseGeneration;
        boolean sent = host.writeControlCommand(buildBaudRequest());
        if (!sent) {
            Log.e(TAG, "Could not completely write cs_baud; recovering indeterminate UART state");
            startRecoveryLocked("baud_request_write_failed");
            return;
        }
        phaseTimeout =
                executor.schedule(
                        () -> reopenFastAndVerifyIfCurrent(phase, "sr_baud_timeout"),
                        AsgConstants.UART_BAUD_ACK_TIMEOUT_MS,
                        TimeUnit.MILLISECONDS);
        Log.i(TAG, "Requested fast UART baud " + AsgConstants.UART_FAST_BAUD);
    }

    private void reopenFastAndVerifyIfCurrent(long phase, String reason) {
        synchronized (monitor) {
            if (phase != phaseGeneration
                    || (state != State.SWITCH_REQUESTED && state != State.WAITING_FAST_REOPEN)) {
                return;
            }
            if (operation != Operation.NONE) {
                Log.e(TAG, "Operation appeared during baud transition: " + operation);
                return;
            }
            cancelPhaseTimeoutLocked();
            serialGeneration++;
            host.invalidateLinkProof();
            host.resetParser();
            if (!host.openAtBaud(AsgConstants.UART_FAST_BAUD)) {
                startRecoveryLocked("fast_reopen_failed");
                return;
            }
            state = State.VERIFYING_FAST;
            long verifyPhase = ++phaseGeneration;
            scheduleProbeBurstLocked(
                    verifyPhase,
                    AsgConstants.UART_FAST_BAUD,
                    0,
                    AsgConstants.UART_RECOVERY_PROBES_PER_BURST,
                    AsgConstants.UART_RECOVERY_PROBE_SPACING_MS);
            phaseTimeout =
                    executor.schedule(
                            () -> startRecoveryIfCurrent(verifyPhase, "fast_probe_timeout"),
                            AsgConstants.UART_BAUD_PROBE_TIMEOUT_MS,
                            TimeUnit.MILLISECONDS);
            Log.i(TAG, "Reopened fast UART; verifying link (reason=" + reason + ")");
        }
    }

    private void startRecoveryIfCurrent(long phase, String reason) {
        synchronized (monitor) {
            if (phase != phaseGeneration || isReadyLocked() || state == State.CLOSED) {
                return;
            }
            startRecoveryLocked(reason);
        }
    }

    private void startRecoveryLocked(String reason) {
        if (operation != Operation.NONE) {
            if (state == State.READY_FAST) {
                scheduleHealthCheckLocked();
            }
            return;
        }
        cancelAllTimersLocked();
        host.invalidateLinkProof();
        state = State.RECOVERING;
        recoveryIndex = 0;
        recoveryRetryAttempt = 0;
        long phase = ++phaseGeneration;
        Log.w(TAG, "Starting UART recovery: " + reason);
        executor.execute(() -> runRecoveryCandidate(phase));
    }

    private void runRecoveryCandidate(long phase) {
        synchronized (monitor) {
            if (phase != phaseGeneration || state != State.RECOVERING) {
                return;
            }
            if (recoveryIndex >= RECOVERY_BAUDS.length) {
                parkRecoveryAtRendezvousLocked();
                return;
            }

            int baud = RECOVERY_BAUDS[recoveryIndex++];
            serialGeneration++;
            host.invalidateLinkProof();
            host.resetParser();
            if ((!host.isSerialOpen() || host.currentBaud() != baud) && !host.openAtBaud(baud)) {
                executor.execute(() -> runRecoveryCandidate(phase));
                return;
            }
            long candidatePhase = ++phaseGeneration;
            scheduleProbeBurstLocked(
                    candidatePhase,
                    baud,
                    0,
                    AsgConstants.UART_RUNTIME_RECOVERY_PROBES_PER_BAUD,
                    AsgConstants.UART_RUNTIME_RECOVERY_PROBE_SPACING_MS);
            phaseTimeout =
                    executor.schedule(
                            () -> continueRecovery(candidatePhase),
                            AsgConstants.UART_RUNTIME_RECOVERY_STEP_TIMEOUT_MS,
                            TimeUnit.MILLISECONDS);
            Log.i(TAG, "Recovery probing baud " + baud);
        }
    }

    private void continueRecovery(long candidatePhase) {
        synchronized (monitor) {
            if (candidatePhase != phaseGeneration || state != State.RECOVERING) {
                return;
            }
            long nextPhase = ++phaseGeneration;
            executor.execute(() -> runRecoveryCandidate(nextPhase));
        }
    }

    private void parkRecoveryAtRendezvousLocked() {
        serialGeneration++;
        host.invalidateLinkProof();
        host.resetParser();
        if ((!host.isSerialOpen() || host.currentBaud() != AsgConstants.UART_RENDEZVOUS_BAUD)
                && !host.openAtBaud(AsgConstants.UART_RENDEZVOUS_BAUD)) {
            Log.w(TAG, "Recovery could not open rendezvous baud; retaining retry ownership");
        }
        recoveryIndex = 0;
        long delay = recoveryRetryDelayMs(recoveryRetryAttempt++);
        long phase = ++phaseGeneration;
        phaseTimeout =
                executor.schedule(() -> runRecoveryCandidate(phase), delay, TimeUnit.MILLISECONDS);
        Log.w(TAG, "Recovery parked at rendezvous; retrying in " + delay + "ms");
    }

    private void scheduleHealthCheckLocked() {
        cancelHealthTimeoutLocked();
        if (state == State.READY_FAST && !executor.isShutdown()) {
            long phase = phaseGeneration;
            healthTimeout =
                    executor.schedule(
                            () -> onHealthTimeout(phase),
                            AsgConstants.UART_HIGH_BAUD_IDLE_PROBE_MS,
                            TimeUnit.MILLISECONDS);
        }
    }

    private void onHealthTimeout(long phase) {
        synchronized (monitor) {
            healthTimeout = null;
            if (phase != phaseGeneration || state != State.READY_FAST) {
                return;
            }
            if (operation != Operation.NONE) {
                scheduleHealthCheckLocked();
                return;
            }
            startRecoveryLocked("idle_health_probe");
        }
    }

    private void scheduleProbeBurstLocked(
            long phase, int expectedBaud, long initialDelayMs, int count, long spacingMs) {
        for (int i = 0; i < count; i++) {
            long delay = initialDelayMs + i * spacingMs;
            executor.schedule(
                    () -> sendProbeIfCurrent(phase, expectedBaud), delay, TimeUnit.MILLISECONDS);
        }
    }

    private void sendProbeIfCurrent(long phase, int expectedBaud) {
        synchronized (monitor) {
            if (phase != phaseGeneration
                    || state == State.CLOSED
                    || operation == Operation.OTA_TRANSFER
                    || host.currentBaud() != expectedBaud) {
                return;
            }
            if (!host.writeControlCommand(buildSystemVersionRequest())) {
                Log.w(TAG, "System-version probe write failed at " + expectedBaud);
            }
        }
    }

    private boolean isReadyLocked() {
        return state == State.READY_RENDEZVOUS || state == State.READY_FAST;
    }

    private void cancelAllTimersLocked() {
        cancelPhaseTimeoutLocked();
        cancelHealthTimeoutLocked();
    }

    private void cancelPhaseTimeoutLocked() {
        if (phaseTimeout != null) {
            phaseTimeout.cancel(false);
            phaseTimeout = null;
        }
    }

    private void cancelHealthTimeoutLocked() {
        if (healthTimeout != null) {
            healthTimeout.cancel(false);
            healthTimeout = null;
        }
    }

    static long recoveryRetryDelayMs(int retryAttempt) {
        long delay = AsgConstants.UART_RUNTIME_RECOVERY_RETRY_DELAY_MS;
        for (int i = 0;
                i < retryAttempt && delay < AsgConstants.UART_RUNTIME_RECOVERY_MAX_RETRY_DELAY_MS;
                i++) {
            delay = Math.min(delay * 2, AsgConstants.UART_RUNTIME_RECOVERY_MAX_RETRY_DELAY_MS);
        }
        return delay;
    }

    private static byte[] buildSystemVersionRequest() {
        try {
            JSONObject command = new JSONObject();
            command.put("C", "cs_syvr");
            command.put("V", 1);
            command.put("B", "");
            return command.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("Could not build cs_syvr", e);
        }
    }

    private static byte[] buildBaudRequest() {
        try {
            JSONObject body = new JSONObject();
            body.put("baud", AsgConstants.UART_FAST_BAUD);
            JSONObject command = new JSONObject();
            command.put("C", "cs_baud");
            command.put("V", 1);
            command.put("B", body.toString());
            return command.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("Could not build cs_baud", e);
        }
    }
}
