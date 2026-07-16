package com.mentra.asg_client.io.media.core.textdetect.roi;

import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.TextRegionDetector;
import java.util.Objects;

/** Adapter exposing the existing classical text-region detector through the ROI detector API. */
public final class ClassicalRoiDetector implements TextRoiDetector {
    private final TextDetectConfig config;

    /**
     * Creates a classical detector.
     *
     * @param config classical detector configuration
     */
    public ClassicalRoiDetector(TextDetectConfig config) {
        this.config = Objects.requireNonNull(config, "config");
    }

    /** Detects a crop with the classical text-region pipeline. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        Objects.requireNonNull(input, "input");
        return TextRegionDetector.detect(input.lumaUnsafe(), input.width(), input.height(), config);
    }

    /** Returns {@code classical}. */
    @Override
    public String id() {
        return TextCropModel.CLASSICAL.id();
    }
}
