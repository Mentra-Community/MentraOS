package com.mentra.asg_client.io.bes;

import android.content.Context;

/**
 * Writes saved BES OTA states for tests in other packages (the store's reservation entry point is
 * package-private).
 */
public final class BesOtaSavedStateTestSupport {
    public static final String OWNER = "owner-1";
    private static final String BOOT = "boot-a";
    private static final String SHA =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private BesOtaSavedStateTestSupport() {}

    /** AUTH_ATTEMPTED: the first non-final state. */
    public static void reserve(Context context) {
        BesOtaStateStore.TransitionResult result = new BesOtaStateStore(context)
                .reserveAuthorization(OWNER, BOOT, "26.7.30.4", "bes-26.7.30.4-update_ota.bin", SHA);
        if (result != BesOtaStateStore.TransitionResult.APPLIED) {
            throw new IllegalStateException("reserve: " + result);
        }
    }

    /** APPLY_PENDING: waiting for the apply and the restart. */
    public static void markApplyPending(Context context) {
        BesOtaStateStore.TransitionResult result =
                new BesOtaStateStore(context).markApplyPending(OWNER);
        if (result != BesOtaStateStore.TransitionResult.APPLIED) {
            throw new IllegalStateException("markApplyPending: " + result);
        }
    }

    /** TERMINAL (failure): the OTA is over. */
    public static void fail(Context context) {
        new BesOtaStateStore(context).fail(OWNER, "test_done");
    }

    public static boolean isTerminal(Context context) {
        return new BesOtaStateStore(context).read().getState() == BesOtaStateStore.State.TERMINAL;
    }
}
