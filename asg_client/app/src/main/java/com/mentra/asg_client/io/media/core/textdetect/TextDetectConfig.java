package com.mentra.asg_client.io.media.core.textdetect;

/**
 * Tunable parameters for the classical text-region detector. Defaults are mid-points of the sweep
 * ranges from the BLE text-crop spec; tune offline against real Mentra captures before changing
 * production values.
 */
public final class TextDetectConfig {
    /** Analysis image width in pixels (height preserves aspect ratio). */
    public final int analysisWidth;

    /** Adaptive threshold block size (must be odd). */
    public final int adaptiveThresholdBlockSize;

    /** Adaptive threshold C offset subtracted from local mean. */
    public final int adaptiveThresholdC;

    /** Gaussian blur kernel size before thresholding (odd, 0 = skip). */
    public final int gaussianBlurKernelSize;

    /** Morphology kernel size (square). */
    public final int morphologyKernelSize;

    /** Min component height as fraction of analysis image height. */
    public final float minHeightFraction;

    /** Max component height as fraction of analysis image height. */
    public final float maxHeightFraction;

    /** Min component width as fraction of analysis image width. */
    public final float minWidthFraction;

    /** Max component width as fraction of analysis image width. */
    public final float maxWidthFraction;

    /** Min aspect ratio (width / height). */
    public final float minAspectRatio;

    /** Max aspect ratio (width / height). */
    public final float maxAspectRatio;

    /** Min fill ratio (area / bbox area). */
    public final float minFillRatio;

    /** Max fill ratio (area / bbox area). */
    public final float maxFillRatio;

    /** Min height ratio between compatible line components. */
    public final float lineHeightRatioMin;

    /** Max height ratio between compatible line components. */
    public final float lineHeightRatioMax;

    /** Min vertical overlap fraction for line clustering. */
    public final float lineMinVerticalOverlap;

    /** Max center-Y distance as multiple of max component height. */
    public final float lineMaxCenterYDistanceFactor;

    /** Max horizontal gap as multiple of median component height. */
    public final float lineMaxHorizontalGapFactor;

    /** Min components to accept a line as text-like. */
    public final int minComponentsPerLine;

    /** Horizontal padding as fraction of ROI width. */
    public final float paddingHorizontalFraction;

    /** Vertical padding as fraction of ROI height. */
    public final float paddingVerticalFraction;

    /** Horizontal padding as multiple of median component height. */
    public final float paddingHorizontalHeightFactor;

    /** Vertical padding as multiple of median component height. */
    public final float paddingVerticalHeightFactor;

    /** Min score to treat detection as high confidence. */
    public final float highConfidenceScore;

    /** Min score to treat detection as medium confidence. */
    public final float mediumConfidenceScore;

    /** When true, retain intermediate masks/overlays for offline harness dumps. */
    public final boolean debugCaptureIntermediates;

    // --- Experimental feature flags (Tier 1-3 noise-robustness fixes; default off) ---

    /**
     * Tier 1 fix: crop from the single top-scoring text line's bounds instead of the union of
     * every accepted line. Without this, one noise-driven line anywhere in the frame (dust,
     * reflections, foliage) can balloon the crop out to the image boundary and trigger the
     * center-crop safety fallback even when the real text line was detected correctly.
     */
    public final boolean cropFromTopLineOnly;

    /** Tier 1: apply tighter aspect-ratio/fill-ratio bounds on top of the base config values. */
    public final boolean strictComponentFilters;

    /** Tier 1: reject components whose gradient-orientation structure doesn't look stroke-like. */
    public final boolean enableStructureFilter;

    /** Min {@code ComponentStats.structureScore} to accept a component when the filter is on. */
    public final float minStructureScore;

    /** Tier 2: reject components whose stroke-width consistency doesn't look character-like. */
    public final boolean enableStrokeWidthFilter;

    /** Max {@code ComponentStats.strokeWidthCv} to accept a component when the filter is on. */
    public final float maxStrokeWidthCv;

    /**
     * Tier 2: split components that are far too elongated (fused character runs, e.g. a whole VIN
     * merged into one blob by morphological closing) into sub-components by vertical-projection
     * gaps, instead of discarding them outright on the aspect-ratio filter.
     */
    public final boolean enableBlobSplitting;

