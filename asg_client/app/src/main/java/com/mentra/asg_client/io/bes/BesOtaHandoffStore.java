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
    private final SharedPreferences preferences;

    public BesOtaHandoffStore(Context context) {
        preferences =
                context.getApplicationContext()
                        .getSharedPreferences(
                                AsgConstants.BES_OTA_AUTH_GATE_PREFS, Context.MODE_PRIVATE);
    }

    /** True while an accepted apply is waiting for its one post-reboot version proof. */
    public boolean isApplyPending() {
        return preferences.getBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false);
    }

    /** Return the verified terminal outcome that must be replayed, or {@code null}. */
    public TerminalOutcome getPendingTerminalOutcome() {
        String status =
                preferences.getString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, null);
        if (!"FINISHED".equals(status) && !"FAILED".equals(status)) {
            return null;
        }
        String error = preferences.getString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY, null);
        return new TerminalOutcome(status, error);
    }

    /** Persist a direct pre-apply BES failure so reconnect delivery remains restart-safe. */
    public boolean persistFailure(String errorMessage) {
        return preferences
                .edit()
                .putString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, "FAILED")
                .putString(
                        AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY,
                        errorMessage != null ? errorMessage : "BES update failed")
                .commit();
    }

    /** A later OTA session supersedes the prior terminal resend record. */
    public boolean clearTerminalOutcome() {
        return preferences
                .edit()
                .remove(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY)
                .remove(AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY)
                .commit();
    }

    /** Immutable terminal result persisted by boot-B verification. */
    public static final class TerminalOutcome {
        private final String status;
        private final String errorMessage;

        TerminalOutcome(String status, String errorMessage) {
            this.status = status;
            this.errorMessage = errorMessage;
        }

        public String getStatus() {
            return status;
        }

        public String getErrorMessage() {
            return errorMessage;
        }
    }
}
