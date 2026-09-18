package com.mentra.asg_client.io.bes.log;

/**
 * Decides whether a quiet BES UART is a fault or just an idle link.
 *
 * <p>Silence alone proves nothing. On an idle, charging device BES parks the Classic link in sniff
 * mode ({@code ibrt_sniff_mgr:[dev 0]sniff allowed}) and legitimately says nothing for 30s or more.
 * Treating that as a wedged chip produced false BES reboots on a perfectly healthy device, and each
 * one triggered an expensive trace dump that spiked CPU and flooded the report log window.
 *
 * <p>Silence is only evidence of a fault when BES owed us something:
 *
 * <ul>
 *   <li>an unanswered write — BES accepted bytes into its UART FIFO and never replied, or
 *   <li>an active stream — BES is carrying the mic uplink and controller probe acks, so it is never
 *       legitimately quiet for long.
 * </ul>
 */
public final class BesStallPolicy {

    private BesStallPolicy() {}

    /**
     * @param silentMs how long nothing has arrived from BES
     * @param unansweredWrites writes issued since the last inbound frame
     * @param streamActive whether a camera stream is running
     * @param streamSilenceFaultMs silence that is already a fault while streaming
     * @return true when the silence is evidence of a wedged chip rather than an idle link
     */
    public static boolean isFault(
            long silentMs,
            int unansweredWrites,
            boolean streamActive,
            long streamSilenceFaultMs) {
        if (unansweredWrites > 0) {
            return true;
        }
        return streamActive && silentMs >= streamSilenceFaultMs;
    }

    /** Short label for the log, so an idle gap is never read as a stall. */
    public static String describe(
            long silentMs,
            int unansweredWrites,
            boolean streamActive,
            long streamSilenceFaultMs) {
        if (!isFault(silentMs, unansweredWrites, streamActive, streamSilenceFaultMs)) {
            return "idle";
        }
        return unansweredWrites > 0 ? "unanswered_write" : "stream_silence";
    }
}
