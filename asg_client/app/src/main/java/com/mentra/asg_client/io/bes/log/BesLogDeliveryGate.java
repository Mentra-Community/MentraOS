package com.mentra.asg_client.io.bes.log;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Master switch for everything that makes the BES send logs to the MTK on its own: the TRACE
 * subscription ({@code mh_rlog_sub}) and the saved crash dump pull.
 *
 * <p>Off by default. While it is off the ASG treats the BES as if it did not advertise {@code
 * wire_caps.crash_pull} or {@code rlog_*}: it never subscribes, never pulls a dump, and the BES
 * sends no log data and makes no log-driven wakes. The BES delivers nothing unless a consumer
 * subscribes, so this is the only switch needed. User-filed bug reports are not affected.
 *
 * <p>Debug override, persisted across restarts (needs the DUMP permission, so adb only):
 *
 * <pre>
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE -p com.mentra.asg_client --ez delivery true
 * </pre>
 */
public final class BesLogDeliveryGate {
    /** What ships. Flip this, not the debug override, to turn the feature on for everyone. */
    public static final boolean DEFAULT_ENABLED = false;

    private static final String PREFS = "bes_log_delivery_gate";
    private static final String KEY_ENABLED = "enabled";

    private static volatile Boolean sEnabled;

    private BesLogDeliveryGate() {}

    /** Loads the persisted override. Call once before the first sr_syvr is handled. */
    public static void init(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        sEnabled = prefs.contains(KEY_ENABLED) ? prefs.getBoolean(KEY_ENABLED, DEFAULT_ENABLED) : null;
    }

    public static boolean isEnabled() {
        Boolean enabled = sEnabled;
        return enabled != null ? enabled : DEFAULT_ENABLED;
    }

    /** Persists a debug override. Takes effect at the next sr_syvr from the BES. */
    public static void setOverride(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_ENABLED, enabled)
                .apply();
        sEnabled = enabled;
    }

    /** Tests only. {@code null} restores the default. */
    public static void setForTest(Boolean enabled) {
        sEnabled = enabled;
    }
}
