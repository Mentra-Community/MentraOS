package com.mentra.asg_client.io.bes;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import com.mentra.asg_client.io.bes.protocol.*;
import com.mentra.asg_client.io.bes.util.BesOtaUtil;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.utils.ByteUtil;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.utils.WakeLockManager;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.UUID;
import org.greenrobot.eventbus.EventBus;
import org.json.JSONObject;

/**
 * Manages BES2700 firmware OTA updates Handles file loading, packet transmission, state tracking,
 * and protocol state machine
 */
public class BesOtaManager implements IBesOtaController, BesOtaUartListener, BesOtaCommandListener {
    private static final String TAG = "BesOtaManager";

    // Static flag to track if BES OTA is in progress
    public static volatile boolean isBesOtaInProgress = false;

    private static byte[] sCurrentFirmwareVersion = null; // Store current firmware version bytes

    // Wakelock timeout for BES OTA to prevent CPU sleep during firmware transfer
    private static final long WAKELOCK_TIMEOUT_MS = 300000; // 5 minutes
    // Intentional hard cap: a healthy BES OTA must finish within 5 minutes. If it runs
    // longer, treat the transfer as failed rather than extending the operation timeout.
    private static final long BES_TOTAL_TIMEOUT_MS = 300000;
    private static final long BES_AUTH_TIMEOUT_MS = 30000; // 30 seconds authorization timeout
    private static final long BES_AUTH_RECOVERY_PROBE_INTERVAL_MS = 1000;
    private static final int BES_AUTH_RECOVERY_PROBE_MAX_ATTEMPTS = 3;
    private static final long BES_POST_APPLY_VERIFICATION_TIMEOUT_MS = 60_000;
    private Context mContext;

    private long operationStartTime = 0;
    private android.os.Handler authTimeoutHandler;
    private Runnable authTimeoutRunnable;

    // Dead-man watchdog for the response-driven transfer: every inbound OTA response
    // re-arms it. If it fires, the transfer is aborted through the normal failure path
    // (createFailed + cleanup) - no resume, no retry: an aborted transfer leaves the BES
    // on its current firmware and the phone re-runs the whole OTA. Without this, a single
    // lost response (device slept mid-transfer, BES crash, UART drop) stalls the state
    // machine silently forever (2026-07-08 incident: frozen at 80%, no further log line).
    // Serializes the watchdog's decide+abort with receive processing: both run inside
    // this monitor, so either the timeout aborts BEFORE a response enters the state
    // machine (the response then sees the transfer inactive and stops), or the response
    // wins, re-arms, and the already-dispatched timeout callback re-checks the deadline
    // under the same monitor and stands down. The interleaving "callback reads expired
    // deadline, response re-arms and continues, callback still aborts mid-processing"
    // is structurally impossible.
    private final Object mTransferGate = new Object();

    private android.os.Handler responseWatchdogHandler;
    private Runnable responseWatchdogRunnable;
    // Absolute deadline (elapsedRealtime) of the current watchdog window. The re-arm from
    // the UART receive thread cannot removeCallbacks() a callback that has ALREADY been
    // dispatched on the main looper; the dispatched callback re-checks this deadline and
    // aborts only if no response re-armed it in the meantime, so a response racing the
    // timeout can never produce a false failure while its handler is mid-flight.
    private volatile long responseWatchdogDeadlineMs;

    private String filePath;
    private boolean bInit = false;
    private byte[] fileData = null;
    private int fileLen = 0;
    private int sentPos = 0;
    private int curSentLen = 0;
    private int confirmTimes = 0;
    private int confirmSentPos = 0;
    private boolean bWait4Confirm = false;
    private volatile boolean isWaitingForAuthorization = false;
    private boolean authorizationAttempted = false;
    private boolean authorizationRecoveryProbePending = false;
    private int authorizationRecoveryProbeAttempts = 0;
    private android.os.Handler authorizationRecoveryProbeHandler;
    private Runnable authorizationRecoveryProbeRunnable;
    private android.os.Handler postApplyVerificationHandler;
    private Runnable postApplyVerificationRunnable;
    private boolean awaitingPostApplyVerification = false;
    private String expectedTargetVersion = "";
    private String expectedOtaSessionId = "";
    // Every callback created by one OTA run captures this token. Handler.removeCallbacks() cannot
    // retract work that is already dispatched, so the token is the final ownership check before a
    // delayed callback is allowed to mutate the next run.
    private long nextRunGeneration = 0;
    private long activeRunGeneration = 0;

    private final Runnable otaAppliedCallback;
    private final BesOtaAuthorizationGate authorizationGate;
    private final BesUartTransportCoordinator transportCoordinator;
    private BesUartTransportCoordinator.OperationLease transportLease;
    private BesOtaCommandListener mListener;
    private final K900BluetoothManager k900BluetoothManager;

    /**
     * @param otaAppliedCallback notified after BES accepts the image and begins rebooting
     * @param k900BluetoothManager owner of the ordered K900 outbound queue
     * @param context Application context for wakelock
     */
    public BesOtaManager(
            Runnable otaAppliedCallback,
            K900BluetoothManager k900BluetoothManager,
            Context context) {
        this(otaAppliedCallback, k900BluetoothManager, context, null);
    }

    BesOtaManager(
            Runnable otaAppliedCallback,
            K900BluetoothManager k900BluetoothManager,
            Context context,
            BesOtaAuthorizationGate authorizationGateOverride) {
        this.otaAppliedCallback = otaAppliedCallback;
        this.k900BluetoothManager = k900BluetoothManager;
        this.transportCoordinator =
                k900BluetoothManager != null
                        ? k900BluetoothManager.getTransportCoordinator()
                        : null;
        this.mContext = context.getApplicationContext();
        BesOtaAuthorizationGate sharedGate =
                k900BluetoothManager != null
                        ? k900BluetoothManager.getBesOtaAuthorizationGate()
                        : null;
        this.authorizationGate =
                authorizationGateOverride != null
                        ? authorizationGateOverride
                        : sharedGate != null
                                ? sharedGate
                                : new BesOtaAuthorizationGate(this.mContext);
        if (authorizationGate.isPostApplyVerificationPendingForCurrentBoot()) {
            activeRunGeneration = ++nextRunGeneration;
            awaitingPostApplyVerification = true;
            expectedTargetVersion = authorizationGate.getExpectedTargetVersion();
            expectedOtaSessionId = authorizationGate.getOtaSessionId();
            isBesOtaInProgress = true;
            armPostApplyVerificationTimeoutLocked();
        }
    }

    /**
     * @return true if a BES OTA update is currently in progress
     */
    @Override
    public boolean isBesOtaInProgress() {
        return isBesOtaInProgress;
    }

    /**
     * Get current firmware version from BES device
     *
     * @return byte array with [major, minor, patch, build] or null if not available
     */
    @Override
    public byte[] getCurrentFirmwareVersion() {
        return sCurrentFirmwareVersion;
    }

    /**
     * Convert server version code (long) to BES firmware version format (byte array) Server version
     * format: XYYYYZZ where X=major, Y=minor, Z=patch BES format: [major, minor, patch, build]
     *
     * @param versionCode Server version code
     * @return byte array [major, minor, patch, build]
     */
    @Override
    public byte[] parseServerVersionCode(long versionCode) {
        int major = (int) (versionCode / 1000000);
        int minor = (int) ((versionCode / 1000) % 1000);
        int patch = (int) (versionCode % 1000);
        int build = 0; // Build not specified in version code

        return new byte[] {(byte) major, (byte) minor, (byte) patch, (byte) build};
    }

