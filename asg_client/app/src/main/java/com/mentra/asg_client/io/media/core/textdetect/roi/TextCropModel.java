package com.mentra.asg_client.io.media.core.textdetect.roi;

/** Available classical and neural text-crop implementations. */
public enum TextCropModel {
    CLASSICAL("classical", "classical", null, 0, 0),
    SWT("swt", "classical", null, 0, 0),
    MSER_ONLY("mser_only", "classical", null, 0, 0),
    PPOCR_V6_TINY_DET("ppocr_v6_tiny_det", "dbnet", "ppocr_v6_tiny_det.onnx", 640, 640),
    PPOCR_V5_MOBILE_DET("ppocr_v5_mobile_det", "dbnet", "ppocr_v5_mobile_det.onnx", 640, 640),
    PPOCR_V6_SMALL_DET("ppocr_v6_small_det", "dbnet", "ppocr_v6_small_det.onnx", 640, 640),
    FAST_TINY("fast_tiny", "fast", "fast_tiny.onnx", 640, 640),
    FAST_SMALL("fast_small", "fast", "fast_small.onnx", 640, 640),
    EAST_LITE("east_lite", "east", "east_lite.onnx", 320, 320),
    YOLO_NANO_TEXT("yolo_nano_text", "yolo", "yolo_nano_text.onnx", 640, 640);

    private final String id;
    private final String family;
    private final String assetFilename;
    private final int inputWidth;
    private final int inputHeight;

    TextCropModel(String id, String family, String assetFilename, int inputWidth, int inputHeight) {
        this.id = id;
        this.family = family;
        this.assetFilename = assetFilename;
        this.inputWidth = inputWidth;
        this.inputHeight = inputHeight;
    }

    /** Returns the stable lowercase model identifier. */
    public String id() {
        return id;
    }

    /** Returns the detector architecture family. */
    public String family() {
        return family;
    }

    /** Returns the model asset filename, or {@code null} for non-neural detectors. */
    public String assetFilename() {
        return assetFilename;
    }

    /** Returns the neural model input width, or zero for non-neural detectors. */
    public int inputWidth() {
        return inputWidth;
    }

    /** Returns the neural model input height, or zero for non-neural detectors. */
    public int inputHeight() {
        return inputHeight;
    }
}
