package com.mentra.asg_client.io.media.core.textdetect.roi;

import ai.onnxruntime.OrtException;
import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** ONNX detector for EAST score-and-geometry text models. */
public final class OnnxEastRoiDetector extends AbstractOnnxRoiDetector {
    /**
     * Loads an EAST detector model.
     *
     * @param model {@link TextCropModel#EAST_LITE}
     * @param source model byte source
     * @throws IOException when the model cannot be loaded
     * @throws OrtException when the model cannot be initialized
     */
    public OnnxEastRoiDetector(TextCropModel model, ModelSource source)
            throws IOException, OrtException {
        super(requireEast(model), source);
    }

    /** Runs inference and decodes EAST score and geometry tensors. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        return runInference(
                input,
                (outputs, elapsed) -> {
                    float[][] score = null;
                    float[][][] geometry = null;
                    for (Object output : outputs) {
                        if (!(output instanceof float[][][][])) {
                            continue;
                        }
                        float[][][][] tensor = (float[][][][]) output;
                        if (tensor.length == 0) {
                            continue;
                        }
                        if (tensor[0].length == 1) {
                            score = tensor[0][0];
                        } else if (tensor[0].length >= 5) {
                            geometry = tensor[0];
                        }
                    }
                    return postprocess(
                            score,
                            geometry,
                            model().inputWidth(),
                            model().inputHeight(),
                            input.width(),
                            input.height(),
                            elapsed,
                            id());
                });
    }

    /**
     * Decodes standard EAST outputs without creating an ONNX session.
     *
     * @param scores score map in {@code [H][W]} layout
     * @param geometry geometry channels in {@code [5][H][W]} layout
     * @param modelWidth model input width
     * @param modelHeight model input height
     * @param inputWidth source image width
     * @param inputHeight source image height
     * @param elapsedMs elapsed inference time to record
     * @param detectorId detector identifier
     * @return detected or fallback crop
     */
    public static DetectionResult postprocess(
            float[][] scores,
            float[][][] geometry,
            int modelWidth,
            int modelHeight,
            int inputWidth,
            int inputHeight,
            long elapsedMs,
            String detectorId) {
        if (!valid(scores, geometry)) {
            return RoiPostprocessor.fallback(
                    inputWidth, inputHeight, detectorId, elapsedMs, "unsupported_east_output");
        }
        int rows = scores.length;
        int columns = scores[0].length;
        float strideX = modelWidth / (float) columns;
        float strideY = modelHeight / (float) rows;
        List<CropRect> boxes = new ArrayList<>();
        for (int y = 0; y < rows; y++) {
            for (int x = 0; x < columns; x++) {
                if (scores[y][x] < 0.5f) {
                    continue;
                }
                float top = geometry[0][y][x];
                float right = geometry[1][y][x];
                float bottom = geometry[2][y][x];
                float left = geometry[3][y][x];
                float angle = geometry[4][y][x];
                float originX = x * strideX;
                float originY = y * strideY;
                CropRect box =
                        enclosingRotatedBox(
                                originX,
                                originY,
                                left,
                                top,
                                right,
                                bottom,
                                angle,
                                modelWidth,
                                modelHeight);
                if (box.width() >= 3 && box.height() >= 3) {
                    boxes.add(box);
                }
            }
        }
        return RoiPostprocessor.resultFromBoxes(
                boxes,
                modelWidth,
                modelHeight,
                inputWidth,
                inputHeight,
                detectorId,
                elapsedMs,
                "no_east_boxes");
    }

    private static CropRect enclosingRotatedBox(
            float originX,
            float originY,
            float left,
            float top,
            float right,
            float bottom,
            float angle,
            int width,
            int height) {
        float cosine = (float) Math.cos(angle);
        float sine = (float) Math.sin(angle);
        float[] localX = {-left, right, right, -left};
        float[] localY = {-top, -top, bottom, bottom};
        float minX = Float.POSITIVE_INFINITY;
        float minY = Float.POSITIVE_INFINITY;
        float maxX = Float.NEGATIVE_INFINITY;
        float maxY = Float.NEGATIVE_INFINITY;
        for (int i = 0; i < 4; i++) {
            float x = originX + localX[i] * cosine - localY[i] * sine;
            float y = originY + localX[i] * sine + localY[i] * cosine;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
        return CropRect.clamp(
                new CropRect(
                        (int) Math.floor(minX),
                        (int) Math.floor(minY),
                        (int) Math.ceil(maxX),
                        (int) Math.ceil(maxY)),
                width,
                height);
    }

    private static boolean valid(float[][] scores, float[][][] geometry) {
        if (scores == null
                || scores.length == 0
                || scores[0] == null
                || scores[0].length == 0
                || geometry == null
                || geometry.length < 5) {
            return false;
        }
        int rows = scores.length;
        int columns = scores[0].length;
        for (int channel = 0; channel < 5; channel++) {
            if (geometry[channel] == null || geometry[channel].length != rows) {
                return false;
            }
            for (int row = 0; row < rows; row++) {
                if (geometry[channel][row] == null
                        || geometry[channel][row].length != columns) {
                    return false;
                }
            }
        }
        return true;
    }

    private static TextCropModel requireEast(TextCropModel model) {
        if (model != TextCropModel.EAST_LITE) {
            throw new IllegalArgumentException("EAST_LITE model is required");
        }
        return model;
    }
}
