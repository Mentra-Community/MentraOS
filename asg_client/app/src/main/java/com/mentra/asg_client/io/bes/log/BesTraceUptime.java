package com.mentra.asg_client.io.bes.log;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads the millisecond uptime counter BES stamps on every trace line.
 *
 * <p>BES keeps no persistent crash record and its trace ring holds only ~20s, so a watchdog reboot
 * is visible only as this counter jumping backwards. Pairing the newest counter with the wall clock
 * at capture time also dates the boot, which is what places a BES crash on the phone's timeline.
 */
public final class BesTraceUptime {

    /** Absent or unparseable uptime. */
    public static final long UNKNOWN = -1L;

    /**
     * Matches the {@code "49391/I/NONE  /  6 | <<<lxy ..."} prefix: uptime, level, tag, core id.
     *
     * <p>Anchored on the letter between the first two slashes so the hex byte dumps that interleave
     * with trace text (which contain bare {@code "7/ 11 |"}-shaped runs) cannot match.
     */
    private static final Pattern TRACE_LINE =
            Pattern.compile("(\\d{3,10})/[A-Z]/\\S*\\s*/\\s*\\d+\\s*\\|");

    /** A reboot must move the counter back by more than the jitter between two snapshots. */
    private static final long REGRESSION_TOLERANCE_MS = 2_000L;

    private BesTraceUptime() {}

    /** Highest uptime in the snapshot: how long BES had been up when the buffer was read. */
    public static long newestUptimeMs(String trace) {
        long newest = UNKNOWN;
        Matcher matcher = matcher(trace);
        while (matcher != null && matcher.find()) {
            long uptime = parse(matcher.group(1));
            if (uptime > newest) {
                newest = uptime;
            }
        }
        return newest;
    }

    /** Lowest uptime in the snapshot: how far back the ring still reaches. */
    public static long oldestUptimeMs(String trace) {
        long oldest = UNKNOWN;
        Matcher matcher = matcher(trace);
        while (matcher != null && matcher.find()) {
            long uptime = parse(matcher.group(1));
            if (uptime >= 0 && (oldest == UNKNOWN || uptime < oldest)) {
                oldest = uptime;
            }
        }
        return oldest;
    }

    /** Wall time BES booted, so its uptime-stamped lines can be read against phone logs. */
    public static long impliedBootWallMs(long uptimeMs, long wallNowMs) {
        if (uptimeMs < 0) {
            return UNKNOWN;
        }
        return wallNowMs - uptimeMs;
    }

    /** True when {@code uptimeMs} belongs to a later boot than {@code previousUptimeMs}. */
    public static boolean rebooted(long previousUptimeMs, long uptimeMs) {
        if (previousUptimeMs < 0 || uptimeMs < 0) {
            return false;
        }
        return uptimeMs + REGRESSION_TOLERANCE_MS < previousUptimeMs;
    }

    private static Matcher matcher(String trace) {
        if (trace == null || trace.isEmpty()) {
            return null;
        }
        return TRACE_LINE.matcher(trace);
    }

    private static long parse(String digits) {
        try {
            return Long.parseLong(digits);
        } catch (NumberFormatException e) {
            return UNKNOWN;
        }
    }
}
