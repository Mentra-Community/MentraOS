package com.mentra.asg_client.io.media.core.textdetect;

import java.util.ArrayList;
import java.util.List;
import org.opencv.core.Mat;

/**
 * Classical text-region detector for BLE photo crops. Detects likely text regions via dual-polarity
 * adaptive thresholding, connected components, and line clustering; returns a padded ROI in
 * full-resolution coordinates. Does not perform OCR.
 */
public final class TextRegionDetector {
    private TextRegionDetector() {}

    public static DetectionResult detect(byte[] luma, int width, int height, TextDetectConfig config) {
        CvInit.ensureLoaded();
        long start = System.currentTimeMillis();

        CvPrimitives.AnalysisFrame analysis = CvPrimitives.prepareAnalysisFrame(luma, width, height, config);
        try {
            CvPrimitives.PolarityPipelineResult dark =
                    CvPrimitives.runPolarityPipeline(
                            analysis.gray, config, CvPrimitives.POLARITY_DARK_ON_LIGHT);
            CvPrimitives.PolarityPipelineResult light =
                    CvPrimitives.runPolarityPipeline(
                            analysis.gray, config, CvPrimitives.POLARITY_LIGHT_ON_DARK);

            List<ComponentStats> darkComponents = new ArrayList<>(dark.components);
            List<ComponentStats> lightComponents = new ArrayList<>(light.components);
            if (config.enableMser) {
                // Tier 3: MSER has no polarity concept of its own, so its candidate blobs are
                // merged into both polarity pipelines as additional evidence.
                List<ComponentStats> mserComponents = CvPrimitives.detectMserComponents(analysis.gray);
                darkComponents.addAll(mserComponents);
                lightComponents.addAll(mserComponents);
            }

            TextLineClusterer.ClusterResult darkCluster =
                    TextLineClusterer.cluster(darkComponents, analysis.width, analysis.height, config);
            TextLineClusterer.ClusterResult lightCluster =
                    TextLineClusterer.cluster(lightComponents, analysis.width, analysis.height, config);

            PolaritySelection selection =
                    selectPolarity(darkCluster, lightCluster, analysis.width, analysis.height, config);
            CropRect analysisCrop = selection.analysisCrop;
            DetectionResult.Confidence confidence = selection.confidence;
            String fallbackReason = selection.fallbackReason;

            if (analysisCrop == null || !isTrustworthyCrop(analysisCrop, selection, analysis, config)) {
                analysisCrop = generousCenterCrop(analysis.width, analysis.height);
                confidence = DetectionResult.Confidence.LOW;
                fallbackReason = appendReason(fallbackReason, "untrustworthy_detection_center_fallback");
            }

            CropRect fullResCrop = mapToFullResolution(analysisCrop, analysis, width, height);
            long elapsed = System.currentTimeMillis() - start;

            DetectionResult.DebugArtifacts debug = null;
            if (config.debugCaptureIntermediates) {
                debug =
                        new DetectionResult.DebugArtifacts(
                                analysis.gray.clone(),
                                dark.thresholdMask.clone(),
                                light.thresholdMask.clone(),
                                CvPrimitives.renderComponentsOverlay(
                                        analysis.gray, selection.acceptedComponents),
                                CvPrimitives.renderLinesOverlay(analysis.gray, selection.acceptedLines),
                                CvPrimitives.renderCropOverlay(analysis.gray, analysisCrop));
            }

            dark.releaseMask();
            light.releaseMask();

            return new DetectionResult(
                    fullResCrop,
                    confidence,
                    selection.polarity,
                    selection.acceptedComponentCount,
                    selection.lineCount,
                    elapsed,
                    fallbackReason,
                    debug);
        } finally {
            analysis.release();
        }
    }

