package com.mentra.asg_client.io.media.core.textdetect.roi;

import ai.onnxruntime.OrtException;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import java.io.IOException;

/** ONNX detector for FAST text segmentation models. */
public final class OnnxFastRoiDetector extends AbstractOnnxRoiDetector {
    /**
     * Loads a FAST detector model.
     *
     * @param model {@link TextCropModel#FAST_TINY} or {@link TextCropModel#FAST_SMALL}
     * @param source model byte source
     * @throws IOException when the model cannot be loaded
     * @throws OrtException when the model cannot be initialized
     */
    public OnnxFastRoiDetector(TextCropModel model, ModelSource source)
            throws IOException, OrtException {
        super(requireFast(model), source);
    }

    /** Runs inference and FAST segmentation-map postprocessing. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        return runInference(
                input,
                (outputs, elapsed) -> {
                    float[][] map = null;
                    for (Object output : outputs) {
                        map = OnnxDbNetRoiDetector.extractProbabilityMap(output);
                        if (map != null) {
                            break;
                        }
                    }
                    return RoiPostprocessor.postprocessProbabilityMap(
                            map, input.width(), input.height(), 0.5f, 0.5f, 1.25f, id(), elapsed);
                });
    }

    private static TextCropModel requireFast(TextCropModel model) {
        if (model == null || !"fast".equals(model.family())) {
            throw new IllegalArgumentException("A FAST model is required");
        }
        return model;
    }
}
