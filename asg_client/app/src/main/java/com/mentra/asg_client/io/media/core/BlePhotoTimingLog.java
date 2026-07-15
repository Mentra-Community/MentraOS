package com.mentra.asg_client.io.media.core;

import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import java.util.Locale;
import java.util.Map;

/** Human-readable {@code ⏱️ [BLE PHOTO]} timing lines for the take_photo → JPEG → BLE pipeline. */
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
            case "photo_captured":
                return "CAPTURE: sensor JPEG written to storage";
            case "start_compress_for_ble":
                return "COMPRESS: handing captured JPEG to BLE compression worker";
            case "ble_compress_thread_start":
                return "COMPRESS: background compression thread started";
            case "compress_resolve_params":
                return "COMPRESS: resolved BLE downscale size and JPEG quality";
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
                return "COMPRESS: applying image sharpening before JPEG encoding";
            case "sharpen_done":
                return "COMPRESS: image sharpening finished";
            case "image_process_done":
                return "COMPRESS: bitmap ready for JPEG encoder";
            case "jpeg_encode_start":
                return "COMPRESS: encoding the JPEG payload at the configured quality";
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