    /**
     * Tier 3: add MSER (Maximally Stable Extremal Regions) candidate blobs alongside the
     * adaptive-threshold connected components, as an additional/alternate detection source.
     */
    public final boolean enableMser;

    /**
     * Min crop-area fraction (of the analysis image) for {@code isTrustworthyCrop} to accept a
     * detection instead of falling back to the center crop. The original 0.02 default was
     * calibrated against union-of-all-lines crops (typically large paragraphs); a single tight
     * VIN/label line (see {@code cropFromTopLineOnly}) is legitimately much smaller, so this is
     * tunable independently.
     */
    public final float minCropAreaFraction;

    /**
     * When true, runs the crop-accuracy fixes; when false, the original cropping algorithm runs
     * unchanged. The fixes:
     *
     * <ul>
     *   <li>Trust checks (boundary contact, min area) run against the raw pre-padding detected
     *       bounds instead of the padded crop. The padded crop is clamped to the frame edge by
     *       design whenever text sits near a boundary, which the original logic misread as
     *       clipped text — discarding correct detections in favor of the 75% center fallback.
     *   <li>The polarity-disagreement and medium-confidence paths pad from the raw bounds
     *       instead of re-padding the already padded crop (double padding).
     * </ul>
     */
    public final boolean improvedCropAccuracy;

    private TextDetectConfig(Builder builder) {
        this.analysisWidth = builder.analysisWidth;
        this.adaptiveThresholdBlockSize = builder.adaptiveThresholdBlockSize;
        this.adaptiveThresholdC = builder.adaptiveThresholdC;
        this.gaussianBlurKernelSize = builder.gaussianBlurKernelSize;
        this.morphologyKernelSize = builder.morphologyKernelSize;
        this.minHeightFraction = builder.minHeightFraction;
        this.maxHeightFraction = builder.maxHeightFraction;
        this.minWidthFraction = builder.minWidthFraction;
        this.maxWidthFraction = builder.maxWidthFraction;
        this.minAspectRatio = builder.minAspectRatio;
        this.maxAspectRatio = builder.maxAspectRatio;
        this.minFillRatio = builder.minFillRatio;
        this.maxFillRatio = builder.maxFillRatio;
        this.lineHeightRatioMin = builder.lineHeightRatioMin;
        this.lineHeightRatioMax = builder.lineHeightRatioMax;
        this.lineMinVerticalOverlap = builder.lineMinVerticalOverlap;
        this.lineMaxCenterYDistanceFactor = builder.lineMaxCenterYDistanceFactor;
        this.lineMaxHorizontalGapFactor = builder.lineMaxHorizontalGapFactor;
        this.minComponentsPerLine = builder.minComponentsPerLine;
        this.paddingHorizontalFraction = builder.paddingHorizontalFraction;
        this.paddingVerticalFraction = builder.paddingVerticalFraction;
        this.paddingHorizontalHeightFactor = builder.paddingHorizontalHeightFactor;
        this.paddingVerticalHeightFactor = builder.paddingVerticalHeightFactor;
        this.highConfidenceScore = builder.highConfidenceScore;
        this.mediumConfidenceScore = builder.mediumConfidenceScore;
        this.debugCaptureIntermediates = builder.debugCaptureIntermediates;
        this.cropFromTopLineOnly = builder.cropFromTopLineOnly;
        this.strictComponentFilters = builder.strictComponentFilters;
        this.enableStructureFilter = builder.enableStructureFilter;
        this.minStructureScore = builder.minStructureScore;
        this.enableStrokeWidthFilter = builder.enableStrokeWidthFilter;
        this.maxStrokeWidthCv = builder.maxStrokeWidthCv;
        this.enableBlobSplitting = builder.enableBlobSplitting;
        this.enableMser = builder.enableMser;
        this.minCropAreaFraction = builder.minCropAreaFraction;
        this.improvedCropAccuracy = builder.improvedCropAccuracy;
    }

    public static TextDetectConfig defaults() {
        return new Builder().build();
    }

