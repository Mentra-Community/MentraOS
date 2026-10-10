package com.mentra.asg_client.io.bes.log;

import java.io.File;

/**
 * Freezes the pre-reset window of the rolling BES TRACE store into an incident bundle. The
 * production implementation is {@link BesTraceStoreFreezer}, which calls
 * {@code BesTraceStore.freeze(File, long, long, int)} from the OS-1988 contract (section 7).
 */
public interface TraceFreezer {
    /** Mirror of {@code BesTraceStore.Frozen}. */
    final class Result {
        public final int lines;
        public final long bytes;
        public final long firstWallMs;
        public final long lastWallMs;
        public final int gaps;
        public final boolean truncated;

        public Result(int lines, long bytes, long firstWallMs, long lastWallMs, int gaps,
                boolean truncated) {
            this.lines = lines;
            this.bytes = bytes;
            this.firstWallMs = firstWallMs;
            this.lastWallMs = lastWallMs;
            this.gaps = gaps;
            this.truncated = truncated;
        }
    }

    /**
     * Copies stored lines with wallMs in [fromWallMs, toWallMs] into {@code destination} (tmp
     * file, fsync, rename), newest kept when over maxBytes, and never removes anything from the
     * store.
     *
     * @return the copy's statistics, or null when no store is available (no file is written)
     */
    Result freeze(File destination, long fromWallMs, long toWallMs, int maxBytes);
}