    /**
     * Compare two BES firmware versions
     *
     * @param v1 First version
     * @param v2 Second version
     * @return true if v1 is newer than v2, false otherwise
     */
    @Override
    public boolean isNewerVersion(byte[] v1, byte[] v2) {
        if (v1 == null || v2 == null || v1.length < 4 || v2.length < 4) {
            return false;
        }

        // Compare major.minor.patch.build
        for (int i = 0; i < 4; i++) {
            int b1 = v1[i] & 0xFF;
            int b2 = v2[i] & 0xFF;
            if (b1 > b2) return true;
            if (b1 < b2) return false;
        }
        return false;
    }

    public void registerCmdListener(BesOtaCommandListener listener) {
        mListener = listener;
    }

    /**
     * Query current firmware version from BES device (without starting OTA) This sends
     * GET_FIRMWARE_VERSION command and waits for response Response is stored in
     * sCurrentFirmwareVersion
     *
     * @return true if request sent successfully
     */
    public boolean queryFirmwareVersion() {
        if (transportCoordinator == null) {
            Log.e(TAG, "Cannot query firmware version - UART coordinator is null");
            return false;
        }

        if (isBesOtaInProgress) {
            Log.w(TAG, "Cannot query firmware version - OTA in progress");
            return false;
        }

        BesCmd_GetFirmwareVersion cmd = new BesCmd_GetFirmwareVersion();
        byte[] data = cmd.getSendData();

        if (data != null) {
            Log.d(TAG, "Querying current firmware version...");
            return transportCoordinator.writeRawControl(data);
        }
        return false;
    }

    /**
     * Callback for firmware version response (outside OTA context) This is called directly from
     * K900BluetoothManager's normal UART handling
     */
    public void onFirmwareVersionReceived(byte[] data, int size) {
        // Parse the firmware version from raw data
        if (size > 9) {
            if (BesOtaUtil.isMagicCodeValid(data, 0, 4)) {
                byte[] firmware = BesOtaUtil.getFirmwareVersion(data, 5, 4);
                if (firmware != null) {
                    sCurrentFirmwareVersion = firmware;
                    Log.i(
                            TAG,
                            "Current firmware version queried: "
                                    + (firmware[0] & 0xFF)
                                    + "."
                                    + (firmware[1] & 0xFF)
                                    + "."
                                    + (firmware[2] & 0xFF)
                                    + "."
                                    + (firmware[3] & 0xFF));
                }
            }
        }
    }

    /**
     * Initialize firmware file and prepare for OTA
     *
     * @param filePath Path to firmware .bin file
     * @return true if initialized successfully, false otherwise
     */
    public boolean init(String filePath) {
        Log.i(TAG, "🔧 Initializing BES OTA with file: " + filePath);
        this.filePath = filePath;
        bInit = false;
        File f = new File(this.filePath);
        if (!f.exists()) {
            Log.e(TAG, "❌ BES firmware file not exist: " + this.filePath);
            return false;
        }
        Log.d(TAG, "✅ File exists, size: " + f.length() + " bytes");
        try {
            fileLen = (int) f.length();
            FileInputStream inputStream = new FileInputStream(filePath);
            Log.d(TAG, "📥 Loading firmware into memory, size=" + fileLen + " bytes");
            fileData = new byte[fileLen];
            int bytesRead = inputStream.read(fileData, 0, fileLen);
            inputStream.close();
            Log.i(TAG, "✅ Firmware loaded into memory: " + bytesRead + " bytes");

            // Calculate and log CRC32 for debugging
            long crc32 = BesOtaUtil.crc32(fileData, 0, fileLen);
            Log.i(TAG, "========== BesOtaManager CRC32 Debug ==========");
            Log.i(TAG, "Firmware CRC32 (decimal): " + crc32);
            Log.i(TAG, "Firmware CRC32 (hex): 0x" + String.format("%08X", crc32));
            Log.i(TAG, "================================================");

            bInit = true;
            if (fileLen > BesOtaUtil.MAX_FILE_SIZE) {
                Log.e(
                        TAG,
                        "❌ BES firmware file too big, len="
                                + fileLen
                                + " (max: "
                                + BesOtaUtil.MAX_FILE_SIZE
                                + ")");
                return false;
            }
            Log.i(
                    TAG,
                    "✅ BES firmware initialization complete - ready to transmit "
                            + fileLen
                            + " bytes");
            return true;
        } catch (FileNotFoundException e) {
            Log.e(TAG, "❌ BES firmware file not found", e);
        } catch (IOException e) {
            Log.e(TAG, "❌ Error reading BES firmware file", e);
        }
        return false;
    }

    /**
     * Start firmware update process
     *
     * @param filePath Path to firmware .bin file
     * @return true if started successfully
     */
    @Override
    public boolean startFirmwareUpdate(
            String filePath, String expectedVersion, String otaSessionId) {
        synchronized (mTransferGate) {
            if (isBesOtaInProgress || isWaitingForAuthorization) {
                Log.e(TAG, "BES OTA is already active");
                return false;
            }
            String owner = otaSessionId == null ? "" : otaSessionId.trim();
            String runOwner = owner.isEmpty() ? "standalone-" + UUID.randomUUID() : owner;
            String target = BesOtaAuthorizationGate.canonicalExactTargetVersion(expectedVersion);
            if (target == null) {
                postFailureForOwner(
                        runOwner,
                        "BES OTA requires an exact target version for reboot verification");
                return false;
            }
            expectedOtaSessionId = runOwner;
            expectedTargetVersion = target;
            activeRunGeneration = ++nextRunGeneration;
            return startFirmwareUpdateLocked(filePath);
        }
    }