    public Builder toBuilder() {
        return new Builder()
                .analysisWidth(analysisWidth)
                .adaptiveThresholdBlockSize(adaptiveThresholdBlockSize)
                .adaptiveThresholdC(adaptiveThresholdC)
                .gaussianBlurKernelSize(gaussianBlurKernelSize)
                .morphologyKernelSize(morphologyKernelSize)
                .minHeightFraction(minHeightFraction)
                .maxHeightFraction(maxHeightFraction)
                .minWidthFraction(minWidthFraction)
                .maxWidthFraction(maxWidthFraction)
                .minAspectRatio(minAspectRatio)
                .maxAspectRatio(maxAspectRatio)
                .minFillRatio(minFillRatio)
                .maxFillRatio(maxFillRatio)
                .lineHeightRatioMin(lineHeightRatioMin)
                .lineHeightRatioMax(lineHeightRatioMax)
                .lineMinVerticalOverlap(lineMinVerticalOverlap)
                .lineMaxCenterYDistanceFactor(lineMaxCenterYDistanceFactor)
                .lineMaxHorizontalGapFactor(lineMaxHorizontalGapFactor)
                .minComponentsPerLine(minComponentsPerLine)
                .paddingHorizontalFraction(paddingHorizontalFraction)
                .paddingVerticalFraction(paddingVerticalFraction)
                .paddingHorizontalHeightFactor(paddingHorizontalHeightFactor)
                .paddingVerticalHeightFactor(paddingVerticalHeightFactor)
                .highConfidenceScore(highConfidenceScore)
                .mediumConfidenceScore(mediumConfidenceScore)
                .debugCaptureIntermediates(debugCaptureIntermediates)
                .cropFromTopLineOnly(cropFromTopLineOnly)
                .strictComponentFilters(strictComponentFilters)
                .enableStructureFilter(enableStructureFilter)
                .minStructureScore(minStructureScore)
                .enableStrokeWidthFilter(enableStrokeWidthFilter)
                .maxStrokeWidthCv(maxStrokeWidthCv)
                .enableBlobSplitting(enableBlobSplitting)
                .enableMser(enableMser)
                .minCropAreaFraction(minCropAreaFraction)
                .improvedCropAccuracy(improvedCropAccuracy);
    }

    public static final class Builder {
        private int analysisWidth = 640;
        private int adaptiveThresholdBlockSize = 31;
        private int adaptiveThresholdC = 10;
        private int gaussianBlurKernelSize = 3;
        private int morphologyKernelSize = 3;
        private float minHeightFraction = 0.01f;
        private float maxHeightFraction = 0.30f;
        private float minWidthFraction = 0.001f;
        private float maxWidthFraction = 0.30f;
        private float minAspectRatio = 0.08f;
        private float maxAspectRatio = 10f;
        private float minFillRatio = 0.05f;
        private float maxFillRatio = 0.95f;
        private float lineHeightRatioMin = 0.5f;
        private float lineHeightRatioMax = 2.0f;
        private float lineMinVerticalOverlap = 0.5f;
        private float lineMaxCenterYDistanceFactor = 0.5f;
        private float lineMaxHorizontalGapFactor = 4.0f;
        private int minComponentsPerLine = 2;
        private float paddingHorizontalFraction = 0.22f;
        private float paddingVerticalFraction = 0.30f;
        private float paddingHorizontalHeightFactor = 1.5f;
        private float paddingVerticalHeightFactor = 1.0f;
        private float highConfidenceScore = 8.0f;
        private float mediumConfidenceScore = 4.0f;
        private boolean debugCaptureIntermediates = false;
        private boolean cropFromTopLineOnly = false;
        private boolean strictComponentFilters = false;
        private boolean enableStructureFilter = false;
        private float minStructureScore = 0.35f;
        private boolean enableStrokeWidthFilter = false;
        private float maxStrokeWidthCv = 0.6f;
        private boolean enableBlobSplitting = false;
        private boolean enableMser = false;
        private float minCropAreaFraction = 0.02f;
        private boolean improvedCropAccuracy = false;

        public Builder analysisWidth(int value) {
            this.analysisWidth = value;
            return this;
        }

