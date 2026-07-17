package com.mentra.asg_client.io.media.core.textdetect.roi;

import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;

/** Swappable strategy for locating a likely text crop in a luminance image. */
public interface TextRoiDetector extends AutoCloseable {
    /**
     * Detects a text region.
     *
     * @param input validated luminance image
     * @return a non-null crop result in input-image coordinates
     */
    DetectionResult detect(DetectionInput input);

    /** Returns the stable identifier of this detector. */
    String id();

    /** Returns whether this detector is initialized and available for inference. */
    default boolean isReady() {
        return true;
    }

    /**
     * Whether {@link #detect}'s returned {@code CropRect} is already expressed in the original
     * full-resolution source-image coordinates.
     *
     * <p>Classical and ONNX detectors analyze a subsampled luma buffer sized by {@code
     * TextDetectConfig#analysisWidth} and return the crop in that subsampled space, so the caller
     * must still scale the result up to source-pixel coordinates (see {@code
     * GrayscaleBleProcessor#scaleDetectionRoi}). ML Kit decodes and analyzes the original sensor
     * JPEG bytes itself and already returns a source-pixel crop, so it overrides this to {@code
     * true} and callers must not scale its result again.
     */
    default boolean returnsNativeCoordinates() {
        return false;
    }

    /**
     * Starts model initialization ahead of the first real {@link #detect} call, so cold-start
     * latency does not land on the capture path. Safe to call repeatedly; a no-op by default.
     */
    default void warmUp() {}

    /** Releases detector resources. */
    @Override
    default void close() {}
}
