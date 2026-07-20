package com.mentra.asg_client.io.media.core;

import android.util.Log;
import androidx.annotation.Nullable;
import com.mentra.asg_client.AsgConstants;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Human-readable {@code ⏱️ [BLE PHOTO]} timing lines for the take_photo → AVIF → BLE pipeline. */
public final class BlePhotoTimingLog {
    public static final String TAG = "BlePhotoTiming";
    private static final Map<String, UartTransferStats> UART_TRANSFER_STATS =
            new ConcurrentHashMap<>();

    /**
     * Optional sink that folds camera-side capture/storage checkpoints into the same request-scoped
     * phase table used by {@code MediaCaptureService.dumpTimings}. Bound for the duration of one
     * BLE photo capture.
     */
    public interface PhaseSink {
        void onPhase(String step, @Nullable String detail);

        /** Optional: warm-session / JPEG resolution for the end-of-pipeline PHASE SUMMARY. */
        default void onCaptureSession(CaptureSessionStats stats) {}
    }

    /**
     * Short reason codes written into {@link CaptureSessionStats#note} for the PHASE SUMMARY
     * CAPTURE SESSION block. Keep these human-readable in the VALUE column.
     */
    public static final class WarmSessionReason {
        public static final String NO_WARMUP = "no warmup";
        public static final String LEASE_EXPIRED = "expired";
        public static final String MISMATCH = "mismatch";
        public static final String MISMATCH_SDK = "mismatch sdk";
        public static final String MISMATCH_EXPOSURE = "mismatch exposure";

        private WarmSessionReason() {}

        /** e.g. {@code mismatch medium→text} */
        public static String mismatchSize(@Nullable String warmTier, @Nullable String captureTier) {
            return "mismatch "
                    + (warmTier != null ? warmTier : "?")
                    + "→"
                    + (captureTier != null ? captureTier : "?");
        }
    }

    /**
     * Whether this capture reused a warmed HAL session and at what sensor JPEG size. Surfaced in
     * the PHASE SUMMARY so warm-up ↔ take_photo resolution alignment is easy to verify.
     */
    public static final class CaptureSessionStats {
        public final boolean reusedWarmSession;
        @Nullable public final String sizeTier;
        public final int jpegWidth;
        public final int jpegHeight;
        /** Short {@link WarmSessionReason} code when not reused; null when reused. */
        @Nullable public final String note;

        public CaptureSessionStats(
                boolean reusedWarmSession,
                @Nullable String sizeTier,
                int jpegWidth,
                int jpegHeight,
                @Nullable String note) {
            this.reusedWarmSession = reusedWarmSession;
            this.sizeTier = sizeTier;
            this.jpegWidth = Math.max(0, jpegWidth);
            this.jpegHeight = Math.max(0, jpegHeight);
            this.note = note;
        }
    }

    /** Publish capture-session warmth/resolution into the bound BLE phase sink (if any). */
    public static void captureSession(
            boolean reusedWarmSession,
            @Nullable String sizeTier,
            int jpegWidth,
            int jpegHeight,
            @Nullable String note) {
        if (!enabled()) {
            return;
        }
        CaptureSessionStats stats =
                new CaptureSessionStats(
                        reusedWarmSession, sizeTier, jpegWidth, jpegHeight, note);
        PhaseSink sink;
        synchronized (PHASE_SINK_LOCK) {
            sink = activePhaseSink;
        }
        if (sink != null) {
            sink.onCaptureSession(stats);
        }
    }

    private static final Object PHASE_SINK_LOCK = new Object();
    @Nullable private static PhaseSink activePhaseSink;

    private BlePhotoTimingLog() {}

    /** Bind the active BLE photo request so camera/storage steps appear in PHASE BREAKDOWN. */
    public static void bindPhaseSink(@Nullable PhaseSink sink) {
        synchronized (PHASE_SINK_LOCK) {
            activePhaseSink = sink;
        }
    }

    /** Clear the active sink when the BLE capture callback finishes or fails. */
    public static void unbindPhaseSink(@Nullable PhaseSink sink) {
        synchronized (PHASE_SINK_LOCK) {
            if (sink == null || activePhaseSink == sink) {
                activePhaseSink = null;
            }
        }
    }

    /**
     * Record a capture/storage checkpoint. Emits a live log line and, when a phase sink is bound,
     * also appends the step to the request PHASE BREAKDOWN table.
     */
    public static void capturePhase(String step, @Nullable String detail) {
        if (!enabled()) {
            return;
        }
        event("CAPTURE", detail != null && !detail.isEmpty() ? step + " — " + detail : step);
        PhaseSink sink;
        synchronized (PHASE_SINK_LOCK) {
            sink = activePhaseSink;
        }
        if (sink != null) {
            sink.onPhase(step, detail);
        }
    }

    /** Record the completed glasses-MCU packet transfer for the final pipeline summary. */
    public static void recordUartTransfer(String bleImgId, long payloadBytes, long durationMs) {
        recordUartTransfer(bleImgId, payloadBytes, durationMs, null);
    }

    /**
     * Record UART/BLE packet transfer stats, optionally including Mentra vs K900Server packet
     * clocks ({@code ack_to_send} / {@code packet_rtt} / packets-per-sec) for the PHASE BREAKDOWN
     * report.
     */
    public static void recordUartTransfer(
            String bleImgId,
            long payloadBytes,
            long durationMs,
            @Nullable PacketClockStats packetClocks) {
        if (!enabled() || bleImgId == null || bleImgId.isEmpty()) {
            return;
        }
        UART_TRANSFER_STATS.put(
                bleImgId,
                new UartTransferStats(
                        payloadBytes, durationMs, System.currentTimeMillis(), packetClocks));
    }

