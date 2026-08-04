package com.mentra.asg_client.io.bes;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import java.io.BufferedReader;
import java.io.FileReader;

/** Prevents a second legacy {@code mh_ota} authorization attempt during one glasses boot. */
public final class BesOtaAuthorizationGate implements BesUartTransportCoordinator.OtaSafetyState {
    private static final String TAG = "BesOtaAuthGate";
    private static final String LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
    private static final Object RESERVATION_LOCK = new Object();

    private final BootIdProvider bootIdProvider;
    private final SharedPreferences preferences;

    public enum PostApplyVerification {
        NOT_PENDING,
        VERIFIED,
        VERSION_MISMATCH,
        PERSISTENCE_FAILURE
    }

    public BesOtaAuthorizationGate(Context context) {
        this(context, null);
    }

    BesOtaAuthorizationGate(Context context, BootIdProvider bootIdProvider) {
        this.bootIdProvider = bootIdProvider;
        this.preferences =
                context.getApplicationContext()
                        .getSharedPreferences(
                                AsgConstants.BES_OTA_AUTH_GATE_PREFS, Context.MODE_PRIVATE);
    }

    boolean isRetryBlockedThisBoot() {
        synchronized (RESERVATION_LOCK) {
            if (isApplyPendingLocked()) {
                return true;
            }
            String current = currentBootId();
            String attempted = attemptedBootId();
            return current == null || current.equals(attempted);
        }
    }