    private boolean startFirmwareUpdateLocked(String filePath) {
        Log.i(TAG, "startFirmwareUpdate: " + filePath);

        if (authorizationGate.isRetryBlockedThisBoot()) {
            Log.e(TAG, "BES OTA retry blocked until the glasses reboot and UART is proven again");
            postFailure("BES OTA retry blocked until glasses reboot");
            return false;
        }

        if (!init(filePath)) {
            Log.e(TAG, "Failed to initialize firmware update");
            postFailure("Failed to initialize BES firmware update");
            return false;
        }

        // The transfer needs the vendor "screen on" state, not just CPU: the display-sleep
        // hook wedges the UART transfer state machine mid-flight even with a CPU lock held
        // (2026-07-08 incident, frozen between segments at 80%). Hold BOTH leases; the
        // initial window covers authorization + handshake, then confirmed segments re-arm
        // them (see crc32ConfirmSuccess).
        WakeLockManager.acquireFull(
                mContext,
                WakeLockManager.WakeOwner.BES_OTA,
                WAKELOCK_TIMEOUT_MS,
                WAKELOCK_TIMEOUT_MS);
        lastLeaseArmMs = android.os.SystemClock.elapsedRealtime();
        Log.i(TAG, "BES OTA cpu+screen leases acquired for " + WAKELOCK_TIMEOUT_MS + "ms");

        // Set waiting for authorization flag (NOT in OTA mode yet!)
        isWaitingForAuthorization = true;
        isBesOtaInProgress = true;

        // DO NOT enable OTA mode yet - wait for authorization
        // DO NOT set fast mode yet - wait for authorization

        // Emit started event (for internal state management, not sent to phone)
        EventBus.getDefault().post(BesOtaProgressEvent.createStarted(fileLen));

        operationStartTime = android.os.SystemClock.elapsedRealtime();

        // STEP 1: Request authorization from the ordered K900 transport.
        Log.i(TAG, "Requesting BES OTA authorization from BES chip");

        if (k900BluetoothManager != null) {
            byte[] authorizationRequest = buildAuthorizationRequest();
            final long runGeneration = activeRunGeneration;
            boolean queued =
                    authorizationRequest != null
                            && k900BluetoothManager.queueBesOtaAuthorization(
                                    authorizationRequest,
                                    new K900BluetoothManager.BesOtaAuthorizationCallback() {
                                        @Override
                                        public boolean onLeaseAcquired(
                                                BesUartTransportCoordinator.OperationLease lease) {
                                            synchronized (mTransferGate) {
                                                if (!isCurrentRunLocked(runGeneration)
                                                        || !isWaitingForAuthorization) {
                                                    return false;
                                                }
                                                transportLease = lease;
                                                authorizationAttempted =
                                                        authorizationGate.tryReserveCurrentBoot(
                                                                expectedTargetVersion,
                                                                expectedOtaSessionId);
                                                return authorizationAttempted;
                                            }
                                        }

                                        @Override
                                        public void onWriteComplete(
                                                boolean attempted, boolean success) {
                                            onAuthorizationWriteComplete(
                                                    runGeneration, attempted, success);
                                        }
                                    });
            if (queued) {
                return true;
            }
            Log.e(TAG, "Failed to queue BES OTA authorization request");
            postFailure("Failed to send BES OTA authorization request");
            cleanup();
            return false;
        } else {
            Log.e(TAG, "K900 Bluetooth manager unavailable - cannot send authorization request");
            postFailure("K900 Bluetooth manager not available");
            cleanup();
            return false;
        }
    }

    private byte[] buildAuthorizationRequest() {
        try {
            JSONObject command = new JSONObject();
            command.put("C", "mh_ota");
            command.put("V", 1);
            command.put("B", "{}");
            return command.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.e(TAG, "Failed to build BES OTA authorization request", e);
            return null;
        }
    }

    /** Preserve detailed diagnostics; the terminal wire encoder reduces them to install_failed. */
    private void postFailure(String diagnostic) {
        postFailureForRun(activeRunGeneration, expectedOtaSessionId, diagnostic);
    }

    private void postFailureForRun(long runGeneration, String owner, String diagnostic) {
        if (!isCurrentRunLocked(runGeneration)) {
            Log.w(TAG, "Ignoring BES failure from superseded run " + runGeneration);
            return;
        }
        postFailureForOwner(owner, diagnostic);
    }

    private void postFailureForOwner(String owner, String diagnostic) {
        if (owner == null || owner.trim().isEmpty()) {
            Log.e(TAG, "Cannot publish BES failure without an owning OTA session");
            return;
        }
        // New-session admission and this write use the same process-wide lock. An old manager or an
        // already-dispatched callback can still emit its owner-bound live event, but it can never
        // replace the durable terminal handoff after a newer phone session has been admitted.
        if (!new OtaSessionManager(mContext).persistBesFailureForSession(owner, diagnostic)) {
            Log.w(
                    TAG,
                    "Could not durably persist BES failure for OTA session "
                            + owner
                            + "; the owner is no longer current or storage failed");
        }
        EventBus.getDefault().post(BesOtaProgressEvent.createFailed(owner, diagnostic));
    }

    void onAuthorizationWriteComplete(boolean attempted, boolean success) {
        onAuthorizationWriteComplete(activeRunGeneration, attempted, success);
    }

    void onAuthorizationWriteComplete(long runGeneration, boolean attempted, boolean success) {
        synchronized (mTransferGate) {
            if (!isCurrentRunLocked(runGeneration) || !isWaitingForAuthorization) {
                return;
            }
            if (!attempted) {
                postFailure("BES UART was not ready for authorization");
                cleanupLocked();
                return;
            }

            if (!success) {
                Log.w(
                        TAG,
                        "BES OTA authorization write reported failure; outcome is ambiguous, "
                                + "retaining the UART lease and waiting for hm_ota");
            }

            authTimeoutHandler = new android.os.Handler(android.os.Looper.getMainLooper());
            final long timeoutRunGeneration = runGeneration;
            authTimeoutRunnable =
                    () -> {
                        synchronized (mTransferGate) {
                            if (!isCurrentRunLocked(timeoutRunGeneration)
                                    || !isWaitingForAuthorization) {
                                return;
                            }
                            Log.e(
                                    TAG,
                                    "BES OTA authorization timeout after "
                                            + BES_AUTH_TIMEOUT_MS
                                            + "ms");
                            authTimeoutHandler = null;
                            authTimeoutRunnable = null;
                            beginAuthorizationRecoveryProbeLocked();
                        }
                    };
            authTimeoutHandler.postDelayed(authTimeoutRunnable, BES_AUTH_TIMEOUT_MS);
        }
    }

    /**
     * Reconcile a missing framed {@code hm_ota} without repeating the mode-changing {@code mh_ota}.
     * The raw 0x99 query is read-only and idempotent in OTA mode. In normal K900 mode its five
     * bytes contain no frame marker, so the framed parser discards them as junk and remains usable.
     */
    private void beginAuthorizationRecoveryProbeLocked() {
        if (transportCoordinator == null
                || !transportCoordinator.promoteOtaAuthorizationToTransfer(transportLease)) {
            Log.e(TAG, "Could not promote UART for BES OTA state reconciliation");
            postFailure("BES chip did not respond to authorization request");
            cleanupLocked();
            return;
        }

        Log.w(TAG, "hm_ota missing; probing the read-only raw OTA protocol before aborting");
        isWaitingForAuthorization = false;
        authorizationRecoveryProbePending = true;
        authorizationRecoveryProbeAttempts = 0;
        sendNextAuthorizationRecoveryProbeLocked();
    }

    private void sendNextAuthorizationRecoveryProbeLocked() {
        if (!authorizationRecoveryProbePending) {
            return;
        }
        if (authorizationRecoveryProbeAttempts >= BES_AUTH_RECOVERY_PROBE_MAX_ATTEMPTS) {
            Log.e(
                    TAG,
                    "BES did not answer "
                            + BES_AUTH_RECOVERY_PROBE_MAX_ATTEMPTS
                            + " raw OTA state probes");
            // mh_ota is mode-changing and has no transaction id. It may have been accepted even
            // though neither its framed acknowledgement nor a raw reply returned. Switching
            // parsers again or resending mh_ota would be a guess that can write framed bytes into
            // BES OTA mode. A full glasses reboot is the only deterministic recovery.
            postFailure("BES OTA state could not be reconciled; reboot glasses before retrying");
            cleanupLocked();
            return;
        }

        authorizationRecoveryProbeAttempts++;
        byte[] probe = SCmd_GetProtocolVersion();
        boolean sent = send(probe);
        Log.w(
                TAG,
                "BES raw OTA state probe "
                        + authorizationRecoveryProbeAttempts
                        + "/"
                        + BES_AUTH_RECOVERY_PROBE_MAX_ATTEMPTS
                        + " writeResult="
                        + sent);

        authorizationRecoveryProbeHandler =
                new android.os.Handler(android.os.Looper.getMainLooper());
        final long probeRunGeneration = activeRunGeneration;
        authorizationRecoveryProbeRunnable =
                () -> {
                    synchronized (mTransferGate) {
                        if (!isCurrentRunLocked(probeRunGeneration)) {
                            return;
                        }
                        sendNextAuthorizationRecoveryProbeLocked();
                    }
                };
        authorizationRecoveryProbeHandler.postDelayed(
                authorizationRecoveryProbeRunnable, BES_AUTH_RECOVERY_PROBE_INTERVAL_MS);
    }