    /** Consume UART transfer stats for a finished BLE file transfer (may be null). */
    @Nullable
    public static UartTransferStats takeUartTransfer(String bleImgId) {
        if (bleImgId == null || bleImgId.isEmpty()) {
            return null;
        }
        return UART_TRANSFER_STATS.remove(bleImgId);
    }

    public static void event(String category, String message) {
        if (!enabled()) {
            return;
        }
        Log.i(TAG, "⏱️ [BLE PHOTO] " + category + ": " + message);
    }

    static boolean enabled() {
        return AsgConstants.ENABLE_PHOTO_TIMING_LOGS;
    }

    static void requestStep(
            String requestId, String step, String detail, long sinceRequestMs, long sinceLastMs) {
        if (!enabled() || requestId == null || requestId.isEmpty()) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("⏱️ [BLE PHOTO] ").append(label(step));
        if (detail != null && !detail.isEmpty()) {
            sb.append(" — ").append(detail);
        }
        sb.append(" | requestId=").append(requestId);
        sb.append(" | since_request=").append(sinceRequestMs).append("ms");
        sb.append(" | since_last_step=").append(sinceLastMs).append("ms");
        Log.i(TAG, sb.toString());
    }

    static void pipelineDone(
            String requestId,
            String bleImgId,
            boolean success,
            long totalMs,
            Map<String, Long> phases,
            int encodeCalls,
            long encodeTotalMs,
            long originalBytes,
            long compressedBytes,
            @Nullable UartTransferStats uart,
            @Nullable PayloadReductionStats reduction) {
        if (!enabled()) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("⏱️ [BLE PHOTO] PIPELINE FINISHED");
        sb.append(" | requestId=").append(requestId);
        sb.append(" | bleImgId=").append(bleImgId);
        sb.append(" | success=").append(success);
        sb.append(" | total=").append(totalMs).append("ms");
        // Verification: should always read "encode_calls=1". A count > 1 means the payload was
        // encoded more than once (e.g. a regression to the old dual JPEG+AVIF path) and
        // encode_total_ms will show the actual wasted encoder time for this request.
        sb.append(" | encode_calls=").append(encodeCalls);
        sb.append(" | encode_total_ms=").append(encodeTotalMs);
        if (encodeCalls > 1) {
            sb.append(" ⚠️REDUNDANT_ENCODE");
        }
        appendSizeAndSpeed(sb, originalBytes, compressedBytes, uart, phases, reduction);
        if (phases != null && !phases.isEmpty()) {
            sb.append(" | ");
            appendMilestoneDurations(sb, phases);
        }
        Log.i(TAG, sb.toString());
    }

    /**
     * Mentra-owned packet clocks for comparing against K900Server (~1ms ack→send, ~11ms RTT, ~90
     * packets/s). Values of {@code -1} mean "no samples".
     */
    public static final class PacketClockStats {
        public final long ackToSendP50Ms;
        public final long ackToSendP95Ms;
        public final long packetRttP50Ms;
        public final long packetRttP95Ms;
        public final double packetsPerSec;
        public final int packetsAcked;
        public final int totalPackets;

        public PacketClockStats(
                long ackToSendP50Ms,
                long ackToSendP95Ms,
                long packetRttP50Ms,
                long packetRttP95Ms,
                double packetsPerSec,
                int packetsAcked,
                int totalPackets) {
            this.ackToSendP50Ms = ackToSendP50Ms;
            this.ackToSendP95Ms = ackToSendP95Ms;
            this.packetRttP50Ms = packetRttP50Ms;
            this.packetRttP95Ms = packetRttP95Ms;
            this.packetsPerSec = packetsPerSec;
            this.packetsAcked = packetsAcked;
            this.totalPackets = totalPackets;
        }
    }

    public static final class UartTransferStats {
        public final long payloadBytes;
        public final long durationMs;
        /** Wall-clock millis when the last UART/BLE packet was MCU-ACKed. */
        public final long packetsCompleteAtEpochMs;
        /** Optional Mentra packet-clock samples for the PHASE BREAKDOWN report. */
        @Nullable public final PacketClockStats packetClocks;

        UartTransferStats(long payloadBytes, long durationMs, long packetsCompleteAtEpochMs) {
            this(payloadBytes, durationMs, packetsCompleteAtEpochMs, null);
        }

        UartTransferStats(
                long payloadBytes,
                long durationMs,
                long packetsCompleteAtEpochMs,
                @Nullable PacketClockStats packetClocks) {
            this.payloadBytes = payloadBytes;
            this.durationMs = durationMs;
            this.packetsCompleteAtEpochMs = packetsCompleteAtEpochMs;
            this.packetClocks = packetClocks;
        }
    }

    /**
     * Source / crop / encode geometry for attributing BLE payload savings to cropping versus a
     * no-crop BLE encode at the same target/quality. TX savings must NOT be computed against the
     * raw sensor JPEG — without cropping we still downscale+encode before BLE.
     */
    public static final class PayloadReductionStats {
        public final int sourceWidth;
        public final int sourceHeight;
        public final int cropWidth;
        public final int cropHeight;
        public final int encodeWidth;
        public final int encodeHeight;
        public final int bleTargetWidth;
        public final int bleTargetHeight;
        public final boolean cropApplied;
        /** Wall-clock time spent in text-region detection + bitmap crop. */
        public final long cropDurationMs;
        /** True when the crop pipeline ran (even if it fell back to full frame). */
        public final boolean cropAttempted;

