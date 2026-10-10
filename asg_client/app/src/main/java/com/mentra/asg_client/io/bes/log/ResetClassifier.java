package com.mentra.asg_client.io.bes.log;

/**
 * Decides whether the reason the current BES boot started ({@code sr_syvr crash.reset_hw} and
 * {@code reset_sw}) makes the end of the previous boot an unexpected reset worth an incident.
 *
 * <p>The authoritative reset-code table belongs to the BES firmware
 * ({@code mentra-live-bes/docs/crash-timestamps.md}); until it is available the collector uses
 * {@link DefaultResetClassifier}. Replace the instance with
 * {@link BesCrashDumpCollector#setResetClassifier} once the table exists.
 */
public interface ResetClassifier {
    /** True only when the reset is known to be abnormal (watchdog, exception, brown-out...). */
    boolean isUnexpected(long resetHw, long resetSw);
}
