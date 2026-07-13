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
                .debugCaptureIntermediates(debugCaptureIntermediates);
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

        public TextDetectConfig build() {
            return new TextDetectConfig(this);
        }
    }
}
