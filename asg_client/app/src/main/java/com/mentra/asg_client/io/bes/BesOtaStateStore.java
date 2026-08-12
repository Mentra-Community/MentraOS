package com.mentra.asg_client.io.bes;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator.ValidatedBesArtifact;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.FileReader;
import java.util.Locale;

/**
 * Single durable authority for legacy BES OTA admission, apply, verification, and terminal state.
 *
 * <p>The deployed BES protocol cannot correlate {@code hm_ota} with a request. Safety therefore
 * comes from exclusion: once authorization is reserved, no second request is allowed in the same
 * Linux boot. Every mutation is an owner-checked whole-record commit performed under one lock.
 */
public final class BesOtaStateStore {
    private static final String TAG = "BesOtaStateStore";
    private static final String PREFS_NAME = "bes_ota_state";
    private static final String RECORD_KEY = "record";
    private static final String BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
    private static final int SCHEMA = 1;
    private static final Object TRANSITION_LOCK = new Object();

    public enum State {
        AUTH_ATTEMPTED,
        APPLY_PENDING,
        TERMINAL
    }

    public enum TerminalStatus {
        SUCCESS,
        FAILURE
    }

    public enum TransitionResult {
        APPLIED,
        ALREADY_APPLIED,
        ALREADY_TERMINAL,
        REJECTED,
        PERSISTENCE_FAILURE
    }

    public enum StartDecision {
        ADMIT,
        ACTIVE,
        RESTART_REQUIRED,
        PATH_PROOF_REQUIRED,
        CORRUPT,
        PERSISTENCE_FAILURE
    }

    public enum VerificationDecision {
        NOT_PENDING,
        WAIT_FOR_REBOOT,
        CLAIMED,
        RESUME,
        SECOND_BOOT_FAILED,
        PERSISTENCE_FAILURE
    }

    public enum StartupDecision {
        NORMAL,
        QUARANTINED,
        RECOVERY_PROBE_ONLY,
        VERSION_PROBE_ONLY,
        APPLY_WAIT,
        TERMINAL_AVAILABLE,
        PERSISTENCE_FAILURE
    }

    public enum UartPolicy {
        NORMAL,
        OTA_OWNER_ONLY,
        RECOVERY_PROBE_ONLY,
        VERSION_PROBE_ONLY,
        QUARANTINED
    }

    interface Storage {
        String get();

        boolean put(String value);

        boolean remove();
    }

    interface BootIdProvider {
        String currentBootId();
    }

    private final Storage storage;
    private final BootIdProvider bootIdProvider;
    private boolean persistenceUncertain;

    public BesOtaStateStore(Context context) {
        Context applicationContext = context.getApplicationContext();
        SharedPreferences preferences =
                applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.storage =
                new Storage() {
                    @Override
                    public String get() {
                        return preferences.getString(RECORD_KEY, null);
                    }

                    @Override
                    public boolean put(String value) {
                        return preferences.edit().putString(RECORD_KEY, value).commit();
                    }

                    @Override
                    public boolean remove() {
                        return preferences.edit().remove(RECORD_KEY).commit();
                    }
                };
        this.bootIdProvider = new ProcBootIdProvider();
    }

    BesOtaStateStore(Storage storage, BootIdProvider bootIdProvider) {
        if (storage == null || bootIdProvider == null) {
            throw new IllegalArgumentException("storage and bootIdProvider are required");
        }
        this.storage = storage;
        this.bootIdProvider = bootIdProvider;
    }

    public String currentBootId() {
        return canonicalBootId(bootIdProvider.currentBootId());
    }

    public Snapshot read() {
        synchronized (TRANSITION_LOCK) {
            return readLocked();
        }
    }