    private static PolaritySelection selectPolarity(
            TextLineClusterer.ClusterResult dark,
            TextLineClusterer.ClusterResult light,
            int analysisWidth,
            int analysisHeight,
            TextDetectConfig config) {
        boolean darkValid = dark.hasCrop();
        boolean lightValid = light.hasCrop();

        if (!darkValid && !lightValid) {
            return PolaritySelection.fallback(CvPrimitives.POLARITY_DARK_ON_LIGHT, "no_valid_polarity");
        }

        TextLineClusterer.ClusterResult winner;
        String polarity;
        if (!darkValid) {
            winner = light;
            polarity = CvPrimitives.POLARITY_LIGHT_ON_DARK;
        } else if (!lightValid) {
            winner = dark;
            polarity = CvPrimitives.POLARITY_DARK_ON_LIGHT;
        } else {
            float darkScore = dark.score;
            float lightScore = light.score;
            float disagreement = Math.abs(darkScore - lightScore) / Math.max(1f, Math.max(darkScore, lightScore));
            if (disagreement > 0.6f) {
                winner = darkScore >= lightScore ? dark : light;
                polarity =
                        darkScore >= lightScore
                                ? CvPrimitives.POLARITY_DARK_ON_LIGHT
                                : CvPrimitives.POLARITY_LIGHT_ON_DARK;
                // improvedCropAccuracy: pad from the raw (unpadded) bounds — winner.crop is
                // already padded once, and padding it again compounds the inflation.
                CropRect expanded =
                        TextLineClusterer.applyPadding(
                                config.improvedCropAccuracy ? winner.rawBounds : winner.crop,
                                analysisWidth,
                                analysisHeight,
                                medianHeight(winner.lines),
                                config,
                                1.5f);
                TextLineClusterer.ClusterResult expandedResult =
                        new TextLineClusterer.ClusterResult(
                                winner.lines,
                                expanded,
                                winner.rawBounds,
                                winner.score,
                                winner.acceptedComponentCount,
                                winner.lineCount);
                return PolaritySelection.from(
                        expandedResult,
                        polarity,
                        DetectionResult.Confidence.LOW,
                        "polarity_disagreement_larger_crop");
            }
            if (darkScore >= lightScore) {
                winner = dark;
                polarity = CvPrimitives.POLARITY_DARK_ON_LIGHT;
            } else {
                winner = light;
                polarity = CvPrimitives.POLARITY_LIGHT_ON_DARK;
            }
        }

        DetectionResult.Confidence confidence;
        String reason = null;
        if (winner.score >= config.highConfidenceScore && winner.acceptedComponentCount >= 3) {
            confidence = DetectionResult.Confidence.HIGH;
        } else if (winner.score >= config.mediumConfidenceScore) {
            confidence = DetectionResult.Confidence.MEDIUM;
            reason = "medium_confidence_extra_padding";
            // improvedCropAccuracy: pad from the raw (unpadded) bounds — winner.crop is
            // already padded once.
            winner =
                    new TextLineClusterer.ClusterResult(
                            winner.lines,
                            TextLineClusterer.applyPadding(
                                    config.improvedCropAccuracy ? winner.rawBounds : winner.crop,
                                    analysisWidth,
                                    analysisHeight,
                                    medianHeight(winner.lines),
                                    config,
                                    1.35f),
                            winner.rawBounds,
                            winner.score,
                            winner.acceptedComponentCount,
                            winner.lineCount);
        } else {
            confidence = DetectionResult.Confidence.LOW;
            reason = "low_score";
        }

        return PolaritySelection.from(winner, polarity, confidence, reason);
    }

    private static boolean isTrustworthyCrop(
            CropRect crop,
            PolaritySelection selection,
            CvPrimitives.AnalysisFrame analysis,
            TextDetectConfig config) {
        if (selection.acceptedComponentCount <= 2) {
            return false;
        }
        // improvedCropAccuracy: both checks run against the raw (pre-padding) detected bounds.
        // The padded crop routinely gets clamped to the frame edge by design — padding reaching
        // the boundary says nothing about whether the detected text itself was clipped, and
        // padding can likewise inflate a degenerate detection past the min-area bar. With the
        // flag off, the original behavior (checks on the padded crop) is preserved.
        CropRect checkedBounds =
                config.improvedCropAccuracy && selection.rawBounds != null
                        ? selection.rawBounds
                        : crop;
        float areaFraction =
                checkedBounds.pixelCount() / (float) (analysis.width * analysis.height);
        if (areaFraction < config.minCropAreaFraction) {
            return false;
        }
        if (touchesBoundary(checkedBounds, analysis.width, analysis.height)) {
            return false;
        }
        return true;
    }