    private void cancelAuthorizationRecoveryProbeLocked() {
        if (authorizationRecoveryProbeHandler != null
                && authorizationRecoveryProbeRunnable != null) {
            authorizationRecoveryProbeHandler.removeCallbacks(authorizationRecoveryProbeRunnable);
        }
        authorizationRecoveryProbeHandler = null;
        authorizationRecoveryProbeRunnable = null;
        authorizationRecoveryProbePending = false;
        authorizationRecoveryProbeAttempts = 0;
    }

    private void armPostApplyVerificationTimeoutLocked() {
        if (postApplyVerificationHandler != null && postApplyVerificationRunnable != null) {
            postApplyVerificationHandler.removeCallbacks(postApplyVerificationRunnable);
        }
        postApplyVerificationHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        final long verificationRunGeneration = activeRunGeneration;
        postApplyVerificationRunnable =
                () -> {
                    synchronized (mTransferGate) {
                        if (!isCurrentRunLocked(verificationRunGeneration)
                                || !awaitingPostApplyVerification) {
                            return;
                        }
                        Log.e(TAG, "Timed out waiting for BES post-reboot target-version readback");
                        String diagnostic =
                                "BES rebooted but target version could not be verified; reboot glasses";
                        BesUartTransportCoordinator.PostApplyFailureResolution abandonment =
                                transportCoordinator != null
                                        ? transportCoordinator.resolvePostApplyFailure(diagnostic)
                                        : authorizationGate.abandonPostApplyVerification(
                                                diagnostic);
                        if (abandonment
                                == BesUartTransportCoordinator.PostApplyFailureResolution
                                        .ALREADY_RESOLVED) {
                            Log.i(
                                    TAG,
                                    "BES verification resolved while its timeout was dispatched");
                            finishPostApplyVerificationLocked();
                            return;
                        }
                        if (abandonment
                                == BesUartTransportCoordinator.PostApplyFailureResolution
                                        .PERSISTENCE_FAILURE) {
                            Log.e(TAG, "Could not durably record BES verification timeout");
                        }
                        postFailure(diagnostic);
                        finishPostApplyVerificationLocked();
                    }
                };
        postApplyVerificationHandler.postDelayed(
                postApplyVerificationRunnable, BES_POST_APPLY_VERIFICATION_TIMEOUT_MS);
    }

    private void beginPostApplyVerificationLocked() {
        awaitingPostApplyVerification = true;
        isWaitingForAuthorization = false;
        cancelAuthorizationRecoveryProbeLocked();
        if (responseWatchdogHandler != null && responseWatchdogRunnable != null) {
            responseWatchdogHandler.removeCallbacks(responseWatchdogRunnable);
            responseWatchdogRunnable = null;
        }
        responseWatchdogDeadlineMs = 0;
        operationStartTime = 0;
        synchronized (mLeaseGate) {
            WakeLockManager.release(WakeLockManager.WakeOwner.BES_OTA);
        }
        bInit = false;
        fileData = null;
        sentPos = 0;
        confirmTimes = 0;
        transportLease = null;
        armPostApplyVerificationTimeoutLocked();
        if (otaAppliedCallback != null) {
            otaAppliedCallback.run();
        }
    }

    private void finishPostApplyVerificationLocked() {
        if (postApplyVerificationHandler != null && postApplyVerificationRunnable != null) {
            postApplyVerificationHandler.removeCallbacks(postApplyVerificationRunnable);
        }
        postApplyVerificationHandler = null;
        postApplyVerificationRunnable = null;
        awaitingPostApplyVerification = false;
        authorizationAttempted = false;
        expectedTargetVersion = "";
        expectedOtaSessionId = "";
        activeRunGeneration = 0;
        synchronized (mLeaseGate) {
            isBesOtaInProgress = false;
            WakeLockManager.release(WakeLockManager.WakeOwner.BES_OTA);
        }
    }

    /**
     * Abort any in-flight BES OTA and release its resources (wakelock, UART fast mode, state). Safe
     * to call when no update is running. Used during service teardown so a dropped manager handle
     * does not leak an active update.
     */
    public void abortIfInProgress() {
        if (isBesOtaInProgress || isWaitingForAuthorization) {
            Log.w(TAG, "Aborting in-flight BES OTA during cleanup");
            cleanup();
        }
    }

    /** Cleanup and reset state */
    private void cleanup() {
        // Every terminal path funnels here, gated or not (watchdog and receive dispatch
        // hold mTransferGate; abortIfInProgress and the auth failure paths do not).
        // Taking the gate here - reentrant for the former - serializes ALL cleanups with
        // receive processing and the watchdog re-arm, so no caller can tear the watchdog
        // state down mid-rearm on another thread.
        synchronized (mTransferGate) {
            cleanupLocked();
        }
    }

    private void cleanupLocked() {
        // Cancel authorization timeout if pending
        if (authTimeoutHandler != null && authTimeoutRunnable != null) {
            authTimeoutHandler.removeCallbacks(authTimeoutRunnable);
            authTimeoutHandler = null;
            authTimeoutRunnable = null;
        }
        cancelAuthorizationRecoveryProbeLocked();
        if (postApplyVerificationHandler != null && postApplyVerificationRunnable != null) {
            postApplyVerificationHandler.removeCallbacks(postApplyVerificationRunnable);
            postApplyVerificationHandler = null;
            postApplyVerificationRunnable = null;
        }

        // Cancel the response watchdog; cleanup is the single funnel for every terminal
        // path (apply success, CRC failure, watchdog abort), so no timer outlives the run.
        if (responseWatchdogHandler != null && responseWatchdogRunnable != null) {
            responseWatchdogHandler.removeCallbacks(responseWatchdogRunnable);
            responseWatchdogRunnable = null;
        }
        responseWatchdogDeadlineMs = 0;

        operationStartTime = 0;

        // Flag-clear and lease release are one atomic step against the segment-confirm
        // re-arm (see mLeaseGate): after this block no stale confirm can re-acquire.
        synchronized (mLeaseGate) {
            isBesOtaInProgress = false;
            WakeLockManager.release(WakeLockManager.WakeOwner.BES_OTA);
        }
        Log.i(TAG, "BES OTA wakelock released");
        isWaitingForAuthorization = false;
        if (transportCoordinator != null) {
            if (authorizationAttempted) {
                Log.w(TAG, "Quarantining BES UART until glasses reboot after OTA failure");
                if (!transportCoordinator.quarantineOta(transportLease)) {
                    Log.e(TAG, "Failed to apply in-memory BES UART quarantine");
                }
            } else {
                transportCoordinator.endOta(transportLease);
            }
        }
        transportLease = null;
        authorizationAttempted = false;
        bInit = false;
        fileData = null;
        sentPos = 0;
        confirmTimes = 0;
        expectedTargetVersion = "";
        expectedOtaSessionId = "";
        activeRunGeneration = 0;
    }