        public Builder adaptiveThresholdBlockSize(int value) {
            this.adaptiveThresholdBlockSize = value;
            return this;
        }

        public Builder adaptiveThresholdC(int value) {
            this.adaptiveThresholdC = value;
            return this;
        }

        public Builder gaussianBlurKernelSize(int value) {
            this.gaussianBlurKernelSize = value;
            return this;
        }

        public Builder morphologyKernelSize(int value) {
            this.morphologyKernelSize = value;
            return this;
        }

        public Builder minHeightFraction(float value) {
            this.minHeightFraction = value;
            return this;
        }

        public Builder maxHeightFraction(float value) {
            this.maxHeightFraction = value;
            return this;
        }

        public Builder minWidthFraction(float value) {
            this.minWidthFraction = value;
            return this;
        }

        public Builder maxWidthFraction(float value) {
            this.maxWidthFraction = value;
            return this;
        }

        public Builder minAspectRatio(float value) {
            this.minAspectRatio = value;
            return this;
        }

        public Builder maxAspectRatio(float value) {
            this.maxAspectRatio = value;
            return this;
        }

        public Builder minFillRatio(float value) {
            this.minFillRatio = value;
            return this;
        }

        public Builder maxFillRatio(float value) {
            this.maxFillRatio = value;
            return this;
        }

        public Builder lineHeightRatioMin(float value) {
            this.lineHeightRatioMin = value;
            return this;
        }

        public Builder lineHeightRatioMax(float value) {
            this.lineHeightRatioMax = value;
            return this;
        }

        public Builder lineMinVerticalOverlap(float value) {
            this.lineMinVerticalOverlap = value;
            return this;
        }

        public Builder lineMaxCenterYDistanceFactor(float value) {
            this.lineMaxCenterYDistanceFactor = value;
            return this;
        }

        public Builder lineMaxHorizontalGapFactor(float value) {
            this.lineMaxHorizontalGapFactor = value;
            return this;
        }

        public Builder minComponentsPerLine(int value) {
            this.minComponentsPerLine = value;
            return this;
        }

        public Builder paddingHorizontalFraction(float value) {
            this.paddingHorizontalFraction = value;
            return this;
        }

        public Builder paddingVerticalFraction(float value) {
            this.paddingVerticalFraction = value;
            return this;
        }

        public Builder paddingHorizontalHeightFactor(float value) {
            this.paddingHorizontalHeightFactor = value;
            return this;
        }

        public Builder paddingVerticalHeightFactor(float value) {
            this.paddingVerticalHeightFactor = value;
            return this;
        }

        public Builder highConfidenceScore(float value) {
            this.highConfidenceScore = value;
            return this;
        }

        public Builder mediumConfidenceScore(float value) {
            this.mediumConfidenceScore = value;
            return this;
        }

        public Builder debugCaptureIntermediates(boolean value) {
            this.debugCaptureIntermediates = value;
            return this;
        }

        public Builder cropFromTopLineOnly(boolean value) {
            this.cropFromTopLineOnly = value;
            return this;
        }

        public Builder strictComponentFilters(boolean value) {
            this.strictComponentFilters = value;
            return this;
        }

        public Builder enableStructureFilter(boolean value) {
            this.enableStructureFilter = value;
            return this;
        }

        public Builder minStructureScore(float value) {
            this.minStructureScore = value;
            return this;
        }

        public Builder enableStrokeWidthFilter(boolean value) {
            this.enableStrokeWidthFilter = value;
            return this;
        }

        public Builder maxStrokeWidthCv(float value) {
            this.maxStrokeWidthCv = value;
            return this;
        }

        public Builder enableBlobSplitting(boolean value) {
            this.enableBlobSplitting = value;
            return this;
        }

        public Builder enableMser(boolean value) {
            this.enableMser = value;
            return this;
        }

        public Builder minCropAreaFraction(float value) {
            this.minCropAreaFraction = value;
            return this;
        }

        public Builder improvedCropAccuracy(boolean value) {
            this.improvedCropAccuracy = value;
            return this;
        }

        public TextDetectConfig build() {
            return new TextDetectConfig(this);
        }
    }
}
