package com.mentra.asg_client.io.media.core.textdetect.roi;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import java.io.IOException;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Base class that owns one persistent ONNX Runtime session and shared image preprocessing. */
public abstract class AbstractOnnxRoiDetector implements TextRoiDetector {
    private static final float[] IMAGENET_MEAN = {0.485f, 0.456f, 0.406f};
    private static final float[] IMAGENET_STD = {0.229f, 0.224f, 0.225f};

    private final TextCropModel model;
    private final OrtEnvironment environment;
    private final OrtSession session;
    private final String inputName;
    private volatile boolean closed;

    /**
     * Loads and initializes one model session.
     *
     * @param model neural model metadata
     * @param source source containing the model asset
     * @throws IOException when model bytes cannot be loaded
     * @throws OrtException when ONNX Runtime cannot initialize the model
     */
    protected AbstractOnnxRoiDetector(TextCropModel model, ModelSource source)
            throws IOException, OrtException {
        this.model = Objects.requireNonNull(model, "model");
        Objects.requireNonNull(source, "source");
        if (model.assetFilename() == null) {
            throw new IllegalArgumentException("Model has no ONNX asset: " + model);
        }
        byte[] modelBytes = source.load(model.assetFilename());
        environment = OrtEnvironment.getEnvironment();
        OrtSession createdSession;
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            createdSession = environment.createSession(modelBytes, options);
        }
        String discoveredInput = createdSession.getInputNames().stream().findFirst().orElse(null);
        if (discoveredInput == null) {
            createdSession.close();
            throw new IllegalArgumentException("ONNX model has no inputs");
        }
        session = createdSession;
        inputName = discoveredInput;
    }

    /** Returns the selected model's stable identifier. */
    @Override
    public final String id() {
        return model.id();
    }

    /** Returns false after this detector has been closed. */
    @Override
    public final boolean isReady() {
        return !closed;
    }

    /** Closes the owned model session. */
    @Override
    public final void close() {
        if (!closed) {
            closed = true;
            try {
                session.close();
            } catch (OrtException ignored) {
                // Closing is best-effort and the interface cannot surface checked failures.
            }
        }
    }

    final TextCropModel model() {
        return model;
    }

    final DetectionResult runInference(DetectionInput input, InferencePostprocessor postprocessor) {
        Objects.requireNonNull(input, "input");
        if (closed) {
            throw new IllegalStateException("Detector is closed");
        }
        long start = System.currentTimeMillis();
        float[] normalized = resizeAndNormalize(input, model.inputWidth(), model.inputHeight());
        long[] shape = {1, 3, model.inputHeight(), model.inputWidth()};
        try (OnnxTensor tensor =
                        OnnxTensor.createTensor(environment, FloatBuffer.wrap(normalized), shape);
                OrtSession.Result result = session.run(Map.of(inputName, tensor))) {
            List<Object> outputs = new ArrayList<>(result.size());
            for (int i = 0; i < result.size(); i++) {
                OnnxValue value = result.get(i);
                outputs.add(value.getValue());
            }
            return postprocessor.process(outputs, System.currentTimeMillis() - start);
        } catch (OrtException | RuntimeException exception) {
            return RoiPostprocessor.fallback(
                    input.width(),
                    input.height(),
                    id(),
                    System.currentTimeMillis() - start,
                    "onnx_inference_failed");
        }
    }

    private static float[] resizeAndNormalize(
            DetectionInput input, int outputWidth, int outputHeight) {
        int planeSize = outputWidth * outputHeight;
        float[] output = new float[planeSize * 3];
        byte[] luma = input.lumaUnsafe();
        for (int y = 0; y < outputHeight; y++) {
            float sourceY = ((y + 0.5f) * input.height() / outputHeight) - 0.5f;
            int y0 = Math.max(0, Math.min(input.height() - 1, (int) Math.floor(sourceY)));
            int y1 = Math.min(input.height() - 1, y0 + 1);
            float yWeight = Math.max(0, sourceY - y0);
            for (int x = 0; x < outputWidth; x++) {
                float sourceX = ((x + 0.5f) * input.width() / outputWidth) - 0.5f;
                int x0 = Math.max(0, Math.min(input.width() - 1, (int) Math.floor(sourceX)));
                int x1 = Math.min(input.width() - 1, x0 + 1);
                float xWeight = Math.max(0, sourceX - x0);
                float top =
                        unsigned(luma[y0 * input.width() + x0]) * (1f - xWeight)
                                + unsigned(luma[y0 * input.width() + x1]) * xWeight;
                float bottom =
                        unsigned(luma[y1 * input.width() + x0]) * (1f - xWeight)
                                + unsigned(luma[y1 * input.width() + x1]) * xWeight;
                float value = (top * (1f - yWeight) + bottom * yWeight) / 255f;
                int pixel = y * outputWidth + x;
                for (int channel = 0; channel < 3; channel++) {
                    output[channel * planeSize + pixel] =
                            (value - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel];
                }
            }
        }
        return output;
    }

    private static int unsigned(byte value) {
        return value & 0xff;
    }

    @FunctionalInterface
    interface InferencePostprocessor {
        DetectionResult process(List<Object> outputs, long elapsedMs);
    }
}
