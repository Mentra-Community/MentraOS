package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;

import com.mentra.asg_client.AsgConstants;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Single policy owner for the ASG-to-BES UART.
 *
 * <p>The monitor serializes transport decisions while a dedicated FIFO lane serializes physical
 * writes and descriptor transitions. Timers only feed events back through those two owners; they
 * never mutate transport state independently.
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

    /** Opaque ownership token for one exclusive operation lifetime. */
    public static final class OperationLease {
        private final long id;
        private final Operation acquiredAs;

        private OperationLease(long id, Operation acquiredAs) {
            this.id = id;
            this.acquiredAs = acquiredAs;
        }

        @Override
        public String toString() {
            return acquiredAs + "#" + id;
        }
    }

    /** Outcome of consuming a session-matched BES system-version reply. */
    public enum SystemVersionResult {
        IGNORED,
        READY,
        TRANSITIONING
    }

    /** Receive parser selected for bytes from one validated physical session. */
    public enum InboundRoute {
        REJECTED,
        NORMAL,
        OTA
    }

    /** A physical write performed on the FIFO UART lane without holding the state monitor. */
    @FunctionalInterface
    public interface WriteAction {
        boolean write();
    }

    /** Hardware/protocol hooks implemented by {@code K900BluetoothManager}. */
    public interface Host {
        int currentBaud();

        boolean isSerialOpen();

        /**
         * Replace the physical serial port at exactly {@code baud} and return its unstarted
         * session, or {@code null} on failure.
         */
        SerialSession openAtBaud(int baud);

        /** Start receiving after the coordinator has adopted the opened session. */
        boolean startReader(SerialSession session);

        /** Close an opened session that cannot be adopted or is no longer current. */
        void closeSession(SerialSession session);

        /** Invalidate the current link proof before a transition can be observed by consumers. */
        void invalidateLinkProof();

        /** Clear partial receive framing without reopening the port. */
        void resetParser();

        /** Write one coordinator-owned K900 control command synchronously. */
        boolean writeControlCommand(byte[] json);

        /** Write raw BES protocol bytes synchronously. */
        boolean writeRawBytes(byte[] data);

        /** Adjust receive polling for high-throughput file or OTA traffic. */
        void setFastReceive(boolean enabled);

        /** Whether this firmware version implements the negotiated fast-baud contract. */
        boolean supportsFastBaud(String firmwareVersion);

        /** Queue a barrier behind every outbound message accepted before this call. */
        boolean queueAfterOutboundWrites(Runnable action);
    }

    private static final int[] RECOVERY_BAUDS = {
        AsgConstants.UART_FAST_BAUD, AsgConstants.UART_RENDEZVOUS_BAUD
    };

    private final Object monitor = new Object();
    private final Host host;
    private final BesUartIoLane ioLane = new BesUartIoLane();
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private final ArrayDeque<FutureTask<Boolean>> deferredNormalWrites = new ArrayDeque<>();

    private State state = State.CLOSED;
    private Operation operation = Operation.NONE;
    private OperationLease operationLease;
    private boolean otaRawRouting = false;
    private long nextOperationLeaseId = 1;
    private SerialSession serialSession;
    private long phaseGeneration = 0;
    private SerialSession versionSession;
    private SerialSession fastSwitchAttemptSession;
    private int recoveryIndex = 0;
    private int recoveryRetryAttempt = 0;
    private String firmwareVersion = "";
    private long discardedBytes = 0;
    private int discardEvents = 0;
    private boolean versionProbeDeferred = false;
    private boolean outboundDrainPending = false;
    private long outboundDrainGeneration = 0;

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

    int getDeferredNormalWriteCount() {
        synchronized (monitor) {
            return deferredNormalWrites.size();
        }
    }

    public boolean isReady() {
        synchronized (monitor) {
            return isReadyLocked();
        }
    }

    /** Route bytes only when they belong to the descriptor currently owned by this coordinator. */
    public InboundRoute inboundRoute(SerialSession session) {
        synchronized (monitor) {
            if (!isCurrentSerialSessionLocked(session) || state == State.CLOSED) {
                return InboundRoute.REJECTED;
            }
            return otaRawRouting ? InboundRoute.OTA : InboundRoute.NORMAL;
        }
    }

    /** Session captured by receive callbacks so retired descriptors cannot mutate state. */
    public SerialSession getSerialSession() {
        synchronized (monitor) {
            return serialSession;
        }
    }

    public boolean isCurrentSerialSession(SerialSession session) {
        synchronized (monitor) {
            return isCurrentSerialSessionLocked(session);
        }
    }

    /** Run a receive-side mutation atomically only for the current serial reader. */
    public boolean runForCurrentSerialSession(SerialSession session, Runnable action) {
        synchronized (monitor) {
            if (!isCurrentSerialSessionLocked(session) || action == null) {
                return false;
            }
            action.run();
            return true;
        }
    }

    /** Start discovery at the rendezvous baud when the serial driver opens. */
    public void onSerialReady(SerialSession session) {
        synchronized (monitor) {
            if (session == null) {
                throw new IllegalArgumentException("session is required");
            }
            cancelAllTimersLocked();
            cancelDeferredNormalWritesLocked("serial session replaced");
            operation = Operation.NONE;
            operationLease = null;
            otaRawRouting = false;
            host.setFastReceive(false);
            state = State.DISCOVERING;
            versionSession = null;
            fastSwitchAttemptSession = null;
            firmwareVersion = "";
            discardedBytes = 0;
            discardEvents = 0;
            versionProbeDeferred = false;
            cancelOutboundDrainLocked();
            serialSession = session;
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
            cancelDeferredNormalWritesLocked("serial session closed");
            phaseGeneration++;
            serialSession = null;
            versionSession = null;
            fastSwitchAttemptSession = null;
            firmwareVersion = "";
            versionProbeDeferred = false;
            cancelOutboundDrainLocked();
            state = State.CLOSED;
            operation = Operation.NONE;
            operationLease = null;
            otaRawRouting = false;
            host.setFastReceive(false);
            Log.i(TAG, "Serial closed");
        }
    }

    /**
     * Consume an {@code sr_syvr}. The preparation callback runs only for the current serial session
     * and before any resulting baud transition. A reply that starts a baud switch never creates a
     * transient ready edge.
     */
    public SystemVersionResult onSystemVersion(
            String version, SerialSession receiveSession, Runnable beforeTransition) {
        synchronized (monitor) {
            if (!isCurrentSerialSessionLocked(receiveSession)
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
            versionSession = serialSession;
            versionProbeDeferred = false;
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
    public boolean onBaudResponse(int status, int acknowledgedBaud, SerialSession receiveSession) {
        synchronized (monitor) {
            if (!isCurrentSerialSessionLocked(receiveSession) || state != State.SWITCH_REQUESTED) {
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
    public void onValidFrame(SerialSession receiveSession) {
        synchronized (monitor) {
            if (!isCurrentSerialSessionLocked(receiveSession)) {
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
    public void onDiscardedBytes(long count, SerialSession receiveSession) {
        synchronized (monitor) {
            if (!isCurrentSerialSessionLocked(receiveSession)
                    || count <= 0
                    || state != State.READY_FAST) {
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
        Future<Boolean> write;
        synchronized (monitor) {
            if (!isReadyLocked() || action == null) {
                Log.w(TAG, "Rejecting normal write state=" + state + " operation=" + operation);
                return false;
            }
            if (operation == Operation.NONE) {
                write = ioLane.submit(action::write);
            } else {
                FutureTask<Boolean> deferred = new FutureTask<>(action::write);
                deferredNormalWrites.addLast(deferred);
                write = deferred;
                Log.i(
                        TAG,
                        "Deferring normal write behind "
                                + operation
                                + " pending="
                                + deferredNormalWrites.size());
            }
        }
        return awaitBoolean(write, "normal write");
    }

    /** Raw BES protocol query outside an OTA transfer. */
    public boolean writeRawControl(byte[] data) {
        Future<Boolean> write;
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.NONE || data == null) {
                Log.w(
                        TAG,
                        "Rejecting raw control write state=" + state + " operation=" + operation);
                return false;
            }
            write = ioLane.submit(() -> host.writeRawBytes(data));
        }
        return awaitBoolean(write, "raw control write");
    }

    public boolean runFileWrite(OperationLease lease, WriteAction action) {
        Future<Boolean> write;
        synchronized (monitor) {
            if (!isReadyLocked()
                    || !ownsLeaseLocked(lease, Operation.FILE_TRANSFER)
                    || action == null) {
                Log.w(TAG, "Rejecting file write state=" + state + " operation=" + operation);
                return false;
            }
            write = ioLane.submit(action::write);
        }
        return awaitBoolean(write, "file write");
    }

    public boolean writeOta(OperationLease lease, byte[] data) {
        Future<Boolean> write;
        synchronized (monitor) {
            if (!isReadyLocked()
                    || !ownsLeaseLocked(lease, Operation.OTA_TRANSFER)
                    || data == null) {
                Log.w(TAG, "Rejecting OTA write state=" + state + " operation=" + operation);
                return false;
            }
            write = ioLane.submit(() -> host.writeRawBytes(data));
        }
        return awaitBoolean(write, "OTA write");
    }

    public OperationLease beginFileTransfer() {
        return beginOperation(Operation.FILE_TRANSFER, true);
    }

    public void endFileTransfer(OperationLease lease) {
        endOperation(lease, Operation.FILE_TRANSFER);
    }

    /**
     * Write one terminal status while retaining exclusive file ownership, then release the lease.
     * This keeps a deferred baud transition behind the status write.
     */
    public boolean endFileTransferWithFinalWrite(OperationLease lease, WriteAction finalWrite) {
        try {
            Future<Boolean> write;
            synchronized (monitor) {
                if (!ownsLeaseLocked(lease, Operation.FILE_TRANSFER)) {
                    return false;
                }
                if (!isReadyLocked() || finalWrite == null) {
                    return false;
                }
                write = ioLane.submit(finalWrite::write);
            }
            return awaitBoolean(write, "file terminal write");
        } finally {
            synchronized (monitor) {
                releaseOperationLocked(lease, Operation.FILE_TRANSFER);
            }
        }
    }

    public OperationLease beginOtaAuthorization() {
        OperationLease lease = beginOperation(Operation.OTA_AUTHORIZATION, false);
        if (lease != null) {
            Log.i(TAG, "BES OTA authorization owns stable UART");
        }
        return lease;
    }

    /** Write the single normal-framed request owned by the OTA authorization lease. */
    public boolean runOtaAuthorizationWrite(OperationLease lease, WriteAction action) {
        Future<Boolean> write;
        synchronized (monitor) {
            if (!isReadyLocked()
                    || !ownsLeaseLocked(lease, Operation.OTA_AUTHORIZATION)
                    || action == null) {
                Log.w(
                        TAG,
                        "Rejecting OTA authorization write state="
                                + state
                                + " operation="
                                + operation);
                return false;
            }
            write = ioLane.submit(action::write);
        }
        return awaitBoolean(write, "OTA authorization write");
    }

    public boolean promoteOtaAuthorizationToTransfer(OperationLease lease) {
        Future<?> barrier;
        synchronized (monitor) {
            if (!isReadyLocked() || !ownsLeaseLocked(lease, Operation.OTA_AUTHORIZATION)) {
                return false;
            }
            // Close authorization writes before placing the barrier. Inbound bytes remain on the
            // normal parser until every accepted normal-framed write has physically completed.
            operation = Operation.OTA_TRANSFER;
            barrier = ioLane.submit(() -> {});
        }

        if (!awaitBarrier(barrier, "OTA promotion barrier")) {
            return false;
        }

        synchronized (monitor) {
            if (!isReadyLocked() || !ownsLeaseLocked(lease, Operation.OTA_TRANSFER)) {
                return false;
            }
            otaRawRouting = true;
            host.setFastReceive(true);
            Log.i(TAG, "BES OTA authorization promoted to raw transfer routing");
            return true;
        }
    }

    public void endOta(OperationLease lease) {
        synchronized (monitor) {
            if (operationLease != lease
                    || (operation != Operation.OTA_AUTHORIZATION
                            && operation != Operation.OTA_TRANSFER)) {
                return;
            }
            otaRawRouting = false;
            host.setFastReceive(false);
            operation = Operation.NONE;
            operationLease = null;
            flushDeferredNormalWritesLocked();
            resumeAfterOutboundDrainLocked();
        }
    }

    /**
     * BES rebooted after applying OTA; return to rendezvous and rediscover one coherent session.
     */
    public void onBesOtaApplied() {
        synchronized (monitor) {
            cancelAllTimersLocked();
            cancelDeferredNormalWritesLocked("BES OTA reset the serial session");
            otaRawRouting = false;
            host.setFastReceive(false);
            operation = Operation.NONE;
            operationLease = null;
            versionSession = null;
            fastSwitchAttemptSession = null;
            firmwareVersion = "";
            versionProbeDeferred = false;
            cancelOutboundDrainLocked();
            host.invalidateLinkProof();
            serialSession = null;
            state = State.DISCOVERING;
            long phase = ++phaseGeneration;
            ioLane.submit(() -> reconnectAfterOta(phase));
        }
    }

    private void reconnectAfterOta(long phase) {
        synchronized (monitor) {
            if (phase != phaseGeneration || state != State.DISCOVERING) {
                return;
            }
        }

        SerialSession opened = replacePhysicalSession(AsgConstants.UART_RENDEZVOUS_BAUD);
        boolean closeOpened = false;
        synchronized (monitor) {
            if (phase != phaseGeneration || state != State.DISCOVERING) {
                closeOpened = opened != null;
            } else if (!adoptAndStartSessionLocked(opened)) {
                closeOpened = opened != null;
                state = State.RECOVERING;
                recoveryIndex = 0;
                recoveryRetryAttempt = 0;
                phaseTimeout =
                        executor.schedule(
                                () -> runRecoveryCandidate(phase),
                                AsgConstants.BES_OTA_RECONNECT_DELAY_MS,
                                TimeUnit.MILLISECONDS);
                Log.w(TAG, "Rendezvous open failed after BES OTA; recovery will retry");
            } else {
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
        if (closeOpened) {
            host.closeSession(opened);
        }
    }

    public void shutdown() {
        synchronized (monitor) {
            cancelAllTimersLocked();
            cancelDeferredNormalWritesLocked("transport shutdown");
            state = State.CLOSED;
            operation = Operation.NONE;
            operationLease = null;
            otaRawRouting = false;
            cancelOutboundDrainLocked();
            phaseGeneration++;
            serialSession = null;
            host.setFastReceive(false);
        }
        ioLane.shutdownNow();
        executor.shutdownNow();
    }

    private OperationLease beginOperation(Operation requested, boolean fastReceive) {
        Future<?> barrier;
        OperationLease lease;
        synchronized (monitor) {
            if (!isReadyLocked() || operation != Operation.NONE) {
                return null;
            }
            operation = requested;
            lease = new OperationLease(nextOperationLeaseId++, requested);
            operationLease = lease;
            cancelHealthTimeoutLocked();
            barrier = ioLane.submit(() -> {});
        }

        if (!awaitBarrier(barrier, requested + " barrier")) {
            synchronized (monitor) {
                releaseOperationLocked(lease, requested);
            }
            return null;
        }

        synchronized (monitor) {
            if (!ownsLeaseLocked(lease, requested) || !isReadyLocked()) {
                return null;
            }
            host.setFastReceive(fastReceive);
            return lease;
        }
    }

    private void endOperation(OperationLease lease, Operation expected) {
        synchronized (monitor) {
            releaseOperationLocked(lease, expected);
        }
    }

    private boolean ownsLeaseLocked(OperationLease lease, Operation expected) {
        return lease != null && operationLease == lease && operation == expected;
    }

    private void releaseOperationLocked(OperationLease lease, Operation expected) {
        if (!ownsLeaseLocked(lease, expected)) {
            return;
        }
        operationLease = null;
        operation = Operation.NONE;
        otaRawRouting = false;
        host.setFastReceive(false);
        flushDeferredNormalWritesLocked();
        resumeAfterOutboundDrainLocked();
    }

    private void flushDeferredNormalWritesLocked() {
        int count = deferredNormalWrites.size();
        while (!deferredNormalWrites.isEmpty()) {
            ioLane.execute(deferredNormalWrites.removeFirst());
        }
        if (count > 0) {
            Log.i(TAG, "Released " + count + " deferred normal write(s) to the UART lane");
        }
    }

    private void cancelDeferredNormalWritesLocked(String reason) {
        int count = deferredNormalWrites.size();
        while (!deferredNormalWrites.isEmpty()) {
            deferredNormalWrites.removeFirst().cancel(false);
        }
        if (count > 0) {
            Log.w(TAG, "Cancelled " + count + " deferred normal write(s): " + reason);
        }
    }

    private void resumeAfterOutboundDrainLocked() {
        if (outboundDrainPending) {
            return;
        }
        outboundDrainPending = true;
        long generation = ++outboundDrainGeneration;
        if (!host.queueAfterOutboundWrites(() -> onOutboundDrained(generation))) {
            outboundDrainPending = false;
            resumeAfterOperationLocked();
        }
    }

    private void onOutboundDrained(long generation) {
        synchronized (monitor) {
            if (!outboundDrainPending
                    || generation != outboundDrainGeneration
                    || state == State.CLOSED) {
                return;
            }
            outboundDrainPending = false;
            resumeAfterOperationLocked();
        }
    }

    private void cancelOutboundDrainLocked() {
        outboundDrainPending = false;
        outboundDrainGeneration++;
    }

    private void resumeAfterOperationLocked() {
        resumeDeferredVersionProbeLocked();
        if (state == State.READY_FAST) {
            scheduleHealthCheckLocked();
        }
        advanceLocked();
    }

    private boolean awaitBoolean(Future<Boolean> future, String description) {
        try {
            return Boolean.TRUE.equals(future.get());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.w(TAG, "Interrupted while waiting for " + description, e);
        } catch (ExecutionException e) {
            Log.e(TAG, "UART lane failed during " + description, e.getCause());
        } catch (CancellationException e) {
            Log.w(TAG, "UART lane cancelled " + description);
        }
        return false;
    }

    private boolean awaitBarrier(Future<?> future, String description) {
        try {
            future.get();
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.w(TAG, "Interrupted while waiting for " + description, e);
        } catch (ExecutionException e) {
            Log.e(TAG, "UART lane failed during " + description, e.getCause());
        } catch (CancellationException e) {
            Log.w(TAG, "UART lane cancelled " + description);
        }
        return false;
    }

    /** Advance immediately from current facts; no deferred intent survives outside the monitor. */
    private void advanceLocked() {
        if (state != State.READY_RENDEZVOUS
                || operation != Operation.NONE
                || outboundDrainPending
                || versionSession != serialSession
                || fastSwitchAttemptSession == serialSession
                || firmwareVersion.isEmpty()
                || !host.supportsFastBaud(firmwareVersion)) {
            return;
        }
        beginFastSwitchLocked();
    }

    private void beginFastSwitchLocked() {
        fastSwitchAttemptSession = serialSession;
        state = State.SWITCH_REQUESTED;
        host.invalidateLinkProof();
        long phase = ++phaseGeneration;
        ioLane.submit(
                () -> {
                    boolean sent = host.writeControlCommand(buildBaudRequest());
                    onBaudRequestWriteComplete(phase, sent);
                });
    }

    private void onBaudRequestWriteComplete(long phase, boolean sent) {
        synchronized (monitor) {
            if (phase != phaseGeneration || state != State.SWITCH_REQUESTED) {
                return;
            }
            if (!sent) {
                Log.e(
                        TAG,
                        "Could not completely write cs_baud; recovering indeterminate UART state");
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
            serialSession = null;
            host.invalidateLinkProof();
            state = State.VERIFYING_FAST;
            long reopenPhase = ++phaseGeneration;
            ioLane.submit(() -> performFastReopen(reopenPhase, reason));
        }
    }

    private void performFastReopen(long reopenPhase, String reason) {
        synchronized (monitor) {
            if (reopenPhase != phaseGeneration || state != State.VERIFYING_FAST) {
                return;
            }
        }

        SerialSession opened = replacePhysicalSession(AsgConstants.UART_FAST_BAUD);
        boolean closeOpened = false;
        synchronized (monitor) {
            if (reopenPhase != phaseGeneration || state != State.VERIFYING_FAST) {
                closeOpened = opened != null;
            } else if (!adoptAndStartSessionLocked(opened)) {
                closeOpened = opened != null;
                startRecoveryLocked("fast_reopen_failed");
            } else {
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
        if (closeOpened) {
            host.closeSession(opened);
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
        serialSession = null;
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
                ioLane.submit(() -> parkRecoveryAtRendezvous(phase));
                return;
            }

            int baud = RECOVERY_BAUDS[recoveryIndex++];
            ioLane.submit(() -> performRecoveryCandidate(phase, baud));
        }
    }

    private void performRecoveryCandidate(long phase, int baud) {
        synchronized (monitor) {
            if (phase != phaseGeneration || state != State.RECOVERING) {
                return;
            }
            host.invalidateLinkProof();
            serialSession = null;
        }

        SerialSession opened = replacePhysicalSession(baud);
        boolean closeOpened = false;
        synchronized (monitor) {
            if (phase != phaseGeneration || state != State.RECOVERING) {
                closeOpened = opened != null;
            } else if (!adoptAndStartSessionLocked(opened)) {
                closeOpened = opened != null;
                executor.execute(() -> runRecoveryCandidate(phase));
            } else {
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
        if (closeOpened) {
            host.closeSession(opened);
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

    private void parkRecoveryAtRendezvous(long expectedPhase) {
        synchronized (monitor) {
            if (expectedPhase != phaseGeneration || state != State.RECOVERING) {
                return;
            }
            serialSession = null;
            host.invalidateLinkProof();
        }

        SerialSession opened = replacePhysicalSession(AsgConstants.UART_RENDEZVOUS_BAUD);
        boolean closeOpened = false;
        synchronized (monitor) {
            if (expectedPhase != phaseGeneration || state != State.RECOVERING) {
                closeOpened = opened != null;
            } else {
                boolean adopted = adoptAndStartSessionLocked(opened);
                if (!adopted) {
                    closeOpened = opened != null;
                    Log.w(
                            TAG,
                            "Recovery could not open rendezvous baud; retaining retry ownership");
                }
                recoveryIndex = 0;
                long delay = recoveryRetryDelayMs(recoveryRetryAttempt++);
                long phase = ++phaseGeneration;
                if (adopted) {
                    scheduleProbeBurstLocked(
                            phase,
                            AsgConstants.UART_RENDEZVOUS_BAUD,
                            0,
                            AsgConstants.UART_RUNTIME_RECOVERY_PROBES_PER_BAUD,
                            AsgConstants.UART_RUNTIME_RECOVERY_PROBE_SPACING_MS);
                }
                phaseTimeout =
                        executor.schedule(
                                () -> runRecoveryCandidate(phase), delay, TimeUnit.MILLISECONDS);
                Log.w(TAG, "Recovery parked at rendezvous; retrying in " + delay + "ms");
            }
        }
        if (closeOpened) {
            host.closeSession(opened);
        }
    }

    /** Publish the session before starting its reader so its first callback can be validated. */
    private boolean adoptAndStartSessionLocked(SerialSession session) {
        if (session == null) {
            return false;
        }
        serialSession = session;
        if (host.startReader(session)) {
            return true;
        }
        serialSession = null;
        return false;
    }

    /** Retire the prior descriptor before clearing parser state for the unstarted replacement. */
    private SerialSession replacePhysicalSession(int baud) {
        SerialSession session = host.openAtBaud(baud);
        host.resetParser();
        return session;
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
                    || host.currentBaud() != expectedBaud) {
                return;
            }
            if (operation != Operation.NONE) {
                versionProbeDeferred = true;
                return;
            }
            ioLane.submit(() -> executeProbeIfCurrent(phase, expectedBaud));
        }
    }

    private void executeProbeIfCurrent(long phase, int expectedBaud) {
        synchronized (monitor) {
            if (phase != phaseGeneration
                    || state == State.CLOSED
                    || host.currentBaud() != expectedBaud) {
                return;
            }
            if (operation != Operation.NONE) {
                versionProbeDeferred = true;
                return;
            }
        }
        if (!host.writeControlCommand(buildSystemVersionRequest())) {
            Log.w(TAG, "System-version probe write failed at " + expectedBaud);
        }
    }

    private void resumeDeferredVersionProbeLocked() {
        if (!versionProbeDeferred
                || operation != Operation.NONE
                || !isReadyLocked()
                || versionSession == serialSession
                || executor.isShutdown()) {
            return;
        }
        versionProbeDeferred = false;
        long phase = phaseGeneration;
        int baud = host.currentBaud();
        executor.execute(() -> sendProbeIfCurrent(phase, baud));
    }

    private boolean isReadyLocked() {
        return state == State.READY_RENDEZVOUS || state == State.READY_FAST;
    }

    private boolean isCurrentSerialSessionLocked(SerialSession session) {
        return session != null && session == serialSession;
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
