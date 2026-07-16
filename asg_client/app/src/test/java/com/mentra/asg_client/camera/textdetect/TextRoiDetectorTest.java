package com.mentra.asg_client.camera.textdetect;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.TextRegionDetector;
import com.mentra.asg_client.io.media.core.textdetect.roi.DetectionInput;
import com.mentra.asg_client.io.media.core.textdetect.roi.FileSystemModelSource;
import com.mentra.asg_client.io.media.core.textdetect.roi.OnnxDbNetRoiDetector;
import com.mentra.asg_client.io.media.core.textdetect.roi.OnnxYoloRoiDetector;
import com.mentra.asg_client.io.media.core.textdetect.roi.TextCropModel;
import com.mentra.asg_client.io.media.core.textdetect.roi.TextRoiDetector;
import com.mentra.asg_client.io.media.core.textdetect.roi.TextRoiDetectorFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.JUnit4;

/** Focused contract tests for swappable text ROI detectors and static neural postprocessing. */
@RunWith(JUnit4.class)
public class TextRoiDetectorTest {
    /** Loads desktop OpenCV before detector tests execute. */
    @BeforeClass
    public static void loadOpenCv() {
        CvInit.ensureLoaded();
    }

    /** Verifies that the classical adapter preserves every deterministic result field. */
    @Test
    public void classicalWrapper_matchesDirectDetectorFieldForField() {
        int width = 160;
        int height = 96;
        byte[] luma = syntheticLuma(width, height);
        TextDetectConfig config = productionConfig();

        DetectionResult direct = TextRegionDetector.detect(luma, width, height, config);
        DetectionResult wrapped;
        try (TextRoiDetector detector =
                TextRoiDetectorFactory.create(TextCropModel.CLASSICAL, config, null)) {
            wrapped = detector.detect(new DetectionInput(luma, width, height));
        }

        assertResultFieldsEqual(direct, wrapped);
        assertTrue(direct.detectionTimeMs >= 0);
        assertTrue(wrapped.detectionTimeMs >= 0);
    }

    /** Verifies that an absent PPOCR model produces an identified classical fallback. */
    @Test
    public void factory_missingModel_fallsBackToMatchingClassical() throws Exception {
        int width = 160;
        int height = 96;
        byte[] luma = syntheticLuma(width, height);
        DetectionInput input = new DetectionInput(luma, width, height);
        TextDetectConfig config = productionConfig();
        Path emptyModelDirectory = Files.createTempDirectory("text-roi-models");

        DetectionResult expected = TextRegionDetector.detect(luma, width, height, config);
        try (TextRoiDetector detector =
                TextRoiDetectorFactory.create(
                        TextCropModel.PPOCR_V5_MOBILE_DET,
                        config,
                        new FileSystemModelSource(emptyModelDirectory))) {
            assertEquals("ppocr_v5_mobile_det->classical", detector.id());
            assertResultFieldsEqual(expected, detector.detect(input));
        } finally {
            Files.deleteIfExists(emptyModelDirectory);
        }
    }

    /** Verifies that a positive DBNet map produces a genuine, non-fallback crop. */
    @Test
    public void dbNetPostprocess_positiveRectangle_returnsDetection() {
        float[][] probabilities = new float[16][16];
        for (int y = 5; y < 11; y++) {
            Arrays.fill(probabilities[y], 4, 12, 0.9f);
        }

        DetectionResult result = OnnxDbNetRoiDetector.postprocess(probabilities, 160, 160, 7);

        assertNull(result.fallbackReason);
        assertEquals(DetectionResult.Confidence.MEDIUM, result.confidence);
        assertTrue(result.acceptedComponentCount > 0);
        assertTrue(result.roi.pixelCount() < 160 * 160);
    }

    /** Verifies that an all-background DBNet map uses the standard fallback. */
    @Test
    public void dbNetPostprocess_blankMap_returnsFallback() {
        DetectionResult result = OnnxDbNetRoiDetector.postprocess(new float[16][16], 160, 160, 3);

        assertEquals("no_text_boxes", result.fallbackReason);
        assertEquals(DetectionResult.Confidence.LOW, result.confidence);
        assertArrayEquals(new int[] {20, 20, 120, 120}, result.roi.toArray());
    }

    /** Verifies YOLO confidence filtering and overlap suppression in one basic case. */
    @Test
    public void yoloParseDetections_filtersConfidenceAndAppliesNms() {
        float[][] predictions = {
            {50f, 50f, 40f, 20f, 0.90f},
            {52f, 50f, 40f, 20f, 0.80f},
            {15f, 15f, 10f, 10f, 0.39f},
            {85f, 80f, 12f, 10f, 0.70f}
        };

        List<float[]> retained = OnnxYoloRoiDetector.parseDetections(predictions, 100, 100);

        assertEquals(2, retained.size());
        assertArrayEquals(new float[] {30f, 40f, 70f, 60f, 0.90f}, retained.get(0), 0.0001f);
        assertArrayEquals(new float[] {79f, 75f, 91f, 85f, 0.70f}, retained.get(1), 0.0001f);
    }

    private static TextDetectConfig productionConfig() {
        return TextDetectConfig.defaults().toBuilder()
                .allowSingleComponentLines(true)
                .cropFromTopLineOnly(true)
                .enableStructureFilter(true)
                .improvedCropAccuracy(true)
                .minCropAreaFraction(0.004f)
                .build();
    }

    private static byte[] syntheticLuma(int width, int height) {
        byte[] luma = new byte[width * height];
        Arrays.fill(luma, (byte) 255);
        for (int glyphLeft = 28; glyphLeft < 126; glyphLeft += 14) {
            fill(luma, width, glyphLeft, 38, glyphLeft + 3, 58);
            fill(luma, width, glyphLeft + 7, 38, glyphLeft + 10, 58);
            fill(luma, width, glyphLeft, 47, glyphLeft + 10, 50);
        }
        return luma;
    }

    private static void fill(byte[] luma, int width, int left, int top, int right, int bottom) {
        for (int y = top; y < bottom; y++) {
            Arrays.fill(luma, y * width + left, y * width + right, (byte) 0);
        }
    }

    private static void assertResultFieldsEqual(DetectionResult expected, DetectionResult actual) {
        assertCropEquals(expected.roi, actual.roi);
        assertEquals(expected.confidence, actual.confidence);
        assertEquals(expected.selectedPolarity, actual.selectedPolarity);
        assertEquals(expected.acceptedComponentCount, actual.acceptedComponentCount);
        assertEquals(expected.lineCount, actual.lineCount);
        assertEquals(expected.fallbackReason, actual.fallbackReason);
        assertEquals(expected.debug, actual.debug);
    }

    private static void assertCropEquals(CropRect expected, CropRect actual) {
        assertFalse("expected crop must be non-empty", expected.pixelCount() == 0);
        assertArrayEquals(expected.toArray(), actual.toArray());
    }
}
