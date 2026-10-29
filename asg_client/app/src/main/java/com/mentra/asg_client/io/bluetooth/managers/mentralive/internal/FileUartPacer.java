package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

/**
 * Spaces BES file frames on the MTK→BES UART so they never arrive faster than a configured byte
 * rate.
 *
 * <p>Firmware without {@code wire_caps.uart_rx_pos} drains its 4 KB ping-pong RX DMA by counting
 * completion interrupts. When an interrupt is delayed past a whole 2 KB half (A2DP stream start
 * stalls it for tens of milliseconds), the completions coalesce, the consumer falls a half out of
 * phase, and every later block arrives with corrupted bytes until RX is re-armed. At line rate a
 * half fills in 17.8 ms; pacing keeps the stall from filling one.
 *
 * <p>Not thread-safe: the file transfer monitor serializes access.
 */
public final class FileUartPacer {
    private static final long NANOS_PER_SECOND = 1_000_000_000L;

    private final long bytesPerSecond;
    private long nextAllowedNanos;
    private boolean started;

    /** @param bytesPerSecond maximum average wire rate for file frames; must be positive */
    public FileUartPacer(long bytesPerSecond) {
        if (bytesPerSecond <= 0) {
            throw new IllegalArgumentException("bytesPerSecond must be positive");
        }
        this.bytesPerSecond = bytesPerSecond;
    }

    /** Nanoseconds until the next frame may be written; 0 means it may be written now. */
    public long delayNanos(long nowNanos) {
        return started ? Math.max(0L, nextAllowedNanos - nowNanos) : 0L;
    }

    /**
     * Record a frame written at {@code nowNanos}. Idle time is never banked as credit: after a
     * pause the next frame goes out immediately and the one after it is spaced again.
     */
    public void onSent(int bytes, long nowNanos) {
        long start = started ? Math.max(nextAllowedNanos, nowNanos) : nowNanos;
        nextAllowedNanos = start + bytes * NANOS_PER_SECOND / bytesPerSecond;
        started = true;
    }
}