    /**
     * Called when BES chip grants OTA authorization This is the trigger to actually start the OTA
     * protocol
     */
    @Override
    public void onAuthorizationGranted() {
        synchronized (mTransferGate) {
            if (!isWaitingForAuthorization) {
                Log.w(TAG, "Received authorization but not waiting for it");
                return;
            }

            if (!transportCoordinator.promoteOtaAuthorizationToTransfer(transportLease)) {
                Log.e(TAG, "Could not promote UART to BES OTA transfer mode");
                postFailure("BES UART is no longer ready");
                cleanupLocked();
                return;
            }

            Log.i(TAG, "BES OTA authorization GRANTED - starting protocol");
            isWaitingForAuthorization = false;
            cancelAuthorizationRecoveryProbeLocked();
            rearmResponseWatchdog();

            // Cancel authorization timeout
            if (authTimeoutHandler != null && authTimeoutRunnable != null) {
                authTimeoutHandler.removeCallbacks(authTimeoutRunnable);
                authTimeoutHandler = null;
                authTimeoutRunnable = null;
            }

            byte[] data = SCmd_GetProtocolVersion();
            Log.d(
                    TAG,
                    "Sending GetProtocolVersion command, data="
                            + (data != null
                                    ? ByteUtil.outputHexString(data, 0, data.length)
                                    : "null"));
            if (send(data)) {
                Log.i(TAG, "BES OTA protocol started successfully");
            } else {
                Log.e(TAG, "Failed to send first protocol command");
                postFailure("Failed to start protocol");
                cleanupLocked();
            }
        }
    }

    /** Called when BES chip denies OTA authorization */
    @Override
    public void onAuthorizationDenied() {
        synchronized (mTransferGate) {
            Log.e(TAG, "BES OTA authorization DENIED by BES chip");
            if (authTimeoutHandler != null && authTimeoutRunnable != null) {
                authTimeoutHandler.removeCallbacks(authTimeoutRunnable);
                authTimeoutHandler = null;
                authTimeoutRunnable = null;
            }
            if (authorizationGate.clear()) {
                authorizationAttempted = false;
            } else {
                Log.e(TAG, "Could not durably clear the BES OTA authorization reservation");
            }
            postFailure("BES chip denied OTA authorization");
            cleanupLocked();
        }
    }

    // ========== Protocol Commands ==========

    public byte[] SCmd_GetProtocolVersion() {
        if (!bInit) return null;
        BesCmd_GetProtocolVersion cmd = new BesCmd_GetProtocolVersion();
        return cmd.getSendData();
    }

    public byte[] SCmd_SetUser() {
        if (!bInit) return null;
        BesCmd_SetUser cmd = new BesCmd_SetUser();
        return cmd.getSendData();
    }

    public byte[] SCmd_GetFirmwareVersion() {
        if (!bInit) return null;
        BesCmd_GetFirmwareVersion cmd = new BesCmd_GetFirmwareVersion();
        return cmd.getSendData();
    }

    public byte[] SCmd_SelectSide() {
        if (!bInit) return null;
        BesCmd_SelectSide cmd = new BesCmd_SelectSide();
        return cmd.getSendData();
    }

    public byte[] SCmd_CheckBreakPoint() {
        if (!bInit) return null;
        BesCmd_CheckBreakpoint cmd = new BesCmd_CheckBreakpoint();
        return cmd.getSendData();
    }

    public byte[] SCmd_SetStartInfo() {
        if (!bInit) return null;
        BesCmd_SetStartInfo cmd = new BesCmd_SetStartInfo();
        if (!cmd.setFilePath(filePath)) {
            return null;
        }
        return cmd.getSendData();
    }

    public byte[] SCmd_SetConfig(
            boolean bClearUserData,
            String btName,
            String bleName,
            String btAddress,
            String bleAddress) {
        if (!bInit) return null;
        BesCmd_SetConfig cmd = new BesCmd_SetConfig();
        cmd.setClearUserData(bClearUserData);
        if (btName != null && btName.length() > 0) cmd.setUpdateBtName(true, btName);
        if (bleName != null && bleName.length() > 0) cmd.setUpdateBleName(true, bleName);
        if (btAddress != null && btAddress.length() > 0) cmd.setUpdateBtAddress(true, btAddress);
        if (bleAddress != null && bleAddress.length() > 0)
            cmd.setUpdateBleAddress(true, bleAddress);
        if (!cmd.setFilePath(filePath)) {
            return null;
        }
        bWait4Confirm = false;
        return cmd.getSendData();
    }

    public byte[] SCmd_SendFileData() {
        if (!bInit) {
            Log.e(TAG, "❌ SCmd_SendFileData called but not initialized");
            return null;
        }
        BesCmd_SendData cmd = new BesCmd_SendData();
        int len = curSentLen;
        if (len > 0) {
            byte[] data = new byte[len];
            System.arraycopy(fileData, sentPos, data, 0, len);
            cmd.setFileData(data);
            return cmd.getSendData();
        }
        Log.w(TAG, "⚠️ curSentLen is 0 - no data to send");
        return null;
    }

    public void addSentSize(int size) {
        sentPos += size;
    }

    // Deadline of the last lease re-arm; segment confirms arrive ~1/s, so re-arm at most
    // every half window to avoid per-segment lock churn and wake_extend trace spam.
    private long lastLeaseArmMs = 0;

    // Serializes the transfer's lease lifecycle: a UART segment-confirm that passed the
    // isBesOtaInProgress check must not interleave with cleanup() releasing the leases,
    // or it would re-acquire protection nothing will ever release.
    private final Object mLeaseGate = new Object();

    public void crc32ConfirmSuccess() {
        confirmTimes++;
        confirmSentPos = sentPos;
        bWait4Confirm = false;
        // Progress-coupled lease: while segments keep confirming, the transfer's wake
        // protection never expires; a wedged transfer stops re-arming and the device may
        // sleep once the window runs out. Gated on isBesOtaInProgress so a late UART
        // segment-verify arriving after cleanup() cannot re-acquire leases nothing will
        // ever release.
        long nowMs = android.os.SystemClock.elapsedRealtime();
        synchronized (mLeaseGate) {
            if (isBesOtaInProgress
                    && nowMs - lastLeaseArmMs > AsgConstants.BES_OTA_SEGMENT_LEASE_WINDOW_MS / 2) {
                lastLeaseArmMs = nowMs;
                WakeLockManager.acquireFull(
                        mContext,
                        WakeLockManager.WakeOwner.BES_OTA,
                        AsgConstants.BES_OTA_SEGMENT_LEASE_WINDOW_MS,
                        AsgConstants.BES_OTA_SEGMENT_LEASE_WINDOW_MS);
            }
        }
        Log.i(
                TAG,
                "✅ CRC32 verification successful - confirmTimes="
                        + confirmTimes
                        + ", confirmed "
                        + confirmSentPos
                        + "/"
                        + fileLen
                        + " bytes");
    }

    public int getConfirmLength() {
        return confirmSentPos;
    }

    public int getTotalLength() {
        return fileLen;
    }

    public boolean isSentFinish() {
        return confirmSentPos == fileLen;
    }

    public boolean isNeedSegmentVerify() {
        if (bWait4Confirm) {
            Log.d(TAG, "⏳ Waiting for segment verification confirmation");
            return true;
        }
        int minSize = Math.min(BesOtaUtil.SEGMENT_SIZE * (confirmTimes + 1), fileLen);
        if (sentPos + BesOtaUtil.PACKET_SIZE >= minSize) {
            curSentLen = minSize - sentPos;
            bWait4Confirm = true;
            Log.i(
                    TAG,
                    "🔍 Segment boundary reached - requesting verification (segment "
                            + (confirmTimes + 1)
                            + ", size="
                            + curSentLen
                            + " bytes)");
        } else {
            curSentLen = BesOtaUtil.PACKET_SIZE;
        }
        return false;
    }

