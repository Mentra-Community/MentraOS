package com.mentra.asg_client.io.media.core;

import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import java.util.Locale;
import java.util.Map;

/** Human-readable {@code ⏱️ [BLE PHOTO]} timing lines for the take_photo → AVIF → BLE pipeline. */
public final class BlePhotoTimingLog {
    public static final String TAG = "BlePhotoTiming";

    private BlePhotoTimingLog() {}

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
            String requestId, String bleImgId, boolean success, long totalMs, Map<String, Long> phases) {
        if (!enabled()) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("⏱️ [BLE PHOTO] PIPELINE FINISHED");
        sb.append(" | requestId=").append(requestId);
        sb.append(" | bleImgId=").append(bleImgId);
        sb.append(" | success=").append(success);
        sb.append(" | total=").append(totalMs).append("ms");
        if (phases != null && !phases.isEmpty()) {
            sb.append(" | ");
            appendMilestoneDurations(sb, phases);
        }
        Log.i(TAG, sb.toString());
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
        Long value = phases.get(key);
        return value != null ? value : 0L;
    }

    static String label(String step) {
        if (step == null) {
            return "UNKNOWN STEP";
        }
        switch (step) {
            case "request_received":
                return "RECEIVE: take_photo command arrived from phone";
            case "ble_capture_accepted":
                return "RECEIVE: request accepted, photo job started";
            case "enqueue_camera":
                return "CAPTURE: opening camera and queueing shutter request";
            case "photo_captured":
                return "CAPTURE: sensor JPEG written to storage";
            case "start_compress_for_ble":
                return "COMPRESS: handing captured JPEG to BLE compression worker";
            case "ble_compress_thread_start":
                return "COMPRESS: background compression thread started";
            case "compress_resolve_params":
                return "COMPRESS: resolved BLE downscale size and JPEG quality";
            case "text_region_detection_start":
                return "COMPRESS: running text-region detection for crop";
            case "text_region_detection_done":
                return "COMPRESS: text-region detection finished";
            case "image_process_start":
                return "COMPRESS: decoding, cropping, resizing, and sharpening bitmap";
            case "image_process_done":
                return "COMPRESS: bitmap ready for JPEG encoder";
            case "jpeg_encode_start":
                return "COMPRESS: encoding small JPEG payload (text-mode fast path)";
            case "jpeg_encode_done":
                return "COMPRESS: JPEG encode finished";
            case "avif_encode_start":
                return "COMPRESS: encoding AVIF for BLE transfer";
            case "avif_encode_done":
                return "COMPRESS: AVIF encode finished";
            case "ble_compress_done":
                return "COMPRESS: compression phase complete";
            case "write_compressed_file_start":
                return "COMPRESS: writing compressed artifact to disk for BLE TX";
            case "write_compressed_file_done":
                return "COMPRESS: compressed file saved (awaiting BLE send)";
            case "ble_send_start":
                return "TRANSFER: starting BLE delivery to phone";
            case "ble_ready_msg":
                return "TRANSFER: sent ble_photo_ready JSON to phone";
            case "ble_file_transfer_start":
                return "TRANSFER: starting UART/BLE file packet stream";
            case "ble_transfer_started":
                return "TRANSFER: Bluetooth stack accepted outbound file transfer";
            case "ble_transfer_complete":
                return "TRANSFER: phone confirmed transfer_complete (success)";
            case "ble_transfer_failed":
                return "TRANSFER: phone reported transfer_complete failure";
            default:
                return step.toUpperCase(Locale.US).replace('_', ' ');
        }
    }
}
