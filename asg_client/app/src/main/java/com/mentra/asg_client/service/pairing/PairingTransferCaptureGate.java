package com.mentra.asg_client.service.pairing;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Shared ownership-transfer capture barrier for Mentra Live pairing.
 *
 * <p>Kept outside command handlers and media capture so those layers can share barrier state without
 * a circular dependency.
 */
public final class PairingTransferCaptureGate {
    private static final String TAG = "PairingTransferCaptureGate";
    private static final String PREFS = "pairing_transfer_capture_gate";
    private static final String KEY_TRANSFER_ID = "transfer_id";
    private static final String KEY_UNTIL_MS = "until_ms";
    private static final Object LOCK = new Object();
    /** Matches BES ownership-transfer window (5 minutes). */
    private static final long TRANSFER_WINDOW_MS = 5 * 60 * 1000L;

    private PairingTransferCaptureGate() {}

    public static void arm(Context context, String transferId) {
        if (context == null || transferId == null || transferId.isEmpty()) {
            return;
        }
        synchronized (LOCK) {
            SharedPreferences prefs =
                    context.getApplicationContext()
                            .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            prefs.edit()
                    .putString(KEY_TRANSFER_ID, transferId)
                    .putLong(KEY_UNTIL_MS, System.currentTimeMillis() + TRANSFER_WINDOW_MS)
                    .apply();
        }
        Log.i(TAG, "Armed capture barrier transfer_id=" + transferId);
    }

    /** True while an ownership-transfer capture barrier is active for any transfer. */
    public static boolean isActive(Context context) {
        if (context == null) {
            return false;
        }
        synchronized (LOCK) {
            SharedPreferences prefs =
                    context.getApplicationContext()
                            .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long until = prefs.getLong(KEY_UNTIL_MS, 0L);
            if (until <= 0L) {
                return false;
            }
            if (System.currentTimeMillis() > until) {
                if (prefs.getLong(KEY_UNTIL_MS, 0L) == until) {
                    prefs.edit().clear().apply();
                }
                return false;
            }
            String transferId = prefs.getString(KEY_TRANSFER_ID, null);
            return transferId != null && !transferId.isEmpty();
        }
    }

    /**
     * Clear the barrier only when {@code transferId} identifies the transfer that armed it.
     *
     * @return true when a matching barrier was cleared
     */
    public static boolean clear(Context context, String transferId) {
        if (context == null || transferId == null || transferId.isEmpty()) {
            return false;
        }
        synchronized (LOCK) {
            SharedPreferences prefs =
                    context.getApplicationContext()
                            .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!transferId.equals(prefs.getString(KEY_TRANSFER_ID, null))) {
                return false;
            }
            prefs.edit().clear().apply();
        }
        Log.i(TAG, "Cleared capture barrier transfer_id=" + transferId);
        return true;
    }

    /** Unconditionally clear the barrier. Intended for test isolation. */
    public static void clear(Context context) {
        if (context == null) {
            return;
        }
        synchronized (LOCK) {
            context.getApplicationContext()
                    .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .clear()
                    .apply();
        }
        Log.i(TAG, "Cleared capture barrier");
    }
}
