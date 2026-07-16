package com.mentra.asg_client.io.media.core.textdetect.roi;

import ai.onnxruntime.OrtException;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import java.io.IOException;
import java.util.List;

/** ONNX detector for PaddleOCR DBNet-style text segmentation models. */
public final class OnnxDbNetRoiDetector extends AbstractOnnxRoiDetector {
    /**
     * Loads a PaddleOCR detector model.
     *
     * @param model one of the PPOCR detector models
     * @param source model byte source
     * @throws IOException when the model cannot be loaded
     * @throws OrtException when the model cannot be initialized
     */
    public OnnxDbNetRoiDetector(TextCropModel model, ModelSource source)
            throws IOException, OrtException {
        super(requireDbNet(model), source);
    }

    /** Runs inference and DBNet probability-map postprocessing. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        return runInference(
                input,
                (outputs, elapsed) -> {
                    float[][] map = firstProbabilityMap(outputs);
                    return RoiPostprocessor.postprocessProbabilityMap(
                            map, input.width(), input.height(), 0.3f, 0.5f, 1.5f, id(), elapsed);
                });
    }

    /**
     * Postprocesses a DBNet probability map without creating an ONNX session.
     *
     * @param probabilityMap text probabilities indexed by row and column
     * @param inputWidth source image width
     * @param inputHeight source image height
     * @param elapsedMs elapsed inference time to record
     * @return detected or fallback crop
     */
    public static DetectionResult postprocess(
            float[][] probabilityMap, int inputWidth, int inputHeight, long elapsedMs) {
        return RoiPostprocessor.postprocessProbabilityMap(
                probabilityMap, inputWidth, inputHeight, 0.3f, 0.5f, 1.5f, "dbnet", elapsedMs);
    }

    /**
     * Extracts a two-dimensional map from standard {@code [1][1][H][W]} or {@code [1][H][W]}
     * output.
     *
     * @param output ONNX tensor value
     * @return probability map, or {@code null} for an unsupported shape
     */
    public static float[][] extractProbabilityMap(Object output) {
        if (output instanceof float[][][][]) {
            float[][][][] value = (float[][][][]) output;
            return value.length > 0 && value[0].length > 0 ? value[0][0] : null;
        }
        if (output instanceof float[][][]) {
            float[][][] value = (float[][][]) output;
            return value.length > 0 ? value[0] : null;
        }
        if (output instanceof float[][]) {
            return (float[][]) output;
        }
        return null;
    }

    private static float[][] firstProbabilityMap(List<Object> outputs) {
        for (Object output : outputs) {
            float[][] map = extractProbabilityMap(output);
            if (map != null) {
                return map;
            }
        }
        return null;
    }

    private static TextCropModel requireDbNet(TextCropModel model) {
        if (model == null || !"dbnet".equals(model.family())) {
            throw new IllegalArgumentException("A PPOCR DBNet model is required");
        }
        return model;
    }
}
