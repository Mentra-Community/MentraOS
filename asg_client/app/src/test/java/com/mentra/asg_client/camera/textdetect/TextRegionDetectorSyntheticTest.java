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
     * Regression test for the center-fallback bug (gated behind {@code improvedCropAccuracy}): a
     * single text line close to (but not touching) the frame edge — the windshield-VIN geometry.
     * Safety padding around the detected line reaches the frame boundary by design; that must not
     * be mistaken for clipped text and trigger the 75% center-crop fallback, which would discard
     * a correct detection.
     */
    @Test
    public void detect_edgeProximateTextLine_improvedAccuracy_doesNotCenterFallback() {
        int width = 800;
        int height = 600;
        int textLeft = 80;
        int textTop = 12;
        int textRight = 700;
        int textBottom = textTop + 24;
        byte[] luma = renderSingleLine(width, height, textLeft, textTop, textRight, textBottom);

        TextDetectConfig config =
                TextDetectConfig.defaults().toBuilder().improvedCropAccuracy(true).build();
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

    /**
     * With {@code improvedCropAccuracy} off (the default), the original algorithm runs unchanged:
     * trust checks judge the padded crop, so the same edge-proximate line falls back to the 75%
     * center crop. Guards that the flag actually switches behavior.
     */
    @Test
    public void detect_edgeProximateTextLine_defaultConfig_usesOriginalFallbackBehavior() {
        int width = 800;
        int height = 600;
        byte[] luma = renderSingleLine(width, height, 80, 12, 700, 36);

        TextDetectConfig config = TextDetectConfig.defaults();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        String reason = result.fallbackReason == null ? "" : result.fallbackReason;
        assertTrue(
                "original algorithm is expected to center-fallback on edge-proximate text, got: "
                        + reason,
                reason.contains("untrustworthy_detection_center_fallback"));
        if (result.debug != null) {
            result.debug.release();
        }
    }

    /**
     * Regression test for the "fused single word" bug: a short word whose letters merge into one
     * connected component via morphological closing (tight kerning, low analysis resolution)
     * can't satisfy {@code minComponentsPerLine} on its own, so it is silently dropped while an
     * unrelated multi-blob noise cluster elsewhere in the frame (cable loops, device corners - a
     * handful of small, roughly square/circular blobs with compatible height/spacing) wins by
     * default. With the default config, no genuine text line is ever formed, so the detector
     * falls back to the safety-net center crop rather than a real detection.
     */
    @Test
    public void detect_fusedWordVsNoiseCluster_defaultConfig_wordIsDropped() {
        int width = 800;
        int height = 600;
        CropRect word = fusedWordBounds();
        byte[] luma = renderFusedWordAndNoiseCluster(width, height, word);

        TextDetectConfig config = TextDetectConfig.defaults();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        String reason = result.fallbackReason == null ? "" : result.fallbackReason;
        assertTrue(
                "with the word dropped, the noise-only cluster should not be trusted either,"
                        + " expected a center-crop fallback, got reason="
                        + reason
                        + " confidence="
                        + result.confidence,
                reason.contains("untrustworthy_detection_center_fallback"));
        if (result.debug != null) {
            result.debug.release();
        }
    }

    /**
     * With {@code allowSingleComponentLines} (promotes a lone, notably-wide-than-tall component
     * to a candidate line) and {@code cropFromTopLineOnly} (crop from the single best-scoring line
     * instead of unioning every accepted line, so a real but unrelated noise cluster elsewhere in
     * the frame can't drag the crop away from the actual text), the fused word is detected and
     * wins the crop on its own merits - tightly, without also pulling in the noise cluster.
     */
    @Test
    public void detect_fusedWordVsNoiseCluster_singleComponentFix_wordWins() {
        int width = 800;
        int height = 600;
        CropRect word = fusedWordBounds();
        byte[] luma = renderFusedWordAndNoiseCluster(width, height, word);

        TextDetectConfig config =
                TextDetectConfig.defaults()
                        .toBuilder()
                        .allowSingleComponentLines(true)
                        .cropFromTopLineOnly(true)
                        .build();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        assertTrue(
                "crop " + result.roi + " must contain the fused word " + word,
                result.roi.contains(word));
        assertFalse(
                "crop " + result.roi + " must not also pull in the unrelated noise cluster"
                        + " near the top-left corner",
                result.roi.contains(new CropRect(20, 20, 140, 140)));
        if (result.debug != null) {
            result.debug.release();
        }
    }

    /** A fused word must also be trustworthy when it is the only component in the frame. */
    @Test
    public void detect_fusedWordOnly_productionConfig_doesNotCenterFallback() {
        int width = 800;
        int height = 600;
        CropRect word = fusedWordBounds();
        byte[] luma = renderFusedWordOnly(width, height, word);

        TextDetectConfig config =
                TextDetectConfig.defaults()
                        .toBuilder()
                        .allowSingleComponentLines(true)
                        .cropFromTopLineOnly(true)
                        .enableStructureFilter(true)
                        .improvedCropAccuracy(true)
                        .minCropAreaFraction(0.004f)
                        .build();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        String reason = result.fallbackReason == null ? "" : result.fallbackReason;
        assertFalse(
                "a deliberately promoted fused word must not be rejected only for having one"
                        + " connected component, got: "
                        + reason,
                reason.contains("untrustworthy_detection_center_fallback"));
        assertTrue("crop " + result.roi + " must contain " + word, result.roi.contains(word));
        if (result.debug != null) {
            result.debug.release();
        }
    }

    /**
     * Regression test for periodic non-text patterns (spiral notebook binding holes, speaker
     * grilles, perforated metal) out-scoring real text: a long, perfectly regular row of small
     * round dots satisfies the line-scoring formula's height-consistency and spacing-regularity
     * terms extremely well (better than most real text), and its large component count directly
     * inflates the score, so with only the single-component-line fix, it wins the crop over an
     * actual fused word elsewhere in frame.
     */
    @Test
    public void detect_fusedWordVsPeriodicDotRow_singleComponentFixAlone_dotRowWins() {
        int width = 800;
        int height = 600;
        CropRect word = fusedWordBounds();
        CropRect dotRow = periodicDotRowBounds();
        byte[] luma = renderFusedWordAndPeriodicDotRow(width, height, word, dotRow);

        TextDetectConfig config =
                TextDetectConfig.defaults()
                        .toBuilder()
                        .allowSingleComponentLines(true)
                        .cropFromTopLineOnly(true)
                        .build();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        assertTrue(
                "documents the bug: without a structure filter, the periodic dot row should win"
                        + " the crop over the real word, got roi="
                        + result.roi,
                result.roi.contains(dotRow));
        if (result.debug != null) {
            result.debug.release();
        }
    }

    /**
     * With {@code enableStructureFilter} also on, round dots (radially-symmetric gradients spread
     * across all orientation bins) fail the structure filter and are dropped as components
     * entirely, while the word's glyph strokes (gradient magnitude concentrated in one or two
     * dominant orientations) pass - so the word wins the crop instead of the dot row.
     */
    @Test
    public void detect_fusedWordVsPeriodicDotRow_structureFilter_wordWins() {
        int width = 800;
        int height = 600;
        CropRect word = fusedWordBounds();
        CropRect dotRow = periodicDotRowBounds();
        byte[] luma = renderFusedWordAndPeriodicDotRow(width, height, word, dotRow);

        TextDetectConfig config =
                TextDetectConfig.defaults()
                        .toBuilder()
                        .allowSingleComponentLines(true)
                        .cropFromTopLineOnly(true)
                        .enableStructureFilter(true)
                        .build();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        assertNotNull(result.roi);
        assertTrue(
                "crop " + result.roi + " must contain the fused word " + word,
                result.roi.contains(word));
        assertFalse(
                "crop " + result.roi + " must not be dominated by the periodic dot row " + dotRow,
                result.roi.contains(dotRow));
        if (result.debug != null) {
            result.debug.release();
        }
    }

    private static CropRect fusedWordBounds() {
        return new CropRect(320, 260, 480, 300);
    }

    private static CropRect periodicDotRowBounds() {
        return new CropRect(150, 40, 650, 56);
    }

    /**
     * Renders the fused word plus a long, perfectly regular row of small filled circles (spiral
     * notebook binding holes) spanning most of the frame width near the top - radially-symmetric
     * shapes, unlike glyph strokes, so {@code enableStructureFilter} can tell them apart.
     */
    private static byte[] renderFusedWordAndPeriodicDotRow(
            int width, int height, CropRect word, CropRect dotRow) {
        byte[] luma = renderFusedWordOnly(width, height, word);

        int radius = 7;
        int centerY = (dotRow.top + dotRow.bottom) / 2;
        int spacing = 24;
        for (int cx = dotRow.left + radius; cx + radius <= dotRow.right; cx += spacing) {
            fillCircle(luma, width, height, cx, centerY, radius, (byte) 0);
        }
        return luma;
    }

    private static byte[] renderFusedWordOnly(int width, int height, CropRect word) {
        byte[] luma = new byte[width * height];
        Arrays.fill(luma, (byte) 255);
        renderFusedWordCells(luma, width, word);
        return luma;
    }

    private static void fillCircle(
            byte[] luma, int width, int height, int cx, int cy, int radius, byte value) {
        int rSquared = radius * radius;
        for (int y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
            int dy = y - cy;
            int row = y * width;
            for (int x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
                int dx = x - cx;
                if (dx * dx + dy * dy <= rSquared) {
                    luma[row + x] = value;
                }
            }
        }
    }

    /**
     * Renders a single wide "word" blob whose internal cell gaps are narrower than the default
     * morphology kernel, so adaptive threshold + closing fuses it into one connected component
     * (mimicking tightly-kerned letters like "TEXT"), plus 4 small, mutually-compatible square
     * blobs clustered near the top-left corner (mimicking cable-loop/device-corner noise that
     * satisfies {@code minComponentsPerLine} on its own).
     */
    private static byte[] renderFusedWordAndNoiseCluster(int width, int height, CropRect word) {
        byte[] luma = new byte[width * height];
        Arrays.fill(luma, (byte) 255);
        renderFusedWordCells(luma, width, word);

        // Noise cluster: 4 small hollow-square (loop-like) blobs near the top-left corner, evenly
        // spaced so they satisfy areCompatible() (similar height, full vertical overlap, small
        // horizontal gaps) and cluster into a single accepted line of size >= minComponentsPerLine
        // on their own. Hollow rather than solid so fillRatio stays well under maxFillRatio, same
        // as a real cable loop's thin traced outline.
        int blobSize = 18;
        int blobTop = 40;
        int blobGap = 14;
        int ringStroke = 4;
        for (int i = 0; i < 4; i++) {
            int blobLeft = 20 + i * (blobSize + blobGap);
            int blobRight = blobLeft + blobSize;
            int blobBottom = blobTop + blobSize;
            fillRect(luma, width, blobLeft, blobTop, blobRight, blobTop + ringStroke, (byte) 0);
            fillRect(luma, width, blobLeft, blobBottom - ringStroke, blobRight, blobBottom, (byte) 0);
            fillRect(luma, width, blobLeft, blobTop, blobLeft + ringStroke, blobBottom, (byte) 0);
            fillRect(luma, width, blobRight - ringStroke, blobTop, blobRight, blobBottom, (byte) 0);
        }

        return luma;
    }

    /**
     * Draws "H"-cell glyphs with a 1px gap - well under the default 3x3 morphology kernel's
     * closing reach, so the whole run becomes a single connected component (mimicking
     * tightly-kerned letters like "TEXT").
     */
    private static void renderFusedWordCells(byte[] luma, int width, CropRect word) {
        int cellWidth = 24;
        int gapWidth = 1;
        int strokeWidth = 5;
        for (int cellLeft = word.left;
                cellLeft + cellWidth <= word.right;
                cellLeft += cellWidth + gapWidth) {
            fillRect(luma, width, cellLeft, word.top, cellLeft + strokeWidth, word.bottom, (byte) 0);
            fillRect(
                    luma,
                    width,
                    cellLeft + cellWidth - strokeWidth,
                    word.top,
                    cellLeft + cellWidth,
                    word.bottom,
                    (byte) 0);
            int midY = (word.top + word.bottom) / 2;
            fillRect(
                    luma,
                    width,
                    cellLeft,
                    midY - strokeWidth / 2,
                    cellLeft + cellWidth,
                    midY + strokeWidth / 2 + 1,
                    (byte) 0);
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