    /**
     * Atomically reserve and persist this boot before the first authorization byte can reach BES.
     */
    boolean tryReserveCurrentBoot(String targetVersion, String otaSessionId) {
        synchronized (RESERVATION_LOCK) {
            String current = currentBootId();
            if (current == null) {
                Log.e(
                        TAG,
                        "Cannot prove the glasses boot identity; refusing BES OTA authorization");
                return false;
            }
            if (isApplyPendingLocked()) {
                Log.e(TAG, "BES OTA target verification is still pending; refusing a new update");
                return false;
            }
            if (current.equals(attemptedBootId())) {
                Log.e(TAG, "BES OTA authorization is already reserved for this glasses boot");
                return false;
            }
            String target = canonicalExactTargetVersion(targetVersion);
            if (target == null) {
                Log.e(TAG, "Cannot reserve BES OTA without an exact dotted target version");
                return false;
            }
            String sessionId = otaSessionId == null ? "" : otaSessionId.trim();
            if (sessionId.isEmpty()) {
                Log.e(TAG, "Cannot reserve BES OTA without an owning OTA session");
                return false;
            }
            return preferences
                    .edit()
                    .putString(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY, current)
                    .putString(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY, target)
                    .putString(AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY, sessionId)
                    .putBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false)
                    .remove(AsgConstants.BES_OTA_AUTH_GATE_VERIFICATION_BOOT_ID_KEY)
                    .remove(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY)
                    .remove(AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY)
                    .commit();
        }
    }

    /** Persist the apply phase before releasing raw OTA ownership for BES reboot discovery. */
    boolean markApplyPending() {
        synchronized (RESERVATION_LOCK) {
            String current = currentBootId();
            if (current == null
                    || !current.equals(attemptedBootId())
                    || expectedTargetVersionLocked().isEmpty()) {
                return false;
            }
            return preferences
                    .edit()
                    .putBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, true)
                    .remove(AsgConstants.BES_OTA_AUTH_GATE_VERIFICATION_BOOT_ID_KEY)
                    .commit();
        }
    }

    /** Clear only after explicit denial or post-reboot normal-mode version proof. */
    boolean clear() {
        synchronized (RESERVATION_LOCK) {
            return clearLocked();
        }
    }

    /** Restore fail-closed UART quarantine after an ASG process or serial-session restart. */
    @Override
    public boolean isQuarantinedForCurrentBoot() {
        synchronized (RESERVATION_LOCK) {
            String attempted = attemptedBootId();
            if (attempted == null) {
                return false;
            }
            String current = currentBootId();
            if (current == null) {
                return true;
            }
            if (!isApplyPendingLocked()) {
                return current.equals(attempted);
            }

            String verificationBoot = claimVerificationBootLocked(current, attempted);
            // Apply discovery is allowed before the power cycle on the attempted boot and on the
            // first boot after it. A second unverified reboot is ambiguous and stays quarantined.
            if (!current.equals(attempted) && !current.equals(verificationBoot)) {
                if (!persistTerminalFailureQuarantineLocked(
                        current, "BES rebooted again before target version was verified")) {
                    Log.e(TAG, "Could not durably record second unverified BES reboot");
                }
                return true;
            }
            return false;
        }
    }

    @Override
    public boolean isPostApplyVerificationPendingForCurrentBoot() {
        synchronized (RESERVATION_LOCK) {
            String current = currentBootId();
            String attempted = attemptedBootId();
            if (current == null || attempted == null || !isApplyPendingLocked()) {
                return false;
            }
            String verificationBoot = claimVerificationBootLocked(current, attempted);
            if (!current.equals(attempted) && !current.equals(verificationBoot)) {
                // Persist the terminal failure as soon as any startup component probes the gate.
                // Do not rely on the later UART-ready callback: OtaService may already be waiting
                // to replay the durable result to the phone.
                if (!persistTerminalFailureQuarantineLocked(
                        current, "BES rebooted again before target version was verified")) {
                    Log.e(TAG, "Could not durably record second unverified BES reboot");
                }
                return false;
            }
            return current.equals(attempted) || current.equals(verificationBoot);
        }
    }

    public String getExpectedTargetVersion() {
        synchronized (RESERVATION_LOCK) {
            return expectedTargetVersionLocked();
        }
    }

    /**
     * Atomically replace one post-reboot version proof with its durable terminal handoff.
     *
     * <p>The terminal outcome is committed in the same preference transaction that consumes the
     * target/boot record. This is why a result cannot disappear when verification happens before
     * {@code OtaService} subscribes to EventBus.
     */
    public PostApplyVerification verifyPostApplyVersion(String actualVersion) {
        synchronized (RESERVATION_LOCK) {
            if (!isPostApplyVerificationPendingForCurrentBoot()) {
                return PostApplyVerification.NOT_PENDING;
            }
            String current = currentBootId();
            String attempted = attemptedBootId();
            String verificationBoot = verificationBootId();
            if (current == null || current.equals(attempted) || !current.equals(verificationBoot)) {
                // A normal-mode reply from the authorization boot is not post-reboot proof.
                return PostApplyVerification.NOT_PENDING;
            }
            String expected = expectedTargetVersionLocked();
            String actual = canonicalExactTargetVersion(actualVersion);
            boolean matches = expected.equals(actual);
            SharedPreferences.Editor editor =
                    preferences
                            .edit()
                            .remove(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY)
                            .remove(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY)
                            .remove(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY)
                            .remove(AsgConstants.BES_OTA_AUTH_GATE_VERIFICATION_BOOT_ID_KEY)
                            .putString(
                                    AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY,
                                    matches ? "FINISHED" : "FAILED");
            if (matches) {
                editor.remove(AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY);
            } else {
                editor.putString(
                        AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY,
                        "BES rebooted with an unexpected firmware version");
            }
            if (!editor.commit()) {
                // commit() updates this process's preference memory before reporting a disk error.
                // Replace any visible-but-uncommitted success with failure/quarantine now; the
                // timeout path must never be asked to guess whether this transition committed.
                if (!persistTerminalFailureQuarantineLocked(
                        current, "Could not durably complete BES version verification")) {
                    Log.e(TAG, "Could not persist fail-closed BES verification outcome");
                }
                return PostApplyVerification.PERSISTENCE_FAILURE;
            }
            return matches
                    ? PostApplyVerification.VERIFIED
                    : PostApplyVerification.VERSION_MISMATCH;
        }
    }

    /** Convert a timed-out verification into durable quarantine for the rest of this boot. */
    public BesUartTransportCoordinator.PostApplyFailureResolution abandonPostApplyVerification() {
        return abandonPostApplyVerification(
                "BES rebooted but target version could not be verified; reboot glasses");
    }

    /**
     * Atomically claim timeout failure, or report that verification already resolved the record.
     */
    @Override
    public BesUartTransportCoordinator.PostApplyFailureResolution abandonPostApplyVerification(
            String diagnostic) {
        synchronized (RESERVATION_LOCK) {
            if (!isApplyPendingLocked()) {
                // A successful/mismatched verification replaces apply_pending and terminal status
                // in one commit under this same lock. Only that durable terminal proves a late
                // timeout lost the race; a missing terminal must itself fail closed.
                if (hasTerminalOutcomeLocked()) {
                    return BesUartTransportCoordinator.PostApplyFailureResolution.ALREADY_RESOLVED;
                }
            }
            String current = currentBootId();
            if (current == null) {
                return BesUartTransportCoordinator.PostApplyFailureResolution.PERSISTENCE_FAILURE;
            }
            return persistTerminalFailureQuarantineLocked(current, diagnostic)
                    ? BesUartTransportCoordinator.PostApplyFailureResolution.ABANDONED
                    : BesUartTransportCoordinator.PostApplyFailureResolution.PERSISTENCE_FAILURE;
        }
    }

    private boolean hasTerminalOutcomeLocked() {
        String status =
                preferences.getString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, null);
        return "FINISHED".equals(status) || "FAILED".equals(status);
    }

    private boolean persistTerminalFailureQuarantineLocked(String current, String diagnostic) {
        // Persist the boot that failed as the ordinary authorization marker. This restores UART
        // quarantine after an ASG/serial restart until the user reboots once more.
        return preferences
                .edit()
                .putString(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY, current)
                .remove(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY)
                .putBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false)
                .remove(AsgConstants.BES_OTA_AUTH_GATE_VERIFICATION_BOOT_ID_KEY)
                .putString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, "FAILED")
                .putString(
                        AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY,
                        diagnostic != null ? diagnostic : "BES update failed")
                .commit();
    }

    private String attemptedBootId() {
        return preferences.getString(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY, null);
    }

    private String verificationBootId() {
        return preferences.getString(AsgConstants.BES_OTA_AUTH_GATE_VERIFICATION_BOOT_ID_KEY, null);
    }

    private boolean isApplyPendingLocked() {
        return preferences.getBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false);
    }

    private String claimVerificationBootLocked(String current, String attempted) {
        if (current == null || attempted == null || current.equals(attempted)) {
            return verificationBootId();
        }
        String verificationBoot = verificationBootId();
        if (verificationBoot != null) {
            return verificationBoot;
        }
        if (!preferences
                .edit()
                .putString(AsgConstants.BES_OTA_AUTH_GATE_VERIFICATION_BOOT_ID_KEY, current)
                .commit()) {
            Log.e(TAG, "Could not durably claim the BES post-apply verification boot");
            return null;
        }
        return current;
    }

    private String expectedTargetVersionLocked() {
        return preferences.getString(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY, "").trim();
    }

    private boolean clearLocked() {
        return preferences
                .edit()
                .remove(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY)
                .remove(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY)
                .remove(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY)
                .remove(AsgConstants.BES_OTA_AUTH_GATE_VERIFICATION_BOOT_ID_KEY)
                .remove(AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY)
                .commit();
    }

    /**
     * Canonical four-byte firmware identity used by release metadata and the embedded image.
     * Runtime feature gates tolerate display suffixes, but a suffixed value cannot be proven from
     * the four version bytes validated in the OTA artifact and therefore remains inadmissible here.
     */
    static String canonicalExactTargetVersion(String value) {
        if (value == null) {
            return null;
        }
        String[] parts = value.trim().split("\\.", -1);
        if (parts.length != 4) {
            return null;
        }
        StringBuilder canonical = new StringBuilder();
        for (String part : parts) {
            if (!part.matches("\\d{1,3}")) {
                return null;
            }
            int component;
            try {
                component = Integer.parseInt(part);
            } catch (NumberFormatException e) {
                return null;
            }
            if (component > 255) {
                return null;
            }
            if (canonical.length() > 0) {
                canonical.append('.');
            }
            canonical.append(component);
        }
        return canonical.toString();
    }

    String currentBootId() {
        if (bootIdProvider != null) {
            return bootIdProvider.currentBootId();
        }
        try (BufferedReader reader = new BufferedReader(new FileReader(LINUX_BOOT_ID_PATH))) {
            String id = reader.readLine();
            if (id != null && !id.trim().isEmpty()) {
                return "linux:" + id.trim();
            }
        } catch (Exception e) {
            Log.e(TAG, "Stable Linux boot identity is unavailable", e);
            return null;
        }
        Log.e(TAG, "Stable Linux boot identity is empty");
        return null;
    }

    interface BootIdProvider {
        String currentBootId();
    }
}
