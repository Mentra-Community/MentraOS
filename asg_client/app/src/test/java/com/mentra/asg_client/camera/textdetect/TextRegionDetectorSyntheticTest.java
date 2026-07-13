package com.mentra.asg_client.camera.textdetect;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.TextRegionDetector;
import java.util.Arrays;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.JUnit4;

/** Smoke test with a synthetic document-like image (no external fixtures required). */
@RunWith(JUnit4.class)
public class TextRegionDetectorSyntheticTest {

    @BeforeClass
    public static void loadOpenCv() {
        CvInit.ensureLoaded();
    }

    @Test
    public void detect_findsSyntheticTextRegion() {
        int width = 800;
        int height = 600;
        byte[] luma = renderSyntheticDocument(width, height);

        TextDetectConfig config = TextDetectConfig.defaults();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        assertTrue(result.roi.width() > 0);
        assertTrue(result.roi.height() > 0);
        assertTrue(result.detectionTimeMs >= 0);
        if (result.debug != null) {
            result.debug.release();
        }
    }

    /**
     * Regression test for the center-fallback bug: a single text line close to (but not touching)
     * the frame edge — the windshield-VIN geometry. Safety padding around the detected line
     * reaches the frame boundary by design; that must not be mistaken for clipped text and
     * trigger the 75% center-crop fallback, which would discard a correct detection.
     */
    @Test
    public void detect_edgeProximateTextLine_doesNotCenterFallback() {
        int width = 800;
        int height = 600;
        int textLeft = 80;
        int textTop = 12;
        int textRight = 700;
        int textBottom = textTop + 24;
        byte[] luma = renderSingleLine(width, height, textLeft, textTop, textRight, textBottom);

        TextDetectConfig config = TextDetectConfig.defaults();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        String reason = result.fallbackReason == null ? "" : result.fallbackReason;
        assertFalse(
                "padding reaching the frame edge must not trigger the center fallback, got: "
                        + reason,
                reason.contains("untrustworthy_detection_center_fallback"));
        // The detected crop must contain the text line. The 75% center crop starts at
        // y = height * 0.125 = 75, below the text at y=12, so containment also proves the
        // result is a real detection rather than the fallback box.
        assertTrue(
                "crop " + result.roi + " must contain the text line",
                result.roi.contains(new CropRect(textLeft, textTop, textRight, textBottom)));
        if (result.debug != null) {
            result.debug.release();
        }
    }

    private static byte[] renderSingleLine(
            int width, int height, int left, int top, int right, int bottom) {
        byte[] luma = new byte[width * height];
        Arrays.fill(luma, (byte) 255);
        // Stroke-like glyphs (an "H" shape per cell) rather than solid blocks: solid rectangles
        // have fill ratio ~1.0 and are correctly rejected by the maxFillRatio component filter.
        int cellWidth = 24;
        int gapWidth = 8;
        int strokeWidth = 5;
        for (int cellLeft = left; cellLeft + cellWidth <= right; cellLeft += cellWidth + gapWidth) {
            // Left and right vertical strokes.
            fillRect(luma, width, cellLeft, top, cellLeft + strokeWidth, bottom, (byte) 0);
            fillRect(
                    luma,
                    width,
                    cellLeft + cellWidth - strokeWidth,
                    top,
                    cellLeft + cellWidth,
                    bottom,
                    (byte) 0);
            // Horizontal crossbar.
            int midY = (top + bottom) / 2;
            fillRect(
                    luma,
                    width,
                    cellLeft,
                    midY - strokeWidth / 2,
                    cellLeft + cellWidth,
                    midY + strokeWidth / 2 + 1,
                    (byte) 0);
        }
        return luma;
    }

    private static byte[] renderSyntheticDocument(int width, int height) {
        byte[] luma = new byte[width * height];
        Arrays.fill(luma, (byte) 255);

        int left = 80;
        int right = 520;
        int top = 100;
        int lineHeight = 24;
        int lineSpacing = 42;

        for (int line = 0; line < 6; line++) {
            int y0 = top + line * lineSpacing;
            int y1 = y0 + lineHeight;
            fillRect(luma, width, left, y0, right, y1, (byte) 0);

            // Character-like gaps so connected components resemble glyph runs.
            for (int gap = 0; gap < 14; gap++) {
                int gapLeft = left + 18 + gap * 30;
                fillRect(luma, width, gapLeft, y0, gapLeft + 6, y1, (byte) 255);
            }
        }

        return luma;
    }

    private static void fillRect(
            byte[] luma, int width, int left, int top, int right, int bottom, byte value) {
        int clampedRight = Math.min(right, width);
        int clampedBottom = Math.min(bottom, luma.length / width);
        for (int y = top; y < clampedBottom; y++) {
            int row = y * width;
            for (int x = left; x < clampedRight; x++) {
                luma[row + x] = value;
            }
        }
    }
}
