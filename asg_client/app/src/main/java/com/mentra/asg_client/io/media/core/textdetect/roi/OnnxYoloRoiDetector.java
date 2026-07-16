package com.mentra.asg_client.io.media.core.textdetect.roi;

import ai.onnxruntime.OrtException;
import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** ONNX detector for YOLO text-box models. */
public final class OnnxYoloRoiDetector extends AbstractOnnxRoiDetector {
    /**
     * Loads a YOLO text detector.
     *
     * @param model {@link TextCropModel#YOLO_NANO_TEXT}
     * @param source model byte source
     * @throws IOException when the model cannot be loaded
     * @throws OrtException when the model cannot be initialized
     */
    public OnnxYoloRoiDetector(TextCropModel model, ModelSource source)
            throws IOException, OrtException {
        super(requireYolo(model), source);
    }

    /** Runs inference, confidence filtering, and IoU non-maximum suppression. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        return runInference(
                input,
                (outputs, elapsed) -> {
                    float[][] predictions = null;
                    for (Object output : outputs) {
                        if (output instanceof float[][][]) {
                            float[][][] tensor = (float[][][]) output;
                            if (tensor.length > 0) {
                                predictions = tensor[0];
                                break;
                            }
                        } else if (output instanceof float[][]) {
                            predictions = (float[][]) output;
                            break;
                        }
                    }
                    return postprocess(
                            predictions,
                            model().inputWidth(),
                            model().inputHeight(),
                            input.width(),
                            input.height(),
                            elapsed,
                            id());
                });
    }

    /**
     * Parses either {@code [N][5+]} or transposed {@code [4+C][N]} YOLO predictions.
     *
     * <p>Each returned row is {@code [left, top, right, bottom, confidence]} in model-input
     * coordinates after confidence filtering and 0.45-IoU non-maximum suppression.
     *
     * @param output unbatched YOLO output
     * @param modelWidth model input width
     * @param modelHeight model input height
     * @return retained boxes
     */
    public static List<float[]> parseDetections(float[][] output, int modelWidth, int modelHeight) {
        List<float[]> candidates = new ArrayList<>();
        if (output == null || output.length == 0 || output[0] == null) {
            return candidates;
        }
        boolean transposed =
                output[0].length < 5 || (output.length >= 5 && output.length < output[0].length);
        if (transposed) {
            int channels = output.length;
            int count = output[0].length;
            if (channels < 5 || !rectangular(output, count)) {
                return candidates;
            }
            for (int index = 0; index < count; index++) {
                float confidence = 0;
                for (int channel = 4; channel < channels; channel++) {
                    confidence = Math.max(confidence, output[channel][index]);
                }
                addCandidate(
                        candidates,
                        output[0][index],
                        output[1][index],
                        output[2][index],
                        output[3][index],
                        confidence,
                        modelWidth,
                        modelHeight);
            }
        } else {
            for (float[] prediction : output) {
                if (prediction == null || prediction.length < 5) {
                    continue;
                }
                float confidence = prediction[4];
                if (prediction.length > 5) {
                    float classScore = 0;
                    for (int channel = 5; channel < prediction.length; channel++) {
                        classScore = Math.max(classScore, prediction[channel]);
                    }
                    confidence *= classScore;
                }
                addCandidate(
                        candidates,
                        prediction[0],
                        prediction[1],
                        prediction[2],
                        prediction[3],
                        confidence,
                        modelWidth,
                        modelHeight);
            }
        }
        candidates.sort(Comparator.comparingDouble(box -> -box[4]));
        List<float[]> retained = new ArrayList<>();
        for (float[] candidate : candidates) {
            boolean suppressed = false;
            for (float[] accepted : retained) {
                if (iou(candidate, accepted) > 0.45f) {
                    suppressed = true;
                    break;
                }
            }
            if (!suppressed) {
                retained.add(candidate);
            }
        }
        return retained;
    }

    /**
     * Produces a source-image crop from an unbatched YOLO output without creating a session.
     *
     * @param output unbatched YOLO output
     * @param modelWidth model input width
     * @param modelHeight model input height
     * @param inputWidth source image width
     * @param inputHeight source image height
     * @param elapsedMs elapsed inference time to record
     * @param detectorId detector identifier
     * @return detected or fallback crop
     */
    public static DetectionResult postprocess(
            float[][] output,
            int modelWidth,
            int modelHeight,
            int inputWidth,
            int inputHeight,
            long elapsedMs,
            String detectorId) {
        List<CropRect> boxes = new ArrayList<>();
        for (float[] box : parseDetections(output, modelWidth, modelHeight)) {
            boxes.add(
                    CropRect.clamp(
                            new CropRect(
                                    (int) Math.floor(box[0]),
                                    (int) Math.floor(box[1]),
                                    (int) Math.ceil(box[2]),
                                    (int) Math.ceil(box[3])),
                            modelWidth,
                            modelHeight));
        }
        return RoiPostprocessor.resultFromBoxes(
                boxes,
                modelWidth,
                modelHeight,
                inputWidth,
                inputHeight,
                detectorId,
                elapsedMs,
                "no_yolo_boxes");
    }

    private static void addCandidate(
            List<float[]> candidates,
            float centerX,
            float centerY,
            float width,
            float height,
            float confidence,
            int modelWidth,
            int modelHeight) {
        if (confidence < 0.4f || width <= 0 || height <= 0) {
            return;
        }
        if (Math.abs(centerX) <= 2f && Math.abs(centerY) <= 2f && width <= 2f && height <= 2f) {
            centerX *= modelWidth;
            width *= modelWidth;
            centerY *= modelHeight;
            height *= modelHeight;
        }
        float left = Math.max(0, centerX - width * 0.5f);
        float top = Math.max(0, centerY - height * 0.5f);
        float right = Math.min(modelWidth, centerX + width * 0.5f);
        float bottom = Math.min(modelHeight, centerY + height * 0.5f);
        if (right - left >= 1 && bottom - top >= 1) {
            candidates.add(new float[] {left, top, right, bottom, confidence});
        }
    }

    private static float iou(float[] first, float[] second) {
        float intersectionWidth =
                Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0]));
        float intersectionHeight =
                Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1]));
        float intersection = intersectionWidth * intersectionHeight;
        float firstArea = (first[2] - first[0]) * (first[3] - first[1]);
        float secondArea = (second[2] - second[0]) * (second[3] - second[1]);
        return intersection / Math.max(1e-6f, firstArea + secondArea - intersection);
    }

    private static boolean rectangular(float[][] values, int columns) {
        for (float[] row : values) {
            if (row == null || row.length != columns) {
                return false;
            }
        }
        return true;
    }

    private static TextCropModel requireYolo(TextCropModel model) {
        if (model != TextCropModel.YOLO_NANO_TEXT) {
            throw new IllegalArgumentException("YOLO_NANO_TEXT model is required");
        }
        return model;
    }
}
