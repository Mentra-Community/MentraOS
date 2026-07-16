package com.mentra.asg_client.io.media.core.textdetect;

import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.opencv.core.Mat;
import org.opencv.imgcodecs.Imgcodecs;

/**
 * Writes {@link DetectionResult.DebugArtifacts} (analysis frame, dual-polarity threshold masks,
 * component/line "zone" overlays, crop overlay) plus a {@code result.json} summary to disk on the
 * glasses, so intermediate detection state can be pulled off-device via {@code adb pull} for
 * offline review - mirrors the artifact set produced by the desktop {@code
 * TextRegionDetectorHarnessTest}.
 *
 * <p>Debug-only: callers must opt in by building a {@link TextDetectConfig} with {@code
 * debugCaptureIntermediates(true)} before calling {@link TextRegionDetector#detect}; this class
 * does not gate anything itself and is a no-op if {@code result.debug} is {@code null}.
 */
public final class TextDetectDebugWriter {
    private static final String TAG = "TextDetectDebugWriter";

    private TextDetectDebugWriter() {}

    /**
     * Writes all non-null debug Mats plus {@code result.json} into {@code outputDir} (created if
     * needed), then releases the Mats. No-op if {@code result.debug == null}. Never throws - logs
     * a warning and returns on failure so a debug-artifact write can never break photo capture.
     */
    public static void save(File outputDir, DetectionResult result, String outcome) {
        if (result.debug == null) {
            return;
        }
        try {
            if (!outputDir.exists() && !outputDir.mkdirs()) {
                Log.w(TAG, "Failed to create debug output dir: " + outputDir);
                return;
            }
            writeMat(result.debug.analysisGray, new File(outputDir, "01_analysis_gray.png"));
            writeMat(result.debug.thresholdDark, new File(outputDir, "02_threshold_dark.png"));
            writeMat(result.debug.thresholdLight, new File(outputDir, "03_threshold_light.png"));
            writeMat(result.debug.componentsOverlay, new File(outputDir, "04_components.png"));
            writeMat(result.debug.linesOverlay, new File(outputDir, "05_lines.png"));
            writeMat(result.debug.cropOverlay, new File(outputDir, "06_crop_overlay.jpg"));
            writeResultJson(outputDir, result, outcome);
            Log.i(TAG, "✂️ Saved text-detect debug artifacts to " + outputDir.getAbsolutePath());
        } catch (Exception e) {
            Log.w(TAG, "Failed to save text-detect debug artifacts", e);
        } finally {
            result.debug.release();
        }
    }

    private static void writeMat(Mat mat, File outFile) {
        if (mat == null || mat.empty()) {
            return;
        }
        Imgcodecs.imwrite(outFile.getAbsolutePath(), mat);
    }

    private static void writeResultJson(File outputDir, DetectionResult result, String outcome)
            throws Exception {
        JSONObject json = new JSONObject();
        json.put("confidence", result.confidence.name());
        json.put("selected_polarity", result.selectedPolarity);
        json.put("fallback_reason", result.fallbackReason);
        json.put("outcome", outcome);
        json.put("detection_time_ms", result.detectionTimeMs);
        json.put("accepted_component_count", result.acceptedComponentCount);
        json.put("line_count", result.lineCount);
        if (result.roi != null) {
            JSONArray crop = new JSONArray();
            for (int v : result.roi.toArray()) {
                crop.put(v);
            }
            json.put("crop", crop);
        }
        try (FileOutputStream fos = new FileOutputStream(new File(outputDir, "result.json"))) {
            fos.write(json.toString(2).getBytes(StandardCharsets.UTF_8));
        }
    }
}
