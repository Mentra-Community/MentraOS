package com.mentra.asg_client.io.media.core.textdetect.roi;

import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import java.util.Objects;

/** Creates text ROI detectors and provides classical fallback for unavailable ONNX models. */
public final class TextRoiDetectorFactory {
    private TextRoiDetectorFactory() {}

    /**
     * Creates the selected detector.
     *
     * <p>{@code source} may be null for classical models. Neural model loading or initialization
     * failures return a detector retaining the requested identifier while delegating detection to
     * the classical implementation.
     *
     * @param model selected detector model
     * @param config classical and MSER configuration
     * @param source ONNX model source, required only for neural models
     * @return initialized detector or a classical fallback wrapper
     */
    public static TextRoiDetector create(
            TextCropModel model, TextDetectConfig config, ModelSource source) {
        Objects.requireNonNull(model, "model");
        Objects.requireNonNull(config, "config");
        switch (model) {
            case CLASSICAL:
                return new ClassicalRoiDetector(config);
            case SWT:
                return new SwtRoiDetector(config);
            case MSER_ONLY:
                return new MserOnlyRoiDetector(config);
            default:
                return createOnnxOrFallback(model, config, source);
        }
    }

    private static TextRoiDetector createOnnxOrFallback(
            TextCropModel model, TextDetectConfig config, ModelSource source) {
        try {
            switch (model.family()) {
                case "dbnet":
                    return new OnnxDbNetRoiDetector(model, source);
                case "fast":
                    return new OnnxFastRoiDetector(model, source);
                case "east":
                    return new OnnxEastRoiDetector(model, source);
                case "yolo":
                    return new OnnxYoloRoiDetector(model, source);
                default:
                    throw new IllegalArgumentException(
                            "Unsupported text detector family: " + model.family());
            }
        } catch (Exception | LinkageError exception) {
            return new ClassicalFallbackDetector(model.id(), new ClassicalRoiDetector(config));
        }
    }

    private static final class ClassicalFallbackDetector implements TextRoiDetector {
        private final String requestedId;
        private final ClassicalRoiDetector delegate;

        ClassicalFallbackDetector(String requestedId, ClassicalRoiDetector delegate) {
            this.requestedId = requestedId;
            this.delegate = delegate;
        }

        @Override
        public DetectionResult detect(DetectionInput input) {
            return delegate.detect(input);
        }

        @Override
        public String id() {
            return requestedId + "->classical";
        }

        @Override
        public void close() {
            delegate.close();
        }
    }
}