    private static boolean touchesBoundary(CropRect crop, int width, int height) {
        int margin = 2;
        return crop.left <= margin
                || crop.top <= margin
                || crop.right >= width - margin
                || crop.bottom >= height - margin;
    }

    private static CropRect generousCenterCrop(int width, int height) {
        int cropWidth = Math.round(width * 0.75f);
        int cropHeight = Math.round(height * 0.75f);
        int left = (width - cropWidth) / 2;
        int top = (height - cropHeight) / 2;
        return new CropRect(left, top, left + cropWidth, top + cropHeight);
    }

    private static CropRect mapToFullResolution(
            CropRect analysisCrop,
            CvPrimitives.AnalysisFrame analysis,
            int fullWidth,
            int fullHeight) {
        int left = Math.round(analysisCrop.left * analysis.scaleX);
        int top = Math.round(analysisCrop.top * analysis.scaleY);
        int right = Math.round(analysisCrop.right * analysis.scaleX);
        int bottom = Math.round(analysisCrop.bottom * analysis.scaleY);
        return CropRect.clamp(new CropRect(left, top, right, bottom), fullWidth, fullHeight);
    }

    private static float medianHeight(List<TextLineClusterer.TextLine> lines) {
        if (lines.isEmpty()) {
            return 8f;
        }
        int total = 0;
        int count = 0;
        for (TextLineClusterer.TextLine line : lines) {
            for (ComponentStats c : line.components) {
                total += c.height;
                count++;
            }
        }
        return count == 0 ? 8f : total / (float) count;
    }

    private static String appendReason(String existing, String extra) {
        if (existing == null || existing.isEmpty()) {
            return extra;
        }
        return existing + ";" + extra;
    }

    private static final class PolaritySelection {
        final CropRect analysisCrop;
        /** Detected bounds before padding; trust checks run against these, not the padded crop. */
        final CropRect rawBounds;
        final String polarity;
        final DetectionResult.Confidence confidence;
        final int acceptedComponentCount;
        final int lineCount;
        final List<ComponentStats> acceptedComponents;
        final List<TextLineClusterer.TextLine> acceptedLines;
        final String fallbackReason;

        private PolaritySelection(
                CropRect analysisCrop,
                CropRect rawBounds,
                String polarity,
                DetectionResult.Confidence confidence,
                int acceptedComponentCount,
                int lineCount,
                List<ComponentStats> acceptedComponents,
                List<TextLineClusterer.TextLine> acceptedLines,
                String fallbackReason) {
            this.analysisCrop = analysisCrop;
            this.rawBounds = rawBounds;
            this.polarity = polarity;
            this.confidence = confidence;
            this.acceptedComponentCount = acceptedComponentCount;
            this.lineCount = lineCount;
            this.acceptedComponents = acceptedComponents;
            this.acceptedLines = acceptedLines;
            this.fallbackReason = fallbackReason;
        }

        static PolaritySelection from(
                TextLineClusterer.ClusterResult result,
                String polarity,
                DetectionResult.Confidence confidence,
                String fallbackReason) {
            List<ComponentStats> components = flattenComponents(result.lines);
            return new PolaritySelection(
                    result.crop,
                    result.rawBounds,
                    polarity,
                    confidence,
                    result.acceptedComponentCount,
                    result.lineCount,
                    components,
                    result.lines,
                    fallbackReason);
        }

        static PolaritySelection fallback(String polarity, String reason) {
            return new PolaritySelection(
                    null,
                    null,
                    polarity,
                    DetectionResult.Confidence.NONE,
                    0,
                    0,
                    List.of(),
                    List.of(),
                    reason);
        }

        private static List<ComponentStats> flattenComponents(List<TextLineClusterer.TextLine> lines) {
            java.util.ArrayList<ComponentStats> all = new java.util.ArrayList<>();
            for (TextLineClusterer.TextLine line : lines) {
                all.addAll(line.components);
            }
            return all;
        }
    }
}
