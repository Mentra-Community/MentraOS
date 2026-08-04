package com.mentra.asg_client.io.bes;

import android.content.Context;
import android.content.SharedPreferences;
import com.mentra.asg_client.AsgConstants;

/**
 * Access layer for the durable BES apply/verification handoff.
 *
 * <p>The authorization gate writes this record in the same SharedPreferences commit that consumes
 * the one post-reboot version proof. EventBus may wake a live OTA service, but this record remains
 * the source of truth when verification wins the startup race.
 */
public final class BesOtaHandoffStore {
    /** Serializes every in-process reader and writer of the multi-key handoff snapshot. */
    static final Object HANDOFF_LOCK = new Object();

    // SharedPreferences updates its process-local map even when commit() reports a disk failure.
    // Keep that state process-wide so a newly constructed gate cannot mistake the visible map for
    // durable proof that a competing verification/timeout transition completed.
    private static boolean terminalStateWriteFailed;

    private final SharedPreferences preferences;

    public BesOtaHandoffStore(Context context) {
        preferences =
                context.getApplicationContext()
                        .getSharedPreferences(
                                AsgConstants.BES_OTA_AUTH_GATE_PREFS, Context.MODE_PRIVATE);
    }

    /** True while an accepted apply is waiting for its one post-reboot version proof. */
    public boolean isApplyPending() {
        synchronized (HANDOFF_LOCK) {
            return preferences.getBoolean(
                    AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false);
        }
    }

    /** Return the verified terminal outcome that must be replayed, or {@code null}. */
    public TerminalOutcome getPendingTerminalOutcome() {
        synchronized (HANDOFF_LOCK) {
            String status =
                    preferences.getString(
                            AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, null);
            if (!"FINISHED".equals(status) && !"FAILED".equals(status)) {
                return null;
            }
            String error =
                    preferences.getString(
                            AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY, null);
            String sessionId =
                    preferences.getString(AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY, null);
            return new TerminalOutcome(sessionId, status, error);
        }
    }

    /** Persist a direct pre-apply BES failure so reconnect delivery remains restart-safe. */
    public boolean persistFailure(String sessionId, String errorMessage) {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return false;
        }
        synchronized (HANDOFF_LOCK) {
            boolean committed =
                    preferences
                            .edit()
                            .putString(
                                    AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY,
                                    sessionId.trim())
                            .putString(
                                    AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, "FAILED")
                            .putString(
                                    AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY,
                                    errorMessage != null ? errorMessage : "BES update failed")
                            .commit();
            recordTerminalStateCommit(committed);
            return committed;
        }
    }

    /** A later OTA session supersedes the prior terminal resend record. */
    public boolean clearTerminalOutcome() {
        synchronized (HANDOFF_LOCK) {
            boolean committed =
                    preferences
                            .edit()
                            .remove(AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY)
                            .remove(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY)
                            .remove(AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY)
                            .commit();
            recordTerminalStateCommit(committed);
            return committed;
        }
    }

    static boolean isVisibleTerminalStateKnownDurable() {
        synchronized (HANDOFF_LOCK) {
            return !terminalStateWriteFailed;
        }
    }

    static void recordTerminalStateCommit(boolean committed) {
        synchronized (HANDOFF_LOCK) {
            terminalStateWriteFailed = !committed;
        }
    }

    /** Immutable terminal result persisted by boot-B verification. */
    public static final class TerminalOutcome {
        private final String sessionId;
        private final String status;
        private final String errorMessage;

        TerminalOutcome(String sessionId, String status, String errorMessage) {
            this.sessionId = sessionId;
            this.status = status;
            this.errorMessage = errorMessage;
        }

        public String getSessionId() {
            return sessionId;
        }

        public String getStatus() {
            return status;
        }

        public String getErrorMessage() {
            return errorMessage;
        }
    }
}
