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
        if (!enabled() || bleImgId == null || bleImgId.isEmpty()) {
            return;
        }
        UART_TRANSFER_STATS.put(bleImgId, new UartTransferStats(payloadBytes, durationMs));
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
            @Nullable UartTransferStats uart) {
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
        appendSizeAndSpeed(sb, originalBytes, compressedBytes, uart, phases);
        if (phases != null && !phases.isEmpty()) {
            sb.append(" | ");
            appendMilestoneDurations(sb, phases);
        }
        Log.i(TAG, sb.toString());
    }

    public static final class UartTransferStats {
        public final long payloadBytes;
        public final long durationMs;

        UartTransferStats(long payloadBytes, long durationMs) {
            this.payloadBytes = payloadBytes;
            this.durationMs = durationMs;
        }
    }

    private static void appendSizeAndSpeed(
            StringBuilder sb,
            long originalBytes,
            long compressedBytes,
            @Nullable UartTransferStats uart,
            @Nullable Map<String, Long> phases) {
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
        long uartMs = uart != null ? uart.durationMs : 0L;
        if (uart != null && uartMs > 0) {
            double uartSpeedKBs = uart.payloadBytes * 1000.0 / uartMs / 1024.0;
            sb.append(" | uart_tx=").append(uartMs).append("ms");
            sb.append(" | uart_speed=")
                    .append(String.format(Locale.US, "%.1f", uartSpeedKBs))
                    .append("KB/s");
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
            @Nullable UartTransferStats uart) {
        StringBuilder sb = new StringBuilder();
        sb.append("⏱️ [BLE PHOTO] PHASE BREAKDOWN | requestId=").append(requestId).append('\n');
        sb.append(String.format(Locale.US, "  %8s  %8s  %s%n", "TOTAL", "ΔSTEP", "PHASE"));
        sb.append(String.format(Locale.US, "  %8s  %8s  %s%n", "--------", "--------", "-----"));

        long firstTime = 0;
        long prevTime = 0;
        long setupMs = 0;
        long captureMs = 0;
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
                sb, compressMs, endToEndMs, "COMPRESS", "decode/crop/resize/sharpen/encode/write");
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
        long transferStart = phaseMs(timings, "ble_file_transfer_start");
        long transferDone = phaseMs(timings, "ble_transfer_complete");
        if (payloadBytes > 0 && transferStart > 0 && transferDone > transferStart) {
            long phoneRoundTripMs = transferDone - transferStart;
            double e2eSpeedKBs = payloadBytes * 1000.0 / phoneRoundTripMs / 1024.0;
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s%n",
                            formatMs(phoneRoundTripMs),
                            "transfer start → phone transfer_complete"));
            sb.append(
                    String.format(
                            Locale.US,
                            "  %12s  %s",
                            String.format(Locale.US, "%.1fKB/s", e2eSpeedKBs),
                            "effective transfer speed (incl. phone ack wait)"));
        }
        return sb.toString();
    }

    private static String formatKb(long bytes) {
        return String.format(Locale.US, "%.1fKB", bytes / 1024.0);
    }

    private enum PhaseBucket {
        SETUP,
        CAPTURE,
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
            case "start_compress_for_ble":
            case "ble_compress_thread_start":
            case "compress_resolve_params":
            case "text_mode_prepare":
            case "text_region_detection_start":
            case "text_region_detection_done":
            case "image_process_start":
            case "input_decode_start":
            case "input_decode_done":
            case "grayscale_process_start":
            case "grayscale_process_done":
            case "crop_start":
            case "crop_done":
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
        return "+" + ms + "ms";
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
                return "COMPRESS: handing captured JPEG to BLE compression worker";
            case "ble_compress_thread_start":
                return "COMPRESS: background compression thread started";
            case "compress_resolve_params":
                return "COMPRESS: resolved BLE downscale size and AVIF quality";
            case "text_mode_prepare":
                return "COMPRESS: resolved text-mode crop preparation state";
            case "text_region_detection_start":
                return "COMPRESS: running text-region detection for crop";
            case "text_region_detection_done":
                return "COMPRESS: text-region detection finished";
            case "image_process_start":
                return "COMPRESS: decoding, cropping, resizing, and sharpening bitmap";
            case "input_decode_start":
                return "COMPRESS: decoding the captured JPEG into a working bitmap";
            case "input_decode_done":
                return "COMPRESS: captured JPEG decode finished";
            case "grayscale_process_start":
                return "COMPRESS: processing grayscale pixels for OCR";
            case "grayscale_process_done":
                return "COMPRESS: grayscale crop, resize, and sharpen finished";
            case "crop_start":
                return "COMPRESS: cropping the bitmap to the selected text/photo region";
            case "crop_done":
                return "COMPRESS: bitmap crop finished";
            case "resize_start":
                return "COMPRESS: resizing the cropped bitmap to the BLE target dimensions";
            case "resize_done":
                return "COMPRESS: bitmap resize finished";
            case "sharpen_start":
                return "COMPRESS: applying image sharpening before AVIF encoding";
            case "sharpen_done":
                return "COMPRESS: image sharpening finished";
            case "image_process_done":
                return "COMPRESS: bitmap ready for AVIF encoder";
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
