package com.mentra.asg_client.camera.textdetect;

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
