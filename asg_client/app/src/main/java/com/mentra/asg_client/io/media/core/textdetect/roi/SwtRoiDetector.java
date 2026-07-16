package com.mentra.asg_client.io.media.core.textdetect.roi;

import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.TextRegionDetector;
import java.util.Objects;

/**
 * Stroke-width-filtered variant of the classical detector.
 *
 * <p>This intentionally reuses the maintained classical pipeline rather than implementing a
 * separate stroke-width transform.
 */
public final class SwtRoiDetector implements TextRoiDetector {
    private final TextDetectConfig config;

    /**
     * Creates a stroke-width-filtered detector while preserving all supplied configuration.
     *
     * @param config base classical detector configuration
     */
    public SwtRoiDetector(TextDetectConfig config) {
        Objects.requireNonNull(config, "config");
        this.config =
                config.toBuilder()
                        .enableStrokeWidthFilter(true)
                        .maxStrokeWidthCv(0.6f)
                        .cropFromTopLineOnly(true)
                        .improvedCropAccuracy(true)
                        .build();
    }

    /** Detects a crop with the stroke-width-filtered classical pipeline. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        Objects.requireNonNull(input, "input");
        return TextRegionDetector.detect(
                input.lumaUnsafe(), input.width(), input.height(), config);
    }

    /** Returns {@code swt}. */
    @Override
    public String id() {
        return TextCropModel.SWT.id();
    }
}
