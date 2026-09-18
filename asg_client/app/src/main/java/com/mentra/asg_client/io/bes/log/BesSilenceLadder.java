package com.mentra.asg_client.io.bes.log;

/**
 * Decides when a quiet BES UART has been quiet long enough to deserve a log line.
 *
 * <p>BES pushes unsolicited traffic (battery, BT state, link RSSI) every few seconds, so UART
 * silence is the earliest evidence that the chip has wedged — it precedes the phone's GATT
 * supervision timeout by tens of seconds. Reporting on a ladder rather than every tick keeps a long
 * stall from flooding the log window that has to hold the crash itself.
 */
public final class BesSilenceLadder {

    /** No rung was crossed by this observation. */
    public static final long NO_RUNG = -1L;

    private final long[] rungsMs;

    /**
     * Mutated only on the watchdog thread, but {@link #reported()} is read from the UART reader to
     * decide whether a resumed frame is worth reporting, so the write has to be visible there.
     */
    private volatile int nextRung;

    /** @param rungsMs ascending silence durations that each deserve exactly one report */
    public BesSilenceLadder(long[] rungsMs) {
        if (rungsMs == null || rungsMs.length == 0) {
            throw new IllegalArgumentException("rungsMs is required");
        }
        this.rungsMs = rungsMs.clone();
    }

    /**
     * @return the highest newly crossed rung, or {@link #NO_RUNG} when this silence has already
     *     been reported up to its current duration
     */
    public long onSilence(long silentMs) {
        long crossed = NO_RUNG;
        while (nextRung < rungsMs.length && silentMs >= rungsMs[nextRung]) {
            crossed = rungsMs[nextRung];
            nextRung++;
        }
        return crossed;
    }

    /** True once any rung has been reported, i.e. the silence was long enough to be notable. */
    public boolean reported() {
        return nextRung > 0;
    }

    /** Called when BES speaks again, so the next stall reports from the first rung. */
    public void reset() {
        nextRung = 0;
    }
}