    public byte[] SCmd_SegmentVerify() {
        if (!bInit) return null;
        int srcPos = BesOtaUtil.SEGMENT_SIZE * confirmTimes;
        byte[] crcSegmentData = new byte[sentPos - srcPos];
        System.arraycopy(fileData, srcPos, crcSegmentData, 0, crcSegmentData.length);
        long crc32 = BesOtaUtil.crc32(crcSegmentData, 0, crcSegmentData.length);
        Log.i(
                TAG,
                "🔍 Computing segment CRC32 - segment="
                        + (confirmTimes + 1)
                        + ", srcPos="
                        + srcPos
                        + ", sentPos="
                        + sentPos
                        + ", segmentLen="
                        + crcSegmentData.length
                        + ", CRC32=0x"
                        + Long.toHexString(crc32).toUpperCase());
        byte[] crcBytes = BesOtaUtil.long2Bytes(crc32);
        Log.d(TAG, "🔍 CRC32 bytes: " + ByteUtil.outputHexString(crcBytes, 0, crcBytes.length));
        BesCmd_SegmentVerify cmd = new BesCmd_SegmentVerify();
        cmd.setSegmentCrc32(crcBytes);
        return cmd.getSendData();
    }

    public byte[] SCmd_FinshSend() {
        if (!bInit) return null;
        BesCmd_FinishSend cmd = new BesCmd_FinishSend();
        return cmd.getSendData();
    }

    public byte[] SCmd_OtaApply() {
        if (!bInit) return null;
        BesCmd_Apply cmd = new BesCmd_Apply();
        return cmd.getSendData();
    }

    // ========== Receive Parser ==========

    private static final int RECV_BUFFER_SIZE = 512;
    private byte[] recvBuffer = new byte[512];
    private int curRecvLen = 0;

