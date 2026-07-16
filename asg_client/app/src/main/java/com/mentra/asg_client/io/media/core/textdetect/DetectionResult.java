package com.mentra.asg_client.io.media.core.textdetect;

import androidx.annotation.Nullable;
import org.opencv.core.Mat;

/** Result of text-region detection mapped to full-resolution source coordinates. */
public final class DetectionResult {
    public enum Confidence {
        HIGH,
        MEDIUM,
        LOW,
        NONE
    }

    public final CropRect roi;
    public final Confidence confidence;
    public final String selectedPolarity;
    public final int acceptedComponentCount;
    public final int lineCount;
    public final long detectionTimeMs;
    public final String fallbackReason;

    @Nullable public final DebugArtifacts debug;

    public DetectionResult(
            CropRect roi,
            Confidence confidence,
            String selectedPolarity,
            int acceptedComponentCount,
            int lineCount,
            long detectionTimeMs,
            String fallbackReason,
            @Nullable DebugArtifacts debug) {
        this.roi = roi;
        this.confidence = confidence;
        this.selectedPolarity = selectedPolarity;
        this.acceptedComponentCount = acceptedComponentCount;
        this.lineCount = lineCount;
        this.detectionTimeMs = detectionTimeMs;
        this.fallbackReason = fallbackReason;
        this.debug = debug;
    }

    public static final class DebugArtifacts {
        @Nullable public final Mat analysisGray;
        @Nullable public final Mat thresholdDark;
        @Nullable public final Mat thresholdLight;
        @Nullable public final Mat componentsOverlay;
        @Nullable public final Mat linesOverlay;
        @Nullable public final Mat cropOverlay;

        DebugArtifacts(
                @Nullable Mat analysisGray,
                @Nullable Mat thresholdDark,
                @Nullable Mat thresholdLight,
                @Nullable Mat componentsOverlay,
                @Nullable Mat linesOverlay,
                @Nullable Mat cropOverlay) {
            this.analysisGray = analysisGray;
            this.thresholdDark = thresholdDark;
            this.thresholdLight = thresholdLight;
            this.componentsOverlay = componentsOverlay;
            this.linesOverlay = linesOverlay;
            this.cropOverlay = cropOverlay;
        }

        public void release() {
            releaseMat(analysisGray);
            releaseMat(thresholdDark);
            releaseMat(thresholdLight);
            releaseMat(componentsOverlay);
            releaseMat(linesOverlay);
            releaseMat(cropOverlay);
        }

        private static void releaseMat(@Nullable Mat mat) {
            if (mat != null) {
                mat.release();
            }
        }
    }
}