        /** Measured no-crop BLE payload bytes from a real background re-encode (0 = not run). */
        private volatile long measuredFullFrameBytes;

        /** Measured no-crop decode+resize+sharpen+encode wall time (0 = not run). */
        private volatile long measuredFullFrameProcessMs;

        /** Records the measured no-crop baseline once the background re-encode finishes. */
        public void setMeasuredFullFrameBaseline(long payloadBytes, long processMs) {
            this.measuredFullFrameBytes = Math.max(0L, payloadBytes);
            this.measuredFullFrameProcessMs = Math.max(0L, processMs);
        }

        public long measuredFullFrameBytes() {
            return measuredFullFrameBytes;
        }

        public long measuredFullFrameProcessMs() {
            return measuredFullFrameProcessMs;
        }

        public PayloadReductionStats(
                int sourceWidth,
                int sourceHeight,
                int cropWidth,
                int cropHeight,
                int encodeWidth,
                int encodeHeight,
                int bleTargetWidth,
                int bleTargetHeight,
                boolean cropApplied,
                long cropDurationMs,
                boolean cropAttempted) {
            this.sourceWidth = Math.max(0, sourceWidth);
            this.sourceHeight = Math.max(0, sourceHeight);
            this.cropWidth = Math.max(0, cropWidth);
            this.cropHeight = Math.max(0, cropHeight);
            this.encodeWidth = Math.max(0, encodeWidth);
            this.encodeHeight = Math.max(0, encodeHeight);
            this.bleTargetWidth = Math.max(0, bleTargetWidth);
            this.bleTargetHeight = Math.max(0, bleTargetHeight);
            this.cropApplied = cropApplied;
            this.cropDurationMs = Math.max(0L, cropDurationMs);
            this.cropAttempted = cropAttempted;
        }
    }

    /** Aspect-fit {@code src} inside {@code max} without upscaling. */
    static int[] fitInsideNoUpscale(int srcW, int srcH, int maxW, int maxH) {
        if (srcW <= 0 || srcH <= 0) {
            return new int[] {0, 0};
        }
        if (maxW <= 0 || maxH <= 0) {
            return new int[] {srcW, srcH};
        }
        float scale = Math.min(1f, Math.min(maxW / (float) srcW, maxH / (float) srcH));
        return new int[] {
            Math.max(1, Math.round(srcW * scale)), Math.max(1, Math.round(srcH * scale))
        };
    }

    /**
     * Estimates the BLE payload we would have sent for a full-frame (no-crop) encode at the same
     * codec/quality/target, by scaling the actual cropped payload by encode-pixel area.
     */
    static long estimateFullFrameBlePayloadBytes(
            long croppedPayloadBytes, @Nullable PayloadReductionStats reduction) {
        if (croppedPayloadBytes <= 0 || reduction == null) {
            return 0L;
        }
        long cropEncodePixels = (long) reduction.encodeWidth * reduction.encodeHeight;
        if (cropEncodePixels <= 0) {
            return 0L;
        }
        int[] fullEncode =
                fitInsideNoUpscale(
                        reduction.sourceWidth,
                        reduction.sourceHeight,
                        reduction.bleTargetWidth > 0
                                ? reduction.bleTargetWidth
                                : reduction.encodeWidth,
                        reduction.bleTargetHeight > 0
                                ? reduction.bleTargetHeight
                                : reduction.encodeHeight);
        long fullEncodePixels = (long) fullEncode[0] * fullEncode[1];
        if (fullEncodePixels <= 0) {
            return croppedPayloadBytes;
        }
        // Same quality/codec: payload roughly tracks encode pixels. Never report smaller than the
        // cropped payload when crop kept fewer pixels.
        return Math.max(
                croppedPayloadBytes,
                Math.round(
                        croppedPayloadBytes
                                * (double) fullEncodePixels
                                / (double) cropEncodePixels));
    }

    /**
     * The no-crop BLE payload baseline: prefers the measured background re-encode, falling back to
     * the area-proportional estimate when the measurement has not completed or was skipped.
     */
    static long baselineFullFrameBlePayloadBytes(
            long croppedPayloadBytes, @Nullable PayloadReductionStats reduction) {
        if (reduction == null) {
            return 0L;
        }
        long measured = reduction.measuredFullFrameBytes();
        if (measured > 0) {
            return measured;
        }
        return estimateFullFrameBlePayloadBytes(croppedPayloadBytes, reduction);
    }