    /** Retire an eligible terminal before a new top-level OTA session becomes visible. */
    public StartDecision prepareForNewSession(
            String currentBootId, boolean framedPathProvenForCurrentSession) {
        synchronized (TRANSITION_LOCK) {
            Snapshot snapshot = readLocked();
            logDecision(
                    "prepare_start",
                    "requested_boot="
                            + diagnosticValue(canonicalBootId(currentBootId))
                            + " framed_path="
                            + framedPathProvenForCurrentSession,
                    snapshot);
            if (snapshot.isCorrupt()) {
                return StartDecision.CORRUPT;
            }
            if (snapshot.isIdle()) {
                return StartDecision.ADMIT;
            }
            if (snapshot.state == State.AUTH_ATTEMPTED || snapshot.state == State.APPLY_PENDING) {
                return StartDecision.ACTIVE;
            }
            if (snapshot.terminalStatus == TerminalStatus.SUCCESS) {
                return removeLocked("retire_success", snapshot)
                        ? StartDecision.ADMIT
                        : StartDecision.PERSISTENCE_FAILURE;
            }
            String boot = canonicalBootId(currentBootId);
            if (boot == null || boot.equals(snapshot.authorizationBootId)) {
                return StartDecision.RESTART_REQUIRED;
            }
            if (!framedPathProvenForCurrentSession) {
                return StartDecision.PATH_PROOF_REQUIRED;
            }
            return removeLocked("retire_failure_after_path_proof", snapshot)
                    ? StartDecision.ADMIT
                    : StartDecision.PERSISTENCE_FAILURE;
        }
    }

    /** Commit the one authorization attempt before the first possible {@code mh_ota} byte. */
    public TransitionResult reserveAuthorization(
            String ownerSessionId, String currentBootId, ValidatedBesArtifact artifact) {
        if (artifact == null) {
            return TransitionResult.REJECTED;
        }
        return reserveAuthorization(
                ownerSessionId,
                currentBootId,
                artifact.getTargetVersion(),
                artifact.getArtifactId(),
                artifact.getCompressedSha256());
    }

