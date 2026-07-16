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

    /** Releases detector resources. */
    @Override
    default void close() {}
}