    private static void appendSizeAndSpeed(
            StringBuilder sb,
            long originalBytes,
            long compressedBytes,
            @Nullable UartTransferStats uart,
            @Nullable Map<String, Long> phases,
            @Nullable PayloadReductionStats reduction) {
        long payloadBytes =
                compressedBytes > 0
                        ? compressedBytes
                        : (uart != null ? uart.payloadBytes : 0L);
        if (originalBytes > 0) {
            sb.append(" | original=")
                    .append(originalBytes)
                    .append(" bytes (")
                    .append(String.format(Locale.US, "%.1f", originalBytes / 1024.0))
                    .append("KB)");
        }
        if (payloadBytes > 0) {
            sb.append(" | payload=")
                    .append(payloadBytes)
                    .append(" bytes (")
                    .append(String.format(Locale.US, "%.1f", payloadBytes / 1024.0))
                    .append("KB)");
        }
        appendReductionInline(sb, originalBytes, payloadBytes, reduction);
        long uartMs = uart != null ? uart.durationMs : 0L;
        if (uart != null && uartMs > 0) {
            double uartSpeedKBs = uart.payloadBytes * 1000.0 / uartMs / 1024.0;
            sb.append(" | uart_tx=").append(uartMs).append("ms");
            sb.append(" | uart_speed=")
                    .append(String.format(Locale.US, "%.1f", uartSpeedKBs))
                    .append("KB/s");
        }
        if (uart != null && uart.packetClocks != null) {
            PacketClockStats clocks = uart.packetClocks;
            if (clocks.ackToSendP50Ms >= 0) {
                sb.append(" | ack_to_send_p50=").append(clocks.ackToSendP50Ms).append("ms");
            }
            if (clocks.packetRttP50Ms >= 0) {
                sb.append(" | packet_rtt_p50=").append(clocks.packetRttP50Ms).append("ms");
            }
            if (clocks.packetsPerSec > 0) {
                sb.append(" | packets_per_sec=")
                        .append(String.format(Locale.US, "%.1f", clocks.packetsPerSec));
            }
        }
        long transferStart = phaseMs(phases, "ble_file_transfer_start");
        long transferDone = phaseMs(phases, "ble_transfer_complete");
        if (payloadBytes > 0 && transferStart > 0 && transferDone > transferStart) {
            long phoneRoundTripMs = transferDone - transferStart;
            double e2eSpeedKBs = payloadBytes * 1000.0 / phoneRoundTripMs / 1024.0;
            sb.append(" | transfer_round_trip=").append(phoneRoundTripMs).append("ms");
            sb.append(" | transfer_speed=")
                    .append(String.format(Locale.US, "%.1f", e2eSpeedKBs))
                    .append("KB/s");
        }
        long phoneAckWaitMs = phoneAckWaitMs(uart, transferDone);
        if (phoneAckWaitMs >= 0) {
            sb.append(" | last_packet_to_phone_ack=").append(phoneAckWaitMs).append("ms");
        }
    }

    /**
     * Milliseconds from last MCU-ACKed UART/BLE packet to phone {@code transfer_complete}, or
     * {@code -1} when either timestamp is missing.
     */
    static long phoneAckWaitMs(@Nullable UartTransferStats uart, long transferCompleteEpochMs) {
        if (uart == null
                || uart.packetsCompleteAtEpochMs <= 0
                || transferCompleteEpochMs <= 0
                || transferCompleteEpochMs < uart.packetsCompleteAtEpochMs) {
            return -1L;
        }
        return transferCompleteEpochMs - uart.packetsCompleteAtEpochMs;
    }

    private static void appendReductionInline(
            StringBuilder sb,
            long originalBytes,
            long payloadBytes,
            @Nullable PayloadReductionStats reduction) {
        if (originalBytes <= 0 || payloadBytes <= 0) {
            return;
        }
        long totalSaved = Math.max(0L, originalBytes - payloadBytes);
        sb.append(" | sensor_to_payload_saved=")
                .append(String.format(Locale.US, "%.1f", totalSaved / 1024.0))
                .append("KB");
        if (reduction == null || !reduction.cropApplied) {
            return;
        }
        long baselineBle = baselineFullFrameBlePayloadBytes(payloadBytes, reduction);
        long cropSavedVsBle = Math.max(0L, baselineBle - payloadBytes);
        sb.append(
                        reduction.measuredFullFrameBytes() > 0
                                ? " | crop_saved_vs_full_ble_measured="
                                : " | crop_saved_vs_full_ble_est=")
                .append(String.format(Locale.US, "%.1f", cropSavedVsBle / 1024.0))
                .append("KB");
        sb.append(" | crop=")
                .append(reduction.cropWidth)
                .append('x')
                .append(reduction.cropHeight)
                .append(" of ")
                .append(reduction.sourceWidth)
                .append('x')
                .append(reduction.sourceHeight);
    }

    private static double percentSaved(long baselineBytes, long savedBytes) {
        if (baselineBytes <= 0) {
            return 0.0;
        }
        return 100.0 * savedBytes / baselineBytes;
    }

    private static void appendMilestoneDurations(StringBuilder sb, Map<String, Long> phases) {
        long start = phaseMs(phases, "request_received");
        long captured = phaseMs(phases, "photo_captured");
        long compressDone = phaseMs(phases, "ble_compress_done");
        long transferStart = phaseMs(phases, "ble_file_transfer_start");
        long transferDone = phaseMs(phases, "ble_transfer_complete");
        boolean any = false;
        if (start > 0 && captured > start) {
            sb.append("camera=").append(captured - start).append("ms");
            any = true;
        }
        if (captured > 0 && compressDone > captured) {
            if (any) sb.append(", ");
            sb.append("compress=").append(compressDone - captured).append("ms");
            any = true;
        }
        if (transferStart > 0 && transferDone > transferStart) {
            if (any) sb.append(", ");
            sb.append("ble_transfer=").append(transferDone - transferStart).append("ms");
        }
    }

    private static long phaseMs(Map<String, Long> phases, String key) {
        if (phases == null) {
            return 0L;
        }
        Long value = phases.get(key);
        return value != null ? value : 0L;
    }

    /**
     * Formats the end-of-transfer phase table with right-aligned time columns so totals and
     * per-step deltas line up in logcat. Appends a PHASE SUMMARY with rolled-up durations.
     */
    static String formatPhaseBreakdown(
            String requestId,
            Map<String, Long> timings,
            long originalBytes,
            long compressedBytes,
            @Nullable UartTransferStats uart,
            @Nullable PayloadReductionStats reduction) {
        return formatPhaseBreakdown(
                requestId, timings, originalBytes, compressedBytes, uart, reduction, null);
    }