    TransitionResult reserveAuthorization(
            String ownerSessionId,
            String currentBootId,
            String targetVersion,
            String artifactId,
            String artifactSha256) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            if (!current.isIdle()) {
                logDecision("reserve_rejected", "reason=state_not_idle", current);
                return TransitionResult.REJECTED;
            }
            String owner = canonicalNonempty(ownerSessionId);
            String boot = canonicalBootId(currentBootId);
            String target = canonicalVersion(targetVersion);
            String identity = canonicalNonempty(artifactId);
            String digest = artifactSha256 == null ? null : artifactSha256.toLowerCase(Locale.US);
            if (owner == null
                    || boot == null
                    || target == null
                    || identity == null
                    || digest == null
                    || !digest.matches("[0-9a-f]{64}")) {
                logDecision(
                        "reserve_rejected",
                        "reason=invalid_input requested_owner="
                                + diagnosticValue(owner)
                                + " requested_boot="
                                + diagnosticValue(boot)
                                + " requested_target="
                                + diagnosticValue(target),
                        current);
                return TransitionResult.REJECTED;
            }
            Snapshot reserved =
                    Snapshot.valid(
                            State.AUTH_ATTEMPTED,
                            owner,
                            boot,
                            null,
                            target,
                            identity,
                            digest,
                            null,
                            null,
                            System.currentTimeMillis());
            return putLocked("reserve_authorization", current, reserved)
                    ? TransitionResult.APPLIED
                    : TransitionResult.PERSISTENCE_FAILURE;
        }
    }

    public TransitionResult markApplyPending(String ownerSessionId) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            if (!current.isOwnedActive(State.AUTH_ATTEMPTED, ownerSessionId)) {
                logDecision(
                        "mark_apply_rejected",
                        "requested_owner=" + diagnosticValue(canonicalNonempty(ownerSessionId)),
                        current);
                return terminalOrRejected(current);
            }
            Snapshot next = current.withState(State.APPLY_PENDING, null);
            return putLocked("mark_apply_pending", current, next)
                    ? TransitionResult.APPLIED
                    : TransitionResult.PERSISTENCE_FAILURE;
        }
    }

    /** Claim exactly one post-apply Linux boot for target-version verification. */
    public VerificationDecision claimOrResumeVerificationBoot(String currentBootId) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            if (!current.isValid() || current.state != State.APPLY_PENDING) {
                logDecision("verification_not_pending", "", current);
                return VerificationDecision.NOT_PENDING;
            }
            String boot = canonicalBootId(currentBootId);
            if (boot == null) {
                logDecision("verification_rejected", "reason=invalid_boot", current);
                return VerificationDecision.PERSISTENCE_FAILURE;
            }
            if (boot.equals(current.authorizationBootId)) {
                logDecision("verification_wait", "requested_boot=" + boot, current);
                return VerificationDecision.WAIT_FOR_REBOOT;
            }
            if (current.verificationBootId == null) {
                Snapshot claimed = current.withVerificationBoot(boot);
                return putLocked("claim_verification_boot", current, claimed)
                        ? VerificationDecision.CLAIMED
                        : VerificationDecision.PERSISTENCE_FAILURE;
            }
            if (boot.equals(current.verificationBootId)) {
                logDecision("verification_resume", "requested_boot=" + boot, current);
                return VerificationDecision.RESUME;
            }
            Snapshot failed =
                    current.asTerminal(TerminalStatus.FAILURE, "verification_boot_changed");
            return putLocked("fail_verification_boot_changed", current, failed)
                    ? VerificationDecision.SECOND_BOOT_FAILED
                    : VerificationDecision.PERSISTENCE_FAILURE;
        }
    }

    /**
     * Atomically select and commit the version-proof transition for a later Linux boot.
     *
     * <p>The recovery timeout finalizer runs on another thread. Keeping state selection,
     * verification-boot claiming, and completion under the transition lock guarantees that an exact
     * proof is applied either to the active record or to the narrowly eligible timeout terminal; it
     * cannot be lost between a stale manager snapshot and the selected transition.
     */
    public TransitionResult completeVersionProofAfterRestart(
            String ownerSessionId, String currentBootId, String actualVersion) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            String owner = canonicalNonempty(ownerSessionId);
            logDecision(
                    "reconcile_restart_version_proof",
                    "requested_owner="
                            + diagnosticValue(owner)
                            + " requested_boot="
                            + diagnosticValue(canonicalBootId(currentBootId))
                            + " actual="
                            + diagnosticValue(canonicalVersion(actualVersion)),
                    current);
            if (!current.isValid() || !current.ownerSessionId.equals(owner)) {
                return TransitionResult.REJECTED;
            }
            if (current.state == State.APPLY_PENDING) {
                VerificationDecision verification = claimOrResumeVerificationBoot(currentBootId);
                if (verification == VerificationDecision.CLAIMED
                        || verification == VerificationDecision.RESUME) {
                    return completeVerified(owner, currentBootId, actualVersion);
                }
                if (verification == VerificationDecision.PERSISTENCE_FAILURE) {
                    return TransitionResult.PERSISTENCE_FAILURE;
                }
                return verification == VerificationDecision.SECOND_BOOT_FAILED
                        ? TransitionResult.ALREADY_TERMINAL
                        : TransitionResult.REJECTED;
            }
            if (current.state == State.AUTH_ATTEMPTED) {
                return completeRecoveredAfterRestart(owner, currentBootId, actualVersion);
            }
            return completeLateExactTargetAfterRecoveryTimeout(owner, currentBootId, actualVersion);
        }
    }

    /** Exact post-apply readback is the only success transition. */
    public TransitionResult completeVerified(
            String ownerSessionId, String currentBootId, String actualVersion) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            if (!current.isOwnedActive(State.APPLY_PENDING, ownerSessionId)) {
                logDecision(
                        "version_proof_rejected",
                        "reason=owner_or_state requested_owner="
                                + diagnosticValue(canonicalNonempty(ownerSessionId))
                                + " requested_boot="
                                + diagnosticValue(canonicalBootId(currentBootId))
                                + " actual="
                                + diagnosticValue(canonicalVersion(actualVersion)),
                        current);
                return terminalOrRejected(current);
            }
            String boot = canonicalBootId(currentBootId);
            String actual = canonicalVersion(actualVersion);
            if (boot == null
                    || current.verificationBootId == null
                    || !boot.equals(current.verificationBootId)) {
                logDecision(
                        "version_proof_rejected",
                        "reason=verification_boot requested_boot="
                                + diagnosticValue(boot)
                                + " actual="
                                + diagnosticValue(actual),
                        current);
                return TransitionResult.REJECTED;
            }
            boolean matches = current.targetVersion.equals(actual);
            Snapshot terminal =
                    current.asTerminal(
                            matches ? TerminalStatus.SUCCESS : TerminalStatus.FAILURE,
                            matches ? "verified" : "version_mismatch");
            return putLocked(
                            matches ? "complete_verified" : "fail_version_mismatch",
                            current,
                            terminal)
                    ? TransitionResult.APPLIED
                    : TransitionResult.PERSISTENCE_FAILURE;
        }
    }

    /**
     * Resolve an authorization record recovered on a later Linux boot.
     *
     * <p>An abrupt MTK reboot can restore the last filesystem-persisted record even when a newer
     * SharedPreferences value was committed and read back before BES apply. In that case the
     * durable record is still {@link State#AUTH_ATTEMPTED}, so only a fresh, source-audited framed
     * version reply from the later boot may decide whether the target was installed.
     */
    public TransitionResult completeRecoveredAfterRestart(
            String ownerSessionId, String currentBootId, String actualVersion) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            String owner = canonicalNonempty(ownerSessionId);
            String boot = canonicalBootId(currentBootId);
            String actual = canonicalVersion(actualVersion);
            if (!current.isOwnedActive(State.AUTH_ATTEMPTED, owner)
                    || boot == null
                    || boot.equals(current.authorizationBootId)) {
                logDecision(
                        "recovered_version_proof_rejected",
                        "reason=owner_state_or_boot requested_owner="
                                + diagnosticValue(owner)
                                + " requested_boot="
                                + diagnosticValue(boot)
                                + " actual="
                                + diagnosticValue(actual),
                        current);
                return terminalOrRejected(current);
            }
            boolean matches = current.targetVersion.equals(actual);
            Snapshot terminal =
                    current.withVerificationBoot(boot)
                            .asTerminal(
                                    matches ? TerminalStatus.SUCCESS : TerminalStatus.FAILURE,
                                    matches
                                            ? "verified"
                                            : (actual == null
                                                    ? "invalid_version_proof"
                                                    : "version_mismatch"));
            return putLocked(
                            matches
                                    ? "complete_recovered_after_restart"
                                    : "fail_recovered_" + terminal.terminalCode,
                            current,
                            terminal)
                    ? TransitionResult.APPLIED
                    : TransitionResult.PERSISTENCE_FAILURE;
        }
    }

    /**
     * Replace only a transport-recovery timeout with exact target-version proof from a later boot.
     *
     * <p>Recovery timing is not proof that the installation failed. A fresh framed version reply
     * from a different Linux boot is stronger evidence, but it must never erase authorization,
     * protocol, artifact, or version failures.
     */
    public TransitionResult completeLateExactTargetAfterRecoveryTimeout(
            String ownerSessionId, String currentBootId, String actualVersion) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            String owner = canonicalNonempty(ownerSessionId);
            String boot = canonicalBootId(currentBootId);
            String actual = canonicalVersion(actualVersion);
            boolean eligibleTimeout =
                    current.isValid()
                            && current.state == State.TERMINAL
                            && current.terminalStatus == TerminalStatus.FAILURE
                            && ("recovery_timeout".equals(current.terminalCode)
                                    || "verification_timeout".equals(current.terminalCode));
            if (!eligibleTimeout
                    || !current.ownerSessionId.equals(owner)
                    || boot == null
                    || boot.equals(current.authorizationBootId)
                    || !current.targetVersion.equals(actual)) {
                logDecision(
                        "late_timeout_version_proof_rejected",
                        "requested_owner="
                                + diagnosticValue(owner)
                                + " requested_boot="
                                + diagnosticValue(boot)
                                + " actual="
                                + diagnosticValue(actual),
                        current);
                return current.isValid()
                                && current.state == State.TERMINAL
                                && current.ownerSessionId.equals(owner)
                        ? TransitionResult.ALREADY_TERMINAL
                        : TransitionResult.REJECTED;
            }
            Snapshot verified =
                    current.withVerificationBoot(boot)
                            .asTerminal(TerminalStatus.SUCCESS, "verified");
            return putLocked("complete_late_timeout_version_proof", current, verified)
                    ? TransitionResult.APPLIED
                    : TransitionResult.PERSISTENCE_FAILURE;
        }
    }

    /** Monotonic owner-checked failure transition. Failure never erases authorization history. */
    public TransitionResult fail(String ownerSessionId, String stableCode) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            if (current.isCorrupt() || current.isIdle()) {
                logDecision(
                        "failure_rejected",
                        "reason=no_active_state requested_code="
                                + diagnosticValue(canonicalCode(stableCode)),
                        current);
                return TransitionResult.REJECTED;
            }
            if (current.state == State.TERMINAL) {
                logDecision(
                        "failure_ignored_terminal",
                        "requested_owner="
                                + diagnosticValue(canonicalNonempty(ownerSessionId))
                                + " requested_code="
                                + diagnosticValue(canonicalCode(stableCode)),
                        current);
                return current.ownerSessionId.equals(canonicalNonempty(ownerSessionId))
                        ? TransitionResult.ALREADY_TERMINAL
                        : TransitionResult.REJECTED;
            }
            if (!current.ownerSessionId.equals(canonicalNonempty(ownerSessionId))) {
                logDecision(
                        "failure_rejected",
                        "reason=owner_mismatch requested_owner="
                                + diagnosticValue(canonicalNonempty(ownerSessionId))
                                + " requested_code="
                                + diagnosticValue(canonicalCode(stableCode)),
                        current);
                return TransitionResult.REJECTED;
            }
            String code = canonicalCode(stableCode);
            Snapshot terminal =
                    current.asTerminal(
                            TerminalStatus.FAILURE, code != null ? code : "install_failed");
            return putLocked("fail_" + terminal.terminalCode, current, terminal)
                    ? TransitionResult.APPLIED
                    : TransitionResult.PERSISTENCE_FAILURE;
        }
    }

    /** Reconcile a process start before ordinary UART traffic is admitted. */
    public StartupDecision reconcileStartup(String currentBootId) {
        synchronized (TRANSITION_LOCK) {
            String boot = canonicalBootId(currentBootId);
            Snapshot current = readLocked();
            logDecision("startup_snapshot", "requested_boot=" + diagnosticValue(boot), current);
            if (current.isCorrupt()) {
                if (boot == null) {
                    return StartupDecision.PERSISTENCE_FAILURE;
                }
                Snapshot repaired =
                        Snapshot.valid(
                                State.TERMINAL,
                                "corrupt-state",
                                boot,
                                null,
                                "0.0.0.0",
                                "unknown",
                                repeat('0', 64),
                                TerminalStatus.FAILURE,
                                "corrupt_state",
                                System.currentTimeMillis());
                return putLocked("repair_corrupt_startup", current, repaired)
                        ? StartupDecision.QUARANTINED
                        : StartupDecision.PERSISTENCE_FAILURE;
            }
            if (current.isIdle()) {
                return StartupDecision.NORMAL;
            }
            if (boot == null) {
                return StartupDecision.QUARANTINED;
            }
            if (current.state == State.AUTH_ATTEMPTED) {
                if (!boot.equals(current.authorizationBootId)) {
                    // A hard reboot can expose an older, otherwise valid filesystem record. Keep
                    // the target and owner active until raw OTA mode, a fresh framed version
                    // reply, or the bounded recovery timeout resolves the hardware state.
                    return StartupDecision.RECOVERY_PROBE_ONLY;
                }
                Snapshot failed = current.asTerminal(TerminalStatus.FAILURE, "interrupted");
                if (!putLocked("fail_interrupted_on_startup", current, failed)) {
                    return StartupDecision.PERSISTENCE_FAILURE;
                }
                return StartupDecision.RECOVERY_PROBE_ONLY;
            }
            if (current.state == State.APPLY_PENDING) {
                if (boot.equals(current.authorizationBootId)) {
                    return StartupDecision.APPLY_WAIT;
                }
                VerificationDecision decision = claimOrResumeVerificationBoot(boot);
                if (decision == VerificationDecision.CLAIMED
                        || decision == VerificationDecision.RESUME) {
                    return StartupDecision.VERSION_PROBE_ONLY;
                }
                return decision == VerificationDecision.PERSISTENCE_FAILURE
                        ? StartupDecision.PERSISTENCE_FAILURE
                        : StartupDecision.QUARANTINED;
            }
            if (current.terminalStatus == TerminalStatus.SUCCESS) {
                return StartupDecision.TERMINAL_AVAILABLE;
            }
            return StartupDecision.RECOVERY_PROBE_ONLY;
        }
    }

    public UartPolicy uartPolicy(
            String currentBootId,
            boolean framedPathProvenForCurrentSession,
            String liveOwnerSessionId) {
        synchronized (TRANSITION_LOCK) {
            Snapshot current = readLocked();
            if (current.isCorrupt()) {
                return UartPolicy.QUARANTINED;
            }
            if (current.isIdle()) {
                return UartPolicy.NORMAL;
            }
            String boot = canonicalBootId(currentBootId);
            if (boot == null) {
                return UartPolicy.QUARANTINED;
            }
            boolean liveOwner =
                    current.ownerSessionId.equals(canonicalNonempty(liveOwnerSessionId));
            if (current.state == State.AUTH_ATTEMPTED) {
                if (boot.equals(current.authorizationBootId) && liveOwner) {
                    return UartPolicy.OTA_OWNER_ONLY;
                }
                return boot.equals(current.authorizationBootId)
                        ? UartPolicy.QUARANTINED
                        : UartPolicy.RECOVERY_PROBE_ONLY;
            }
            if (current.state == State.APPLY_PENDING) {
                if (boot.equals(current.authorizationBootId)) {
                    return liveOwner ? UartPolicy.OTA_OWNER_ONLY : UartPolicy.QUARANTINED;
                }
                return UartPolicy.VERSION_PROBE_ONLY;
            }
            if (current.terminalStatus == TerminalStatus.SUCCESS) {
                return UartPolicy.NORMAL;
            }
            return framedPathProvenForCurrentSession
                    ? UartPolicy.NORMAL
                    : UartPolicy.RECOVERY_PROBE_ONLY;
        }
    }

    private Snapshot readLocked() {
        if (persistenceUncertain) {
            return Snapshot.corrupt("prior commit failed");
        }
        String raw = storage.get();
        if (raw == null) {
            return Snapshot.idle();
        }
        if (raw.trim().isEmpty()) {
            return Snapshot.corrupt("empty state");
        }
        try {
            return Snapshot.fromJson(new JSONObject(raw));
        } catch (Exception e) {
            Log.e(TAG, "Stored BES OTA state is invalid", e);
            return Snapshot.corrupt(e.getMessage());
        }
    }

    private boolean putLocked(String operation, Snapshot before, Snapshot snapshot) {
        String encoded = snapshot.toJson().toString();
        boolean committed = storage.put(encoded);
        String readback = storage.get();
        boolean readbackMatches = encoded.equals(readback);
        logMutation(operation, before, snapshot, committed, readbackMatches);
        if (!committed) {
            persistenceUncertain = true;
            Log.e(TAG, "BES OTA state commit failed; remaining fail-closed for this process");
        } else if (!readbackMatches) {
            Log.w(
                    TAG,
                    diagnosticPrefix(operation)
                            + " durable state readback differs immediately after successful"
                            + " commit");
        }
        return committed;
    }

    private boolean removeLocked(String operation, Snapshot before) {
        boolean committed = storage.remove();
        boolean readbackRemoved = storage.get() == null;
        Log.i(
                TAG,
                diagnosticPrefix(operation)
                        + " before={"
                        + before.toDiagnosticString()
                        + "} after={"
                        + Snapshot.idle().toDiagnosticString()
                        + "} committed="
                        + committed
                        + " readback_removed="
                        + readbackRemoved);
        if (!committed) {
            persistenceUncertain = true;
            Log.e(TAG, "BES OTA state retirement failed; remaining fail-closed");
        }
        return committed;
    }

    private void logMutation(
            String operation,
            Snapshot before,
            Snapshot after,
            boolean committed,
            boolean readbackMatches) {
        Log.i(
                TAG,
                diagnosticPrefix(operation)
                        + " before={"
                        + before.toDiagnosticString()
                        + "} after={"
                        + after.toDiagnosticString()
                        + "} committed="
                        + committed
                        + " readback_match="
                        + readbackMatches);
    }

    private void logDecision(String operation, String details, Snapshot snapshot) {
        Log.i(
                TAG,
                diagnosticPrefix(operation)
                        + (details == null || details.isEmpty() ? "" : " " + details)
                        + " snapshot={"
                        + snapshot.toDiagnosticString()
                        + "}");
    }

    private String diagnosticPrefix(String operation) {
        return "BES_OTA_DIAG op="
                + operation
                + " pid="
                + Process.myPid()
                + " thread="
                + Thread.currentThread().getName()
                + " elapsed_ms="
                + SystemClock.elapsedRealtime()
                + " live_boot="
                + diagnosticValue(currentBootId());
    }

    private static String diagnosticValue(String value) {
        return value == null ? "-" : value;
    }

    private static TransitionResult terminalOrRejected(Snapshot snapshot) {
        return snapshot.isValid() && snapshot.state == State.TERMINAL
                ? TransitionResult.ALREADY_TERMINAL
                : TransitionResult.REJECTED;
    }

    public static String canonicalVersion(String value) {
        if (value == null) {
            return null;
        }
        String[] parts = value.trim().split("\\.", -1);
        if (parts.length != 4) {
            return null;
        }
        StringBuilder canonical = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (parts[i].isEmpty() || !parts[i].matches("[0-9]{1,3}")) {
                return null;
            }
            int component;
            try {
                component = Integer.parseInt(parts[i]);
            } catch (NumberFormatException e) {
                return null;
            }
            if (component < 0 || component > 255) {
                return null;
            }
            if (i > 0) {
                canonical.append('.');
            }
            canonical.append(component);
        }
        return canonical.toString();
    }

    private static String canonicalBootId(String value) {
        String result = canonicalNonempty(value);
        return result != null && result.length() <= 128 ? result : null;
    }

    private static String canonicalNonempty(String value) {
        if (value == null) {
            return null;
        }
        String result = value.trim();
        return result.isEmpty() ? null : result;
    }

    private static String canonicalCode(String value) {
        String result = canonicalNonempty(value);
        return result != null && result.matches("[a-z0-9_]{1,64}") ? result : null;
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int i = 0; i < count; i++) {
            result.append(value);
        }
        return result.toString();
    }

    private static final class ProcBootIdProvider implements BootIdProvider {
        @Override
        public String currentBootId() {
            try (BufferedReader reader = new BufferedReader(new FileReader(BOOT_ID_PATH))) {
                return reader.readLine();
            } catch (Exception e) {
                Log.e(TAG, "Could not read Linux boot ID", e);
                return null;
            }
        }
    }

    /** Immutable validated state snapshot. */
    public static final class Snapshot {
        private final boolean idle;
        private final String corruption;
        private final State state;
        private final String ownerSessionId;
        private final String authorizationBootId;
        private final String verificationBootId;
        private final String targetVersion;
        private final String artifactId;
        private final String artifactSha256;
        private final TerminalStatus terminalStatus;
        private final String terminalCode;
        private final long updatedAtMs;

        private Snapshot(
                boolean idle,
                String corruption,
                State state,
                String ownerSessionId,
                String authorizationBootId,
                String verificationBootId,
                String targetVersion,
                String artifactId,
                String artifactSha256,
                TerminalStatus terminalStatus,
                String terminalCode,
                long updatedAtMs) {
            this.idle = idle;
            this.corruption = corruption;
            this.state = state;
            this.ownerSessionId = ownerSessionId;
            this.authorizationBootId = authorizationBootId;
            this.verificationBootId = verificationBootId;
            this.targetVersion = targetVersion;
            this.artifactId = artifactId;
            this.artifactSha256 = artifactSha256;
            this.terminalStatus = terminalStatus;
            this.terminalCode = terminalCode;
            this.updatedAtMs = updatedAtMs;
        }

        static Snapshot idle() {
            return new Snapshot(
                    true, null, null, null, null, null, null, null, null, null, null, 0);
        }

        static Snapshot corrupt(String diagnostic) {
            return new Snapshot(
                    false,
                    diagnostic != null ? diagnostic : "invalid",
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    0);
        }

        static Snapshot valid(
                State state,
                String ownerSessionId,
                String authorizationBootId,
                String verificationBootId,
                String targetVersion,
                String artifactId,
                String artifactSha256,
                TerminalStatus terminalStatus,
                String terminalCode,
                long updatedAtMs) {
            return new Snapshot(
                    false,
                    null,
                    state,
                    ownerSessionId,
                    authorizationBootId,
                    verificationBootId,
                    targetVersion,
                    artifactId,
                    artifactSha256,
                    terminalStatus,
                    terminalCode,
                    updatedAtMs);
        }

        static Snapshot fromJson(JSONObject json) throws JSONException {
            if (json.getInt("schema") != SCHEMA) {
                throw new JSONException("unknown schema");
            }
            State state = State.valueOf(json.getString("state"));
            String owner = canonicalNonempty(json.getString("owner_session_id"));
            String authBoot = canonicalBootId(json.getString("authorization_boot_id"));
            String target = canonicalVersion(json.getString("target_version"));
            String artifactId = canonicalNonempty(json.getString("artifact_id"));
            String sha = json.getString("artifact_sha256").toLowerCase(Locale.US);
            boolean hasVerificationBoot = !json.isNull("verification_boot_id");
            String verification =
                    !hasVerificationBoot
                            ? null
                            : canonicalBootId(json.getString("verification_boot_id"));
            TerminalStatus terminal =
                    json.isNull("terminal_status")
                            ? null
                            : TerminalStatus.valueOf(json.getString("terminal_status"));
            String code =
                    json.isNull("terminal_code")
                            ? null
                            : canonicalCode(json.getString("terminal_code"));
            if (owner == null
                    || authBoot == null
                    || target == null
                    || artifactId == null
                    || !sha.matches("[0-9a-f]{64}")
                    || (hasVerificationBoot && verification == null)
                    || (state == State.TERMINAL) != (terminal != null && code != null)
                    || (state != State.TERMINAL && (terminal != null || code != null))) {
                throw new JSONException("invalid BES OTA state fields");
            }
            return valid(
                    state,
                    owner,
                    authBoot,
                    verification,
                    target,
                    artifactId,
                    sha,
                    terminal,
                    code,
                    json.optLong("updated_at_ms", 0));
        }

        JSONObject toJson() {
            try {
                JSONObject json = new JSONObject();
                json.put("schema", SCHEMA);
                json.put("state", state.name());
                json.put("owner_session_id", ownerSessionId);
                json.put("authorization_boot_id", authorizationBootId);
                json.put(
                        "verification_boot_id",
                        verificationBootId == null ? JSONObject.NULL : verificationBootId);
                json.put("target_version", targetVersion);
                json.put("artifact_id", artifactId);
                json.put("artifact_sha256", artifactSha256);
                json.put(
                        "terminal_status",
                        terminalStatus == null ? JSONObject.NULL : terminalStatus.name());
                json.put("terminal_code", terminalCode == null ? JSONObject.NULL : terminalCode);
                json.put("updated_at_ms", updatedAtMs);
                return json;
            } catch (JSONException e) {
                throw new IllegalStateException("Could not encode BES OTA state", e);
            }
        }

        Snapshot withState(State nextState, String verificationBootId) {
            return valid(
                    nextState,
                    ownerSessionId,
                    authorizationBootId,
                    verificationBootId,
                    targetVersion,
                    artifactId,
                    artifactSha256,
                    null,
                    null,
                    System.currentTimeMillis());
        }

        Snapshot withVerificationBoot(String bootId) {
            return valid(
                    state,
                    ownerSessionId,
                    authorizationBootId,
                    bootId,
                    targetVersion,
                    artifactId,
                    artifactSha256,
                    terminalStatus,
                    terminalCode,
                    System.currentTimeMillis());
        }

        Snapshot asTerminal(TerminalStatus status, String code) {
            return valid(
                    State.TERMINAL,
                    ownerSessionId,
                    authorizationBootId,
                    verificationBootId,
                    targetVersion,
                    artifactId,
                    artifactSha256,
                    status,
                    code,
                    System.currentTimeMillis());
        }

        boolean isOwnedActive(State expectedState, String owner) {
            return isValid()
                    && state == expectedState
                    && ownerSessionId.equals(canonicalNonempty(owner));
        }

        public boolean isIdle() {
            return idle;
        }

        public boolean isCorrupt() {
            return corruption != null;
        }

        public boolean isValid() {
            return !idle && corruption == null;
        }

        public State getState() {
            return state;
        }

        public String getOwnerSessionId() {
            return ownerSessionId;
        }

        public String getAuthorizationBootId() {
            return authorizationBootId;
        }

        public String getVerificationBootId() {
            return verificationBootId;
        }

        public String getTargetVersion() {
            return targetVersion;
        }

        public String getArtifactId() {
            return artifactId;
        }

        public String getArtifactSha256() {
            return artifactSha256;
        }

        public TerminalStatus getTerminalStatus() {
            return terminalStatus;
        }

        public String getTerminalCode() {
            return terminalCode;
        }

        /** Stable, non-secret summary for correlating OTA transitions across process and boot. */
        public String toDiagnosticString() {
            if (isIdle()) {
                return "state=IDLE";
            }
            if (isCorrupt()) {
                return "state=CORRUPT reason=" + diagnosticValue(corruption);
            }
            return "state="
                    + state
                    + " owner="
                    + diagnosticValue(ownerSessionId)
                    + " auth_boot="
                    + diagnosticValue(authorizationBootId)
                    + " verify_boot="
                    + diagnosticValue(verificationBootId)
                    + " target="
                    + diagnosticValue(targetVersion)
                    + " terminal_status="
                    + diagnosticValue(terminalStatus == null ? null : terminalStatus.name())
                    + " terminal_code="
                    + diagnosticValue(terminalCode)
                    + " updated_at_ms="
                    + updatedAtMs;
        }
    }
}
