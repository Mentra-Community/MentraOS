package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;
import com.mentra.asg_client.io.media.core.BlePhotoTimingLog;
import java.util.Arrays;
import java.util.Locale;

/**
 * Per-transfer latency samples for Mentra vs K900Server benchmarking.
 *
 * <p>{@code ack_to_send_ms} is Mentra-owned turnaround (ACK observed → next packet write started).
 * {@code packet_rtt_ms} is send → matching ACK (includes BES/BLE wait).
 */
public final class FileTransferLatencyStats {
    public static final String TAG = "FileTransferLatency";

    private static final int MAX_SAMPLES = 4096;

    private final long[] ackToSendMs = new long[MAX_SAMPLES];
    private final long[] packetRttMs = new long[MAX_SAMPLES];
    private int ackToSendCount;
    private int packetRttCount;
    private long pendingAckSeenAtNs = -1L;
    private final long startTimeNs = System.nanoTime();
    private int packetsAcked;

    /** Mark that a file-transfer ACK was observed on the receive path. */
    public synchronized void onAckSeen() {
        pendingAckSeenAtNs = System.nanoTime();
    }

    /**
     * Record Mentra turnaround if an ACK was pending when the next packet write starts.
     *
     * @return recorded {@code ack_to_send_ms}, or -1 if no pending ACK
     */
    public synchronized long onPacketSendStarted() {
        if (pendingAckSeenAtNs < 0) {
            return -1L;
        }
        long ms = (System.nanoTime() - pendingAckSeenAtNs) / 1_000_000L;
        pendingAckSeenAtNs = -1L;
        if (ackToSendCount < MAX_SAMPLES) {
            ackToSendMs[ackToSendCount++] = Math.max(0L, ms);
        }
        return ms;
    }

    /** Record send→ACK RTT for an acked packet. */
    public synchronized void onPacketRtt(long rttMs) {
        if (rttMs < 0) {
            return;
        }
        packetsAcked++;
        if (packetRttCount < MAX_SAMPLES) {
            packetRttMs[packetRttCount++] = rttMs;
        }
    }

    public synchronized int getPacketsAcked() {
        return packetsAcked;
    }

    /**
     * Format and emit a one-line transfer summary for logcat harnesses and BlePhotoTimingLog.
     *
     * @return the summary string
     */
    public synchronized String finishAndLog(String fileName, long fileSizeBytes, int totalPackets) {
        long elapsedMs = Math.max(1L, (System.nanoTime() - startTimeNs) / 1_000_000L);
        double pps = packetsAcked * 1000.0 / elapsedMs;
        double kbps = fileSizeBytes * 1000.0 / elapsedMs / 1024.0;

        String summary =
                String.format(
                        Locale.US,
                        "SUMMARY file=%s size=%d packets=%d/%d elapsed_ms=%d"
                                + " ack_to_send_p50_ms=%s ack_to_send_p95_ms=%s"
                                + " packet_rtt_p50_ms=%s packet_rtt_p95_ms=%s"
                                + " packets_per_sec=%.1f kb_per_sec=%.1f samples_ack_to_send=%d"
                                + " samples_rtt=%d",
                        fileName != null ? fileName : "unknown",
                        fileSizeBytes,
                        packetsAcked,
                        totalPackets,
                        elapsedMs,
                        percentileOrNa(ackToSendMs, ackToSendCount, 0.50),
                        percentileOrNa(ackToSendMs, ackToSendCount, 0.95),
                        percentileOrNa(packetRttMs, packetRttCount, 0.50),
                        percentileOrNa(packetRttMs, packetRttCount, 0.95),
                        pps,
                        kbps,
                        ackToSendCount,
                        packetRttCount);

        Log.i(TAG, summary);
        BlePhotoTimingLog.event("TRANSFER", summary);
        return summary;
    }

    static String percentileOrNa(long[] values, int count, double percentile) {
        if (count <= 0) {
            return "na";
        }
        long[] copy = Arrays.copyOf(values, count);
        Arrays.sort(copy);
        int idx = (int) Math.ceil(percentile * count) - 1;
        if (idx < 0) {
            idx = 0;
        }
        if (idx >= count) {
            idx = count - 1;
        }
        return Long.toString(copy[idx]);
    }
}