    static String formatPhaseBreakdown(
            String requestId,
            Map<String, Long> timings,
            long originalBytes,
            long compressedBytes,
            @Nullable UartTransferStats uart,
            @Nullable PayloadReductionStats reduction,
            @Nullable CaptureSessionStats captureSession) {
        StringBuilder sb = new StringBuilder();
        sb.append("⏱️ [BLE PHOTO] PHASE BREAKDOWN | requestId=").append(requestId).append('\n');
        sb.append(String.format(Locale.US, "  %8s  %8s  %s%n", "TOTAL", "ΔSTEP", "PHASE"));
        sb.append(String.format(Locale.US, "  %8s  %8s  %s%n", "--------", "--------", "-----"));

        long firstTime = 0;
        long prevTime = 0;
        long setupMs = 0;
        long captureMs = 0;
        long pipelineMs = 0;
        long cropMs = 0;
        long compressMs = 0;
        long transferMs = 0;
        long cleanupMs = 0;
        long otherMs = 0;

        for (Map.Entry<String, Long> entry : timings.entrySet()) {
            long time = entry.getValue();
            String step = entry.getKey();
            if (firstTime == 0) {
                firstTime = time;
                prevTime = time;
                sb.append(
                        String.format(
                                Locale.US,
                                "  %8s  %8s  %s%n",
                                formatMs(0),
                                formatMs(0),
                                label(step)));
                continue;
            }
            long total = time - firstTime;
            long delta = time - prevTime;
            sb.append(
                    String.format(
                            Locale.US,
                            "  %8s  %8s  %s%n",
                            formatMs(total),
                            formatMs(delta),
                            label(step)));
            switch (phaseBucket(step)) {
                case SETUP:
                    setupMs += delta;
                    break;
                case CAPTURE:
                    captureMs += delta;
                    break;
                case PIPELINE:
                    pipelineMs += delta;
                    break;
                case CROP:
                    cropMs += delta;
                    break;
                case COMPRESS:
                    compressMs += delta;
                    break;
                case TRANSFER:
                    transferMs += delta;
                    break;
                case CLEANUP:
                    cleanupMs += delta;
                    break;
                default:
                    otherMs += delta;
                    break;
            }
            prevTime = time;
        }

        long endToEndMs = prevTime - firstTime;
        sb.append(
                String.format(
                        Locale.US,
                        "  %8s  %8s  %s%n",
                        formatMs(endToEndMs),
                        "",
                        "END-TO-END"));
        sb.append('\n');
        sb.append("  PHASE SUMMARY (how long each major phase took)\n");
        sb.append(String.format(Locale.US, "  %8s  %s%n", "DURATION", "PHASE"));
        sb.append(String.format(Locale.US, "  %8s  %s%n", "--------", "-----"));
        appendSummaryLine(sb, setupMs, endToEndMs, "SETUP", "receive + guards + status + enqueue");
        appendSummaryLine(
                sb, captureMs, endToEndMs, "CAPTURE", "camera open → shutter → JPEG on disk");
        appendSummaryLine(
                sb, pipelineMs, endToEndMs, "PIPELINE", "hand off to BLE worker + resolve params");
        appendSummaryLine(
                sb,
                cropMs,
                endToEndMs,
                "CROP",
                "text-region detection + decode region + bitmap crop");
        appendSummaryLine(
                sb, compressMs, endToEndMs, "COMPRESS", "resize/sharpen/encode for BLE");
        appendSummaryLine(
                sb, transferMs, endToEndMs, "TRANSFER", "BLE packets + phone transfer_complete");
        appendSummaryLine(sb, cleanupMs, endToEndMs, "CLEANUP", "temp artifacts + job release");
        if (otherMs > 0) {
            appendSummaryLine(sb, otherMs, endToEndMs, "OTHER", "unclassified steps");
        }
        sb.append(
                String.format(
                        Locale.US,
                        "  %8s  %s%n",
                        formatMs(endToEndMs),
                        "END-TO-END"));
        appendCaptureSessionSection(sb, captureSession);

        sb.append('\n');
        sb.append("  PAYLOAD / TRANSFER\n");
        sb.append(String.format(Locale.US, "  %12s  %s%n", "VALUE", "METRIC"));
        sb.append(String.format(Locale.US, "  %12s  %s%n", "------------", "------"));
        if (originalBytes > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatKb(originalBytes),
                            "original captured JPEG"));
        }
        long payloadBytes =
                compressedBytes > 0
                        ? compressedBytes
                        : (uart != null ? uart.payloadBytes : 0L);
        appendPayloadReductionSection(sb, originalBytes, payloadBytes, reduction);
        if (payloadBytes > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatKb(payloadBytes),
                            "BLE payload (compressed)"));
        }
        if (originalBytes > 0 && payloadBytes > 0 && originalBytes >= payloadBytes) {
            double ratio = (double) originalBytes / (double) payloadBytes;
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            String.format(Locale.US, "%.1fx", ratio),
                            "compression ratio (original/payload)"));
        }
        if (uart != null && uart.durationMs > 0 && uart.payloadBytes > 0) {
            double uartSpeedKBs = uart.payloadBytes * 1000.0 / uart.durationMs / 1024.0;
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(uart.durationMs),
                            "UART/BLE packet TX (MCU ACKed)"));
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            String.format(Locale.US, "%.1fKB/s", uartSpeedKBs),
                            "UART/BLE packet TX speed"));
        }
        appendPacketClockSection(sb, uart != null ? uart.packetClocks : null);
        long transferStart = phaseMs(timings, "ble_file_transfer_start");
        long transferDone = phaseMs(timings, "ble_transfer_complete");
        if (payloadBytes > 0 && transferStart > 0 && transferDone > transferStart) {
            long phoneRoundTripMs = transferDone - transferStart;
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(phoneRoundTripMs),
                            "transfer start → phone transfer_complete"));
        }
        long phoneAckWaitMs = phoneAckWaitMs(uart, transferDone);
        if (phoneAckWaitMs >= 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(phoneAckWaitMs),
                            "last MCU-acked packet → phone transfer_complete"));
        }
        // Trim a trailing newline so logcat does not add an empty final line.
        if (sb.length() > 0 && sb.charAt(sb.length() - 1) == '\n') {
            sb.setLength(sb.length() - 1);
        }
        return sb.toString();
    }

    /**
     * Mentra vs K900Server packet clocks. Compare {@code ack→send p50} to K900Server's ~1ms
     * {@code <<<}→{@code sendFile} gap, and {@code packet RTT p50} to their ~11ms round trip.
     */
    private static void appendPacketClockSection(
            StringBuilder sb, @Nullable PacketClockStats clocks) {
        if (clocks == null) {
            return;
        }
        if (clocks.ackToSendP50Ms >= 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(clocks.ackToSendP50Ms),
                            "ack→send p50 (Mentra turnaround; K900Server ~1ms)"));
        }
        if (clocks.ackToSendP95Ms >= 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(clocks.ackToSendP95Ms),
                            "ack→send p95"));
        }
        if (clocks.packetRttP50Ms >= 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(clocks.packetRttP50Ms),
                            "packet RTT p50 (send→ACK; K900Server ~11ms)"));
        }
        if (clocks.packetRttP95Ms >= 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(clocks.packetRttP95Ms),
                            "packet RTT p95"));
        }
        if (clocks.packetsPerSec > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            String.format(Locale.US, "%.1f/s", clocks.packetsPerSec),
                            "packets/sec (K900Server ~90/s)"));
        }
        if (clocks.totalPackets > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            clocks.packetsAcked + "/" + clocks.totalPackets,
                            "packets ACKed / total"));
        }
    }

    private static void appendCaptureSessionSection(
            StringBuilder sb, @Nullable CaptureSessionStats captureSession) {
        if (captureSession == null) {
            return;
        }
        sb.append('\n');
        sb.append("  CAPTURE SESSION (warm-up ↔ take_photo)\n");
        sb.append(String.format(Locale.US, "  %22s  %s%n", "VALUE", "METRIC"));
        sb.append(String.format(Locale.US, "  %22s  %s%n", "----------------------", "------"));
        if (captureSession.reusedWarmSession) {
            sb.append(
                    String.format(
                            Locale.US, "  %22s  %s%n", "yes", "warm session reused"));
        } else {
            String reason =
                    captureSession.note != null && !captureSession.note.isEmpty()
                            ? captureSession.note
                            : "cold open";
            sb.append(
                    String.format(
                            Locale.US,
                            "  %22s  %s%n",
                            reason,
                            warmSessionReasonMetric(reason)));
        }
        if (captureSession.sizeTier != null && !captureSession.sizeTier.isEmpty()) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %22s  %s%n",
                            captureSession.sizeTier,
                            "capture size tier"));
        }
        if (captureSession.jpegWidth > 0 && captureSession.jpegHeight > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %22s  %s%n",
                            captureSession.jpegWidth + "x" + captureSession.jpegHeight,
                            captureSession.reusedWarmSession
                                    ? "sensor JPEG (same as warm-up)"
                                    : "sensor JPEG"));
        }
    }

    /** Human metric line for a {@link WarmSessionReason} VALUE. */
    private static String warmSessionReasonMetric(String reason) {
        if (reason == null) {
            return "warm session status";
        }
        if (WarmSessionReason.NO_WARMUP.equals(reason)) {
            return "warm session status — no warm-up held the camera";
        }
        if (WarmSessionReason.LEASE_EXPIRED.equals(reason)) {
            return "warm session status — warm lease ended before take_photo";
        }
        if (reason.startsWith("mismatch ")) {
            return "warm session status — warm and capture configs differed";
        }
        if (WarmSessionReason.MISMATCH.equals(reason)
                || WarmSessionReason.MISMATCH_SDK.equals(reason)
                || WarmSessionReason.MISMATCH_EXPOSURE.equals(reason)) {
            return "warm session status — warm and capture configs differed";
        }
        return "warm session status";
    }

    private static void appendPayloadReductionSection(
            StringBuilder sb,
            long originalBytes,
            long payloadBytes,
            @Nullable PayloadReductionStats reduction) {
        if (reduction == null) {
            return;
        }
        long sourcePixels = (long) reduction.sourceWidth * reduction.sourceHeight;
        long cropPixels = (long) reduction.cropWidth * reduction.cropHeight;
        if (reduction.sourceWidth > 0 && reduction.sourceHeight > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            reduction.sourceWidth + "x" + reduction.sourceHeight,
                            "source pixels"));
        }
        if (reduction.cropApplied
                && reduction.cropWidth > 0
                && reduction.cropHeight > 0
                && sourcePixels > 0) {
            double keptPct = 100.0 * cropPixels / sourcePixels;
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            reduction.cropWidth + "x" + reduction.cropHeight,
                            String.format(
                                    Locale.US,
                                    "crop ROI (kept %.1f%% of source pixels)",
                                    keptPct)));
        } else if (sourcePixels > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            reduction.sourceWidth + "x" + reduction.sourceHeight,
                            "crop ROI (full frame, no crop savings)"));
        }
        int[] fullEncode =
                fitInsideNoUpscale(
                        reduction.sourceWidth,
                        reduction.sourceHeight,
                        reduction.bleTargetWidth,
                        reduction.bleTargetHeight);
        if (fullEncode[0] > 0 && fullEncode[1] > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            fullEncode[0] + "x" + fullEncode[1],
                            "BLE encode input if no crop (downscaled full frame)"));
        }
        if (reduction.encodeWidth > 0 && reduction.encodeHeight > 0) {
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            reduction.encodeWidth + "x" + reduction.encodeHeight,
                            "BLE encode input (actual)"));
        }
        if (payloadBytes <= 0) {
            return;
        }
        long baselineBle = baselineFullFrameBlePayloadBytes(payloadBytes, reduction);
        boolean baselineMeasured = reduction.measuredFullFrameBytes() > 0;
        if (reduction.cropApplied && baselineBle > payloadBytes) {
            long cropSavedVsBle = baselineBle - payloadBytes;
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatKb(baselineBle),
                            baselineMeasured
                                    ? "BLE payload if no crop (measured re-encode)"
                                    : "BLE payload if no crop (est., area-scaled)"));
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatKb(cropSavedVsBle),
                            String.format(
                                    Locale.US,
                                    "saved by cropping vs full-frame BLE (%s, %.1f%%)",
                                    baselineMeasured ? "measured" : "est.",
                                    percentSaved(baselineBle, cropSavedVsBle))));
        }
        if (originalBytes > 0) {
            long sensorToPayload = Math.max(0L, originalBytes - payloadBytes);
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatKb(sensorToPayload),
                            String.format(
                                    Locale.US,
                                    "sensor JPEG → BLE payload reduction (%.1f%%)",
                                    percentSaved(originalBytes, sensorToPayload))));
        }
    }

    private static String formatKb(long bytes) {
        return String.format(Locale.US, "%.1fKB", bytes / 1024.0);
    }

    private enum PhaseBucket {
        SETUP,
        CAPTURE,
        PIPELINE,
        CROP,
        COMPRESS,
        TRANSFER,
        CLEANUP,
        OTHER
    }

    private static PhaseBucket phaseBucket(String step) {
        if (step == null) {
            return PhaseBucket.OTHER;
        }
        switch (step) {
            case "request_start":
            case "request_received":
            case "ble_capture_accepted":
            case "streaming_check":
            case "camera_restart_check":
            case "battery_check":
            case "storage_check":
            case "photo_job_acquired":
            case "photo_status_accepted":
            case "photo_status_queued":
            case "enqueue_camera":
                return PhaseBucket.SETUP;
            case "capture_configured":
            case "capture_started":
            case "still_shutter_submitted":
            case "still_frame_available":
            case "still_buffer_extracted":
            case "still_jpeg_write_done":
            case "still_capture_id_exif_done":
            case "still_imu_metadata_done":
            case "still_image_save_done":
            case "photo_captured":
                return PhaseBucket.CAPTURE;
            case "text_region_detection_start":
            case "text_region_detection_done":
            case "crop_decode_start":
            case "crop_decode_done":
            case "crop_start":
            case "crop_done":
            case "crop_phase_done":
                return PhaseBucket.CROP;
            case "start_compress_for_ble":
            case "ble_compress_thread_start":
            case "compress_resolve_params":
            case "text_mode_prepare":
            case "ble_compress_start":
                // Worker handoff / param resolve happen before crop but are not the compress
                // stage; keep them out of COMPRESS so the timeline reads crop → compress.
                return PhaseBucket.PIPELINE;
            case "image_process_start":
            case "input_decode_start":
            case "input_decode_done":
            case "grayscale_process_start":
            case "grayscale_process_done":
            case "resize_start":
            case "resize_done":
            case "sharpen_start":
            case "sharpen_done":
            case "image_process_done":
            case "jpeg_encode_start":
            case "jpeg_encode_done":
            case "encode_start":
            case "encode_done":
            case "avif_encode_start":
            case "avif_encode_done":
            case "ble_compress_done":
            case "ble_payload_ready":
            case "write_compressed_file_start":
            case "write_compressed_file_done":
                return PhaseBucket.COMPRESS;
            case "ble_availability_check":
            case "ble_send_start":
            case "ble_ready_msg":
            case "ble_ready_delay_start":
            case "ble_ready_delay_done":
            case "ble_file_transfer_start":
            case "ble_transfer_started":
            case "ble_transfer_complete":
            case "ble_transfer_failed":
                return PhaseBucket.TRANSFER;
            case "cleanup_start":
            case "cleanup_done":
                return PhaseBucket.CLEANUP;
            default:
                return PhaseBucket.OTHER;
        }
    }

    private static void appendSummaryLine(
            StringBuilder sb, long durationMs, long endToEndMs, String name, String detail) {
        if (durationMs <= 0) {
            return;
        }
        double pct = endToEndMs > 0 ? (100.0 * durationMs) / endToEndMs : 0.0;
        sb.append(
                String.format(
                        Locale.US,
                        "  %8s  %s — %s (%.0f%%)%n",
                        formatMs(durationMs),
                        name,
                        detail,
                        pct));
    }

    private static String formatMs(long ms) {
        return ms < 0 ? (ms + "ms") : ("+" + ms + "ms");
    }

    static String label(String step) {
        if (step == null) {
            return "UNKNOWN STEP";
        }
        switch (step) {
            case "request_start":
                return "RECEIVE: started end-to-end BLE photo timing";
            case "request_received":
                return "RECEIVE: take_photo command arrived from phone";
            case "ble_capture_accepted":
                return "RECEIVE: request accepted, photo job started";
            case "streaming_check":
                return "GUARD: checked that video streaming is not using the camera";
            case "camera_restart_check":
                return "GUARD: checked that the camera HAL is ready";
            case "battery_check":
                return "GUARD: checked battery level before capture";
            case "storage_check":
                return "GUARD: checked available storage before capture";
            case "photo_job_acquired":
                return "GUARD: acquired the single-flight photo job lock";
            case "photo_status_accepted":
                return "STATUS: reported that the photo request was accepted";
            case "photo_status_queued":
                return "STATUS: reported that the camera request is queued";
            case "enqueue_camera":
                return "CAPTURE: opening camera and queueing shutter request";
            case "capture_configured":
                return "CAPTURE: camera configuration was resolved";
            case "capture_started":
                return "CAPTURE: sensor exposure and image capture started";
            case "still_shutter_submitted":
                return "CAPTURE: still capture request submitted to camera HAL";
            case "still_frame_available":
                return "CAPTURE: ImageReader delivered still JPEG frame";
            case "still_buffer_extracted":
                return "CAPTURE: JPEG bytes copied out of ImageReader buffer";
            case "still_jpeg_write_done":
                return "CAPTURE: JPEG file write/close finished";
            case "still_capture_id_exif_done":
                return "CAPTURE: capture-id EXIF write finished";
            case "still_imu_metadata_done":
                return "CAPTURE: IMU metadata finalization finished";
            case "still_image_save_done":
                return "CAPTURE: image save pipeline finished (ready to notify)";
            case "photo_captured":
                return "CAPTURE: sensor JPEG available to photo pipeline";
            case "start_compress_for_ble":
                return "PIPELINE: handing captured JPEG to post-capture worker";
            case "ble_compress_thread_start":
                return "PIPELINE: post-capture worker thread started";
            case "ble_compress_start":
                return "PIPELINE: post-capture worker accepted the JPEG";
            case "compress_resolve_params":
                return "PIPELINE: resolved BLE downscale target and encode quality";
            case "text_mode_prepare":
                return "PIPELINE: resolved text-mode crop preparation state";
            case "text_region_detection_start":
                return "CROP: running text-region detection (ML Kit)";
            case "text_region_detection_done":
                return "CROP: text-region detection finished";
            case "crop_decode_start":
                return "CROP: decoding JPEG for crop (region or full frame)";
            case "crop_decode_done":
                return "CROP: JPEG decode finished";
            case "crop_start":
                return "CROP: cropping bitmap to the selected text region";
            case "crop_done":
                return "CROP: bitmap crop finished";
            case "crop_phase_done":
                return "CROP: crop phase complete — starting compress";
            case "image_process_start":
                return "COMPRESS: resizing and sharpening for BLE encode";
            case "input_decode_start":
                return "COMPRESS: decoding the captured JPEG into a working bitmap";
            case "input_decode_done":
                return "COMPRESS: captured JPEG decode finished";
            case "grayscale_process_start":
                return "COMPRESS: grayscale resize and sharpen";
            case "grayscale_process_done":
                return "COMPRESS: grayscale resize and sharpen finished";
            case "resize_start":
                return "COMPRESS: resizing the cropped bitmap to the BLE target dimensions";
            case "resize_done":
                return "COMPRESS: bitmap resize finished";
            case "sharpen_start":
                return "COMPRESS: applying image sharpening before encode";
            case "sharpen_done":
                return "COMPRESS: image sharpening finished";
            case "image_process_done":
                return "COMPRESS: bitmap ready for BLE encoder";
            case "jpeg_encode_start":
                return "COMPRESS: encoding the JPEG payload at the configured quality";
            case "jpeg_encode_done":
                return "COMPRESS: JPEG encode finished";
            case "encode_start":
                return "COMPRESS: encoding the selected BLE payload codec";
            case "encode_done":
                return "COMPRESS: selected BLE codec encode finished";
            case "ble_compress_done":
                return "COMPRESS: compression phase complete";
            case "ble_payload_ready":
                return "COMPRESS: BLE payload ready in memory";
            case "write_compressed_file_start":
                return "COMPRESS: writing compressed artifact to disk for BLE TX";
            case "write_compressed_file_done":
                return "COMPRESS: compressed file saved (awaiting BLE send)";
            case "ble_availability_check":
                return "TRANSFER: checked that BLE is available for a new file transfer";
            case "ble_send_start":
                return "TRANSFER: starting BLE delivery to phone";
            case "ble_ready_msg":
                return "TRANSFER: sent ble_photo_ready JSON to phone";
            case "ble_ready_delay_start":
                return "TRANSFER: waiting briefly for the ready message to drain before packets";
            case "ble_ready_delay_done":
                return "TRANSFER: ready-message drain delay finished";
            case "ble_file_transfer_start":
                return "TRANSFER: starting UART/BLE file packet stream";
            case "ble_transfer_started":
                return "TRANSFER: Bluetooth stack accepted outbound file transfer";
            case "ble_transfer_complete":
                return "TRANSFER: phone confirmed transfer_complete (success)";
            case "ble_transfer_failed":
                return "TRANSFER: phone reported transfer_complete failure";
            case "cleanup_start":
                return "CLEANUP: removing temporary photo artifacts and request state";
            case "cleanup_done":
                return "CLEANUP: temporary artifacts removed and photo job released";
            default:
                return step.toUpperCase(Locale.US).replace('_', ' ');
        }
    }
}