    public BesOtaMessage parseRecv(byte[] data, int offset, int len) {
        if (data == null) return null;

        BesOtaMessage m = new BesOtaMessage();

        if (curRecvLen > 0) {
            // Continuation of previous packet
            m.cmd = recvBuffer[0];
            if (curRecvLen + len > RECV_BUFFER_SIZE) {
                Log.e(TAG, "Receive buffer overflow, curRecvLen=" + curRecvLen + ", len=" + len);
                m.error = true;
                curRecvLen = 0;
                return m;
            }
            System.arraycopy(data, offset, recvBuffer, curRecvLen, len);
            curRecvLen += len;
            if (curRecvLen < BesBaseCommand.MIN_LENGTH) {
                Log.d(TAG, "Receive incomplete, curRecvLen=" + curRecvLen);
                return null;
            }
            m.len = BesOtaUtil.bytes2Int(recvBuffer, 1, 4);

            if (m.len + BesBaseCommand.MIN_LENGTH == curRecvLen) {
                m.error = false;
                curRecvLen = 0;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(
                            recvBuffer, BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                return m;
            } else if (m.len + BesBaseCommand.MIN_LENGTH < curRecvLen) {
                // More bytes than expected - extract first message and log extra bytes
                int expectedLen = m.len + BesBaseCommand.MIN_LENGTH;
                int extraBytes = curRecvLen - expectedLen;
                Log.w(
                        TAG,
                        "Received "
                                + curRecvLen
                                + " bytes but expected "
                                + expectedLen
                                + " - extra "
                                + extraBytes
                                + " bytes will be ignored");
                Log.w(
                        TAG,
                        "Extra bytes: "
                                + ByteUtil.outputHexString(recvBuffer, expectedLen, extraBytes));
                m.error = false;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(
                            recvBuffer, BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                curRecvLen = 0;
                return m;
            } else if (curRecvLen > RECV_BUFFER_SIZE) {
                Log.e(
                        TAG,
                        "Receive error, curRecvLen="
                                + curRecvLen
                                + " exceeds buffer size "
                                + RECV_BUFFER_SIZE);
                m.error = true;
                curRecvLen = 0;
                return m;
            }
            return null;
        } else {
            // New packet
            if (len < BesBaseCommand.MIN_LENGTH) {
                System.arraycopy(data, offset, recvBuffer, 0, len);
                curRecvLen += len;
                return null;
            }
            m.cmd = data[0];
            m.len = BesOtaUtil.bytes2Int(data, 1, 4);
            if (m.len + BesBaseCommand.MIN_LENGTH == len) {
                m.error = false;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(
                            data, offset + BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                return m;
            } else if (m.len + BesBaseCommand.MIN_LENGTH < len) {
                // More bytes than expected - extract first message and log extra bytes
                int expectedLen = m.len + BesBaseCommand.MIN_LENGTH;
                int extraBytes = len - expectedLen;
                Log.w(
                        TAG,
                        "Received "
                                + len
                                + " bytes but expected "
                                + expectedLen
                                + " - extra "
                                + extraBytes
                                + " bytes will be ignored");
                Log.w(
                        TAG,
                        "Extra bytes: "
                                + ByteUtil.outputHexString(data, offset + expectedLen, extraBytes));
                m.error = false;
                if (m.len > 0) {
                    m.body = new byte[m.len];
                    System.arraycopy(
                            data, offset + BesBaseCommand.MIN_LENGTH, m.body, 0, m.body.length);
                }
                curRecvLen = 0;
                return m;
            } else if (len > RECV_BUFFER_SIZE) {
                Log.e(
                        TAG,
                        "Receive error, len=" + len + " exceeds buffer size " + RECV_BUFFER_SIZE);
                m.error = true;
                curRecvLen = 0;
                return m;
            } else {
                System.arraycopy(data, offset, recvBuffer, 0, len);
                curRecvLen = len;
                return null;
            }
        }
    }

    // ========== BesOtaUartListener Implementation ==========

    @Override
    public void onOtaRecv(byte[] data, int size) {
        // Reduced logging - only log errors and non-data-ack commands
        BesOtaMessage otaMsg = parseRecv(data, 0, size);
        if (otaMsg != null) {
            if (!otaMsg.error) {
                dealOtaRecvCmd(otaMsg);
            } else {
                Log.e(TAG, "Received error in OTA message");
            }
        }
    }

    @Override
    public void onBesPostApplyVerification(
            boolean success, String expectedVersion, String actualVersion, String diagnostic) {
        synchronized (mTransferGate) {
            boolean recoveredDuringStartup = !awaitingPostApplyVerification;
            if (!awaitingPostApplyVerification) {
                // K900 starts its serial reader before this listener is registered. After an ASG
                // process restart it can therefore verify and durably clear the pending target,
                // then deliver this one-shot result during registration. Accept that result even
                // though this manager never observed the apply acknowledgement itself.
                Log.i(TAG, "Accepting BES version verification recovered during manager startup");
                awaitingPostApplyVerification = true;
            }
            String durableOwner = authorizationGate.getOtaSessionId();
            if (durableOwner != null && !durableOwner.trim().isEmpty()) {
                expectedOtaSessionId = durableOwner;
            }
            if (success) {
                Log.i(TAG, "BES firmware update verified after reboot: " + actualVersion);
                EventBus.getDefault()
                        .post(BesOtaProgressEvent.createFinished(expectedOtaSessionId));
            } else {
                Log.e(
                        TAG,
                        "BES post-apply verification failed expected="
                                + expectedVersion
                                + " actual="
                                + actualVersion);
                // When K900 consumed the boot-B proof before this listener existed, the durable
                // gate owner is the generation boundary; there is deliberately no in-memory run
                // token to validate. Route that owner through the session guard directly. A live
                // run still uses its captured generation so a delayed callback cannot fail its
                // successor.
                if (recoveredDuringStartup) {
                    postFailureForOwner(expectedOtaSessionId, diagnostic);
                } else {
                    postFailure(diagnostic);
                }
            }
            finishPostApplyVerificationLocked();
        }
    }

    // ========== BesOtaCommandListener Implementation ==========

    @Override
    public void onParseResult(byte cmd, byte[] data) {
        // Callback for parsed commands (if needed)
        if (mListener != null) {
            mListener.onParseResult(cmd, data);
        }
    }

    // ========== Protocol State Machine ==========

    /**
     * (Re-)arm the response watchdog; called on transfer start and on every OTA response.
     * Package-private for the deterministic race tests in BesOtaResponseWatchdogTest.
     */
    void rearmResponseWatchdog() {
        if (!isBesOtaInProgress && !isWaitingForAuthorization) {
            return; // no stray timers after cleanup()
        }
        responseWatchdogDeadlineMs =
                android.os.SystemClock.elapsedRealtime() + AsgConstants.BES_OTA_RESPONSE_TIMEOUT_MS;
        if (responseWatchdogHandler == null) {
            responseWatchdogHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        }
        if (responseWatchdogRunnable != null) {
            responseWatchdogHandler.removeCallbacks(responseWatchdogRunnable);
        }
        final long watchdogRunGeneration = activeRunGeneration;
        Runnable watchdog =
                () -> {
                    synchronized (mTransferGate) {
                        if (!isCurrentRunLocked(watchdogRunGeneration) || !isBesOtaInProgress) {
                            return;
                        }
                        if (android.os.SystemClock.elapsedRealtime() < responseWatchdogDeadlineMs) {
                            return; // a response re-armed the window after this callback was
                            // dispatched
                        }
                        Log.e(
                                TAG,
                                "No BES OTA response for "
                                        + AsgConstants.BES_OTA_RESPONSE_TIMEOUT_MS
                                        + "ms - aborting transfer (sentPos="
                                        + sentPos
                                        + "/"
                                        + fileLen
                                        + ", confirmedSegments="
                                        + confirmTimes
                                        + ")");
                        try {
                            JSONObject extra = new JSONObject();
                            extra.put("sentPos", sentPos);
                            extra.put("fileLen", fileLen);
                            extra.put("confirmedSegments", confirmTimes);
                            BleTraceLogger.logLifecycle(
                                    mContext, "BesOtaManager", "bes_ota_response_timeout", extra);
                        } catch (Exception ignored) {
                            // Trace logging must never affect the abort itself.
                        }
                        postFailure(
                                "No response from BES for "
                                        + (AsgConstants.BES_OTA_RESPONSE_TIMEOUT_MS / 1000)
                                        + "s");
                        cleanup();
                    }
                };
        // Post the local reference: the field is only bookkeeping for removeCallbacks, so
        // a concurrent teardown nulling it can never turn this into postDelayed(null).
        responseWatchdogRunnable = watchdog;
        responseWatchdogHandler.postDelayed(watchdog, AsgConstants.BES_OTA_RESPONSE_TIMEOUT_MS);
    }

    private boolean isCurrentRunLocked(long runGeneration) {
        return runGeneration != 0 && runGeneration == activeRunGeneration;
    }

    private void dealOtaRecvCmd(BesOtaMessage msg) {
        synchronized (mTransferGate) {
            if (!isBesOtaInProgress && !isWaitingForAuthorization) {
                return; // the watchdog (or an abort) won the gate first - this response is stale
            }
            rearmResponseWatchdog();
            dealOtaRecvCmdLocked(msg);
        }
    }

    private void dealOtaRecvCmdLocked(BesOtaMessage msg) {
        if (msg == null) return;

        // Total operation timeout guard
        if (operationStartTime > 0
                && android.os.SystemClock.elapsedRealtime() - operationStartTime
                        > BES_TOTAL_TIMEOUT_MS) {
            Log.e(
                    TAG,
                    "BES firmware update timeout — chip may be unresponsive (elapsed: "
                            + (android.os.SystemClock.elapsedRealtime() - operationStartTime)
                            + "ms)");
            postFailure("BES firmware update timeout — chip may be unresponsive");
            cleanup();
            return;
        }

        // Only log non-data-ack commands to reduce spam (0x8B = data ack, very frequent)
        if (msg.cmd != BesProtocolConstants.RCMD_SEND_DATA) {
            Log.d(
                    TAG,
                    "dealOtaRecvCmd: cmd=0x"
                            + String.format("%02X", msg.cmd & 0xFF)
                            + ", len="
                            + msg.len);
        }

        if (msg.cmd == BesProtocolConstants.RCMD_GET_PROTOCOL_VERSION) {
            if (authorizationRecoveryProbePending) {
                Log.i(TAG, "Raw 0x9A response proves BES is already in OTA mode; continuing");
                cancelAuthorizationRecoveryProbeLocked();
            }
            byte[] data = SCmd_SetUser();
            Log.d(
                    TAG,
                    "Sending SetUser command, data="
                            + (data != null
                                    ? ByteUtil.outputHexString(data, 0, data.length)
                                    : "null"));
            send(data);
        } else if (msg.cmd == BesProtocolConstants.RCMD_SET_USER) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                byte[] data = SCmd_GetFirmwareVersion();
                Log.d(
                        TAG,
                        "Sending GetFirmwareVersion command, data="
                                + (data != null
                                        ? ByteUtil.outputHexString(data, 0, data.length)
                                        : "null"));
                send(data);
            } else {
                Log.e(TAG, "Set user type error");
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_GET_FIRMWARE_VERSION) {
            Log.d(TAG, "Received firmware version, len=" + msg.len);
            if (msg.len > 9 && msg.body != null) {
                if (BesOtaUtil.isMagicCodeValid(msg.body, 0, 4)) {
                    byte[] firmware = BesOtaUtil.getFirmwareVersion(msg.body, 5, 4);
                    if (firmware != null) {
                        // Store current firmware version for comparison
                        sCurrentFirmwareVersion = firmware;
                        Log.i(
                                TAG,
                                "Current firmware version: "
                                        + firmware[0]
                                        + "."
                                        + firmware[1]
                                        + "."
                                        + firmware[2]
                                        + "."
                                        + firmware[3]);
                    }
                    byte[] data = SCmd_SelectSide();
                    Log.d(
                            TAG,
                            "Sending SelectSide command, data="
                                    + (data != null
                                            ? ByteUtil.outputHexString(data, 0, data.length)
                                            : "null"));
                    send(data);
                } else {
                    Log.e(TAG, "Invalid magic code in firmware version");
                }
            } else {
                Log.e(TAG, "Invalid firmware version length");
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_SELECT_SIDE) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                byte[] data = SCmd_CheckBreakPoint();
                Log.d(
                        TAG,
                        "Sending CheckBreakPoint command, data="
                                + (data != null
                                        ? ByteUtil.outputHexString(data, 0, data.length)
                                        : "null"));
                send(data);
            } else {
                Log.e(TAG, "Select side error");
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_GET_BREAKPOINT) {
            if (msg.len == 40) {
                byte[] data = SCmd_SetStartInfo();
                Log.d(
                        TAG,
                        "Sending SetStartInfo command, data="
                                + (data != null
                                        ? ByteUtil.outputHexString(data, 0, data.length)
                                        : "null"));
                send(data);
            } else {
                Log.e(TAG, "Get breakpoint error");
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_SET_START_INFO) {
            if (msg.len == 10 && msg.body != null) {
                if (BesOtaUtil.isMagicCodeValid(msg.body, 0, 4)) {
                    byte[] data = SCmd_SetConfig(false, null, null, null, null);
                    Log.d(
                            TAG,
                            "Sending SetConfig command, data="
                                    + (data != null
                                            ? ByteUtil.outputHexString(
                                                    data, 0, Math.min(data.length, 100))
                                            : "null"));
                    send(data);
                } else {
                    Log.e(TAG, "Set start info: invalid magic code");
                }
            } else {
                Log.e(TAG, "Set start info error");
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_SET_CONFIG) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                sendOtaData();
            } else {
                Log.e(TAG, "Set config error");
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_SEND_DATA) {
            sendOtaData();
        } else if (msg.cmd == BesProtocolConstants.RCMD_SEGMENT_VERIFY) {
            Log.d(TAG, "Received SegmentVerify command, len=" + msg.len);
            Log.d(
                    TAG,
                    "Received SegmentVerify command, body="
                            + (msg.body != null
                                    ? ByteUtil.outputHexString(msg.body, 0, msg.body.length)
                                    : "null"));
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                int sent = getConfirmLength();
                int percent = 100 * sent / getTotalLength();
                Log.i(
                        TAG,
                        "OTA progress: "
                                + percent
                                + "% ("
                                + sent
                                + "/"
                                + getTotalLength()
                                + " bytes)");

                // Note: BES install progress is sent to phone via sr_adota from BES chip directly
                // We don't post PROGRESS events here because UART is busy and can't send to phone
                // anyway
                // Phone (MentraLive) maps sr_adota → ota_status for the app UI
                Log.d(
                        TAG,
                        "BES install progress: "
                                + percent
                                + "% ("
                                + sent
                                + "/"
                                + getTotalLength()
                                + " bytes)");

                crc32ConfirmSuccess();
                if (isSentFinish()) {
                    // Calculate CRC32 of all sent data for comparison
                    long sentCrc32 = BesOtaUtil.crc32(fileData, 0, sentPos);
                    Log.i(TAG, "========== FinishSend CRC32 Debug ==========");
                    Log.i(TAG, "Total bytes sent: " + sentPos);
                    Log.i(TAG, "File length: " + fileLen);
                    Log.i(TAG, "Sent data CRC32 (decimal): " + sentCrc32);
                    Log.i(TAG, "Sent data CRC32 (hex): 0x" + String.format("%08X", sentCrc32));
                    Log.i(
                            TAG,
                            "First 16 bytes of sent data: "
                                    + ByteUtil.outputHexString(fileData, 0, Math.min(16, sentPos)));
                    Log.i(
                            TAG,
                            "Last 16 bytes of sent data: "
                                    + ByteUtil.outputHexString(
                                            fileData,
                                            Math.max(0, sentPos - 16),
                                            Math.min(16, sentPos)));
                    Log.i(TAG, "============================================");

                    byte[] data = SCmd_FinshSend();
                    Log.d(
                            TAG,
                            "Sending FinishSend command, data="
                                    + (data != null
                                            ? ByteUtil.outputHexString(data, 0, data.length)
                                            : "null"));
                    send(data);
                } else {
                    sendOtaData();
                }
            } else {
                Log.e(TAG, "Segment verify error");
                postFailure("Segment verification failed");
                cleanup();
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_SEND_FINISH) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                byte[] data = SCmd_OtaApply();
                Log.d(
                        TAG,
                        "Sending OtaApply command, data="
                                + (data != null
                                        ? ByteUtil.outputHexString(data, 0, data.length)
                                        : "null"));
                send(data);
            } else {
                Log.e(TAG, "❌ ========== WHOLE CRC32 CHECK FAILED ==========");
                Log.e(
                        TAG,
                        "❌ Response: len="
                                + msg.len
                                + ", body="
                                + (msg.body != null
                                        ? ByteUtil.outputHexString(msg.body, 0, msg.body.length)
                                        : "null"));
                Log.e(
                        TAG,
                        "❌ Expected body[0]=1 (CRC match), got body[0]="
                                + (msg.body != null && msg.body.length > 0 ? msg.body[0] : "null"));
                Log.e(
                        TAG,
                        "❌ This means the BES chip computed a different CRC32 than what we sent in"
                                + " SetStartInfo");
                Log.e(TAG, "❌ Possible causes:");
                Log.e(TAG, "❌   1. Data corruption during UART transfer");
                Log.e(TAG, "❌   2. File changed between SetStartInfo and data transfer");
                Log.e(TAG, "❌   3. Bytes dropped or duplicated during transmission");
                Log.e(TAG, "❌ Sent bytes: " + sentPos + ", Expected: " + fileLen);
                if (sentPos != fileLen) {
                    Log.e(TAG, "❌ SIZE MISMATCH! sentPos=" + sentPos + " != fileLen=" + fileLen);
                }
                Log.e(TAG, "❌ =============================================");
                postFailure("Whole CRC32 check failed - data corruption?");
                cleanup();
            }
        } else if (msg.cmd == BesProtocolConstants.RCMD_APPLY) {
            if (msg.len == 1 && msg.body != null && msg.body[0] == 1) {
                Log.i(TAG, "BES accepted firmware apply; waiting for rebooted version readback");
                if (authorizationGate.markApplyPending()) {
                    // The authorization gate is also the durable OTA handoff. Keeping apply state
                    // in that single record avoids a second OtaSessionManager instance overwriting
                    // the live owner's cached session immediately before the hardware power cycle.
                    beginPostApplyVerificationLocked();
                    return;
                }
                Log.e(TAG, "Could not durably enter BES post-apply verification phase");
                postFailure("Could not safely verify BES after apply; reboot glasses");
            } else {
                Log.e(TAG, "Apply firmware error");
                postFailure("Failed to apply firmware");
            }
            cleanup();
        }
    }

    private void sendOtaData() {
        // Reduced logging - only log segment boundaries, not every packet
        if (isNeedSegmentVerify()) {
            byte[] data = SCmd_SegmentVerify();
            Log.i(
                    TAG,
                    "🔍 Segment "
                            + (confirmTimes + 1)
                            + " verify - sentPos="
                            + sentPos
                            + "/"
                            + fileLen);
            send(data);
            return;
        }

        byte[] data = SCmd_SendFileData();
        if (send(data)) {
            int payloadSize = data.length - BesBaseCommand.MIN_LENGTH;
            addSentSize(payloadSize);
        } else {
            Log.e(TAG, "❌ Failed to send file data packet at sentPos=" + sentPos);
            postFailure("Failed to send firmware data");
            cleanup();
        }
    }

    private boolean send(byte[] data) {
        if (transportCoordinator == null) {
            Log.e(TAG, "send() failed - transportCoordinator is null");
            return false;
        }
        if (data == null) {
            Log.e(TAG, "send() failed - data is null");
            return false;
        }
        return transportCoordinator.writeOta(transportLease, data);
    }
}
