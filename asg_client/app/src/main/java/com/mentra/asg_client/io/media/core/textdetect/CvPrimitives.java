package com.mentra.asg_client.io.media.core.textdetect;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfPoint;
import org.opencv.core.MatOfRect;
import org.opencv.core.Point;
import org.opencv.core.Rect;
import org.opencv.core.Scalar;
import org.opencv.core.Size;
import org.opencv.features2d.MSER;
import org.opencv.imgproc.Imgproc;

/**
 * OpenCV-backed CV primitives for the text-region detector: resize, blur, dual-polarity adaptive
 * threshold, morphology, and connected-component extraction.
 */
final class CvPrimitives {
    static final String POLARITY_DARK_ON_LIGHT = "dark_on_light";
    static final String POLARITY_LIGHT_ON_DARK = "light_on_dark";

    private CvPrimitives() {}

    static AnalysisFrame prepareAnalysisFrame(byte[] luma, int width, int height, TextDetectConfig config) {
        Mat source = new Mat(height, width, CvType.CV_8UC1);
        source.put(0, 0, luma);

        int analysisWidth = config.analysisWidth;
        int analysisHeight = Math.max(1, Math.round(height * (analysisWidth / (float) width)));
        Mat resized = new Mat();
        Imgproc.resize(
                source,
                resized,
                new Size(analysisWidth, analysisHeight),
                0,
                0,
                Imgproc.INTER_AREA);
        source.release();

        if (config.gaussianBlurKernelSize >= 3) {
            Mat blurred = new Mat();
            int k = ensureOdd(config.gaussianBlurKernelSize);
            Imgproc.GaussianBlur(resized, blurred, new Size(k, k), 0);
            resized.release();
            resized = blurred;
        }

        float scaleX = width / (float) analysisWidth;
        float scaleY = height / (float) analysisHeight;
        return new AnalysisFrame(resized, analysisWidth, analysisHeight, scaleX, scaleY);
    }

    static PolarityPipelineResult runPolarityPipeline(Mat gray, TextDetectConfig config, String polarity) {
        Mat thresholded = new Mat();
        int blockSize = ensureOdd(config.adaptiveThresholdBlockSize);
        int thresholdType =
                POLARITY_LIGHT_ON_DARK.equals(polarity)
                        ? Imgproc.THRESH_BINARY_INV
                        : Imgproc.THRESH_BINARY;
        Imgproc.adaptiveThreshold(
                gray,
                thresholded,
                255,
                Imgproc.ADAPTIVE_THRESH_MEAN_C,
                thresholdType,
                blockSize,
                config.adaptiveThresholdC);

        Mat cleaned = applyMorphology(thresholded, config);
        thresholded.release();

        List<ComponentStats> components =
                extractComponents(gray, cleaned, gray.cols(), gray.rows(), config);
        if (config.enableBlobSplitting) {
            components = splitFusedComponents(cleaned, components, config);
        }
        return new PolarityPipelineResult(polarity, cleaned, components);
    }

    private static Mat applyMorphology(Mat binary, TextDetectConfig config) {
        int k = Math.max(2, config.morphologyKernelSize);
        Mat kernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, new Size(k, k));
        Mat opened = new Mat();
        Mat closed = new Mat();
        Imgproc.morphologyEx(binary, opened, Imgproc.MORPH_OPEN, kernel);
        Imgproc.morphologyEx(opened, closed, Imgproc.MORPH_CLOSE, kernel);
        opened.release();
        kernel.release();
        return closed;
    }

    private static List<ComponentStats> extractComponents(
            Mat gray, Mat binary, int imageWidth, int imageHeight, TextDetectConfig config) {
        Mat labels = new Mat();
        Mat stats = new Mat();
        Mat centroids = new Mat();
        int count =
                Imgproc.connectedComponentsWithStats(
                        binary, labels, stats, centroids, 8, CvType.CV_32S);

        List<ComponentStats> components = new ArrayList<>();
        for (int label = 1; label < count; label++) {
            int left = (int) stats.get(label, Imgproc.CC_STAT_LEFT)[0];
            int top = (int) stats.get(label, Imgproc.CC_STAT_TOP)[0];
            int width = (int) stats.get(label, Imgproc.CC_STAT_WIDTH)[0];
            int height = (int) stats.get(label, Imgproc.CC_STAT_HEIGHT)[0];
            int area = (int) stats.get(label, Imgproc.CC_STAT_AREA)[0];
            float centroidX = (float) centroids.get(label, 0)[0];
            float centroidY = (float) centroids.get(label, 1)[0];
            int bboxArea = Math.max(1, width * height);
            float fillRatio = area / (float) bboxArea;
            float structureScore =
                    config.enableStructureFilter
                            ? computeStructureScore(gray, left, top, width, height)
                            : 1f;
            float strokeWidthCv =
                    config.enableStrokeWidthFilter
                            ? computeStrokeWidthCv(binary, left, top, width, height)
                            : 0f;
            components.add(
                    new ComponentStats(
                            left,
                            top,
                            width,
                            height,
                            area,
                            centroidX,
                            centroidY,
                            fillRatio,
                            structureScore,
                            strokeWidthCv));
        }

        labels.release();
        stats.release();
        centroids.release();
        return components;
    }

    /**
     * Tier 1 structure filter: concentration of gradient-magnitude-weighted edge orientations in
     * the component's dominant two histogram bins (0..1). Text strokes tend toward one or two
     * dominant edge directions; random texture (dust, foliage) tends toward a flatter
     * distribution across all directions.
     */
    private static float computeStructureScore(Mat gray, int left, int top, int width, int height) {
        if (width < 3 || height < 3) {
            return 1f;
        }
        Rect roi = clampRoi(left, top, width, height, gray.cols(), gray.rows());
        Mat sub = new Mat(gray, roi);
        Mat gx = new Mat();
        Mat gy = new Mat();
        Mat mag = new Mat();
        Mat angle = new Mat();
        try {
            Imgproc.Sobel(sub, gx, CvType.CV_32F, 1, 0, 3);
            Imgproc.Sobel(sub, gy, CvType.CV_32F, 0, 1, 3);
            Core.cartToPolar(gx, gy, mag, angle, true);

            int bins = 8;
            double[] hist = new double[bins];
            double totalMag = 0;
            int rows = mag.rows();
            int cols = mag.cols();
            float[] magRow = new float[cols];
            float[] angRow = new float[cols];
            for (int r = 0; r < rows; r++) {
                mag.get(r, 0, magRow);
                angle.get(r, 0, angRow);
                for (int c = 0; c < cols; c++) {
                    double m = magRow[c];
                    if (m < 8.0) {
                        continue;
                    }
                    double a = angRow[c] % 180.0;
                    int bin = Math.min(bins - 1, (int) (a / (180.0 / bins)));
                    hist[bin] += m;
                    totalMag += m;
                }
            }
            if (totalMag < 1e-3) {
                return 0f;
            }
            double[] sortedHist = hist.clone();
            Arrays.sort(sortedHist);
            double top2 = sortedHist[bins - 1] + sortedHist[bins - 2];
            return (float) Math.min(1.0, top2 / totalMag);
        } finally {
            sub.release();
            gx.release();
            gy.release();
            mag.release();
            angle.release();
        }
    }

    /**
     * Tier 2 stroke-width filter: coefficient of variation (stddev/mean) of distance-transform
     * values inside the component's foreground mask. Real character strokes have fairly uniform
     * thickness (low CV); filled blobs and noisy texture vary more (high CV).
     */
    private static float computeStrokeWidthCv(Mat binary, int left, int top, int width, int height) {
        Rect roi = clampRoi(left, top, width, height, binary.cols(), binary.rows());
        Mat sub = new Mat(binary, roi);
        Mat dist = new Mat();
        try {
            Imgproc.distanceTransform(sub, dist, Imgproc.DIST_L2, 3);
            org.opencv.core.MatOfDouble meanMat = new org.opencv.core.MatOfDouble();
            org.opencv.core.MatOfDouble stdMat = new org.opencv.core.MatOfDouble();
            Core.meanStdDev(dist, meanMat, stdMat, sub);
            double mean = meanMat.toArray().length > 0 ? meanMat.toArray()[0] : 0;
            double std = stdMat.toArray().length > 0 ? stdMat.toArray()[0] : 0;
            meanMat.release();
            stdMat.release();
            if (mean < 1e-3) {
                return 0f;
            }
            return (float) (std / mean);
        } finally {
            sub.release();
            dist.release();
        }
    }

    private static Rect clampRoi(int left, int top, int width, int height, int maxWidth, int maxHeight) {
        int clampedLeft = Math.max(0, Math.min(left, maxWidth - 1));
        int clampedTop = Math.max(0, Math.min(top, maxHeight - 1));
        int clampedWidth = Math.max(1, Math.min(width, maxWidth - clampedLeft));
        int clampedHeight = Math.max(1, Math.min(height, maxHeight - clampedTop));
        return new Rect(clampedLeft, clampedTop, clampedWidth, clampedHeight);
    }

    /**
     * Tier 2 blob splitting: components far more elongated than {@code maxAspectRatio} (e.g. a
     * whole VIN fused into one blob by morphological closing) are split by vertical-projection
     * gaps instead of being discarded outright by the aspect-ratio filter.
     */
    private static List<ComponentStats> splitFusedComponents(
            Mat binary, List<ComponentStats> components, TextDetectConfig config) {
        List<ComponentStats> out = new ArrayList<>();
        for (ComponentStats c : components) {
            float aspect = c.width / (float) Math.max(1, c.height);
            if (aspect <= config.maxAspectRatio || c.width < 4) {
                out.add(c);
                continue;
            }
            List<ComponentStats> pieces = splitByColumnProjection(binary, c);
            if (pieces.size() <= 1) {
                out.add(c);
            } else {
                out.addAll(pieces);
            }
        }
        return out;
    }

    private static List<ComponentStats> splitByColumnProjection(Mat binary, ComponentStats c) {
        Rect roi = clampRoi(c.left, c.top, c.width, c.height, binary.cols(), binary.rows());
        Mat sub = new Mat(binary, roi);
        int width = roi.width;
        int height = roi.height;
        int[] colSums = new int[width];
        byte[] rowBuf = new byte[width];
        for (int y = 0; y < height; y++) {
            sub.get(y, 0, rowBuf);
            for (int x = 0; x < width; x++) {
                if (rowBuf[x] != 0) {
                    colSums[x]++;
                }
            }
        }
        sub.release();

        List<int[]> runs = new ArrayList<>();
        int runStart = -1;
        for (int x = 0; x < width; x++) {
            boolean hasInk = colSums[x] > 0;
            if (hasInk && runStart < 0) {
                runStart = x;
            } else if (!hasInk && runStart >= 0) {
                runs.add(new int[] {runStart, x});
                runStart = -1;
            }
        }
        if (runStart >= 0) {
            runs.add(new int[] {runStart, width});
        }

        List<int[]> mergedRuns = new ArrayList<>();
        for (int[] run : runs) {
            if (!mergedRuns.isEmpty()) {
                int[] last = mergedRuns.get(mergedRuns.size() - 1);
                if (run[0] - last[1] <= 1) {
                    last[1] = run[1];
                    continue;
                }
            }
            mergedRuns.add(new int[] {run[0], run[1]});
        }
        if (mergedRuns.size() <= 1) {
            return List.of(c);
        }

        List<ComponentStats> pieces = new ArrayList<>();
        for (int[] run : mergedRuns) {
            int pieceWidth = run[1] - run[0];
            if (pieceWidth < 1) {
                continue;
            }
            int pieceLeft = c.left + run[0];
            int area = 0;
            for (int x = run[0]; x < run[1]; x++) {
                area += colSums[x];
            }
            float fillRatio = area / (float) Math.max(1, pieceWidth * c.height);
            float centroidX = pieceLeft + pieceWidth * 0.5f;
            pieces.add(
                    new ComponentStats(
                            pieceLeft,
                            c.top,
                            pieceWidth,
                            c.height,
                            area,
                            centroidX,
                            c.centerY(),
                            fillRatio,
                            c.structureScore,
                            c.strokeWidthCv));
        }
        return pieces;
    }

    /**
     * Tier 3: MSER (Maximally Stable Extremal Regions) as an additional/alternate candidate-blob
     * source alongside the adaptive-threshold connected components. MSER has no polarity concept
     * of its own, so its candidates are merged into both dark and light polarity pipelines.
     */
    static List<ComponentStats> detectMserComponents(Mat gray) {
        MSER mser = MSER.create();
        List<MatOfPoint> regions = new ArrayList<>();
        MatOfRect bboxes = new MatOfRect();
        mser.detectRegions(gray, regions, bboxes);

        List<ComponentStats> out = new ArrayList<>();
        Rect[] rects = bboxes.toArray();
        for (int i = 0; i < rects.length; i++) {
            Rect r = rects[i];
            if (r.width <= 0 || r.height <= 0) {
                continue;
            }
            double contourArea = i < regions.size() ? Imgproc.contourArea(regions.get(i)) : 0;
            int area = contourArea > 0 ? (int) contourArea : r.width * r.height;
            float fillRatio = area / (float) Math.max(1, r.width * r.height);
            float centroidX = r.x + r.width * 0.5f;
            float centroidY = r.y + r.height * 0.5f;
            out.add(
                    new ComponentStats(
                            r.x, r.y, r.width, r.height, area, centroidX, centroidY, fillRatio, 1f, 0f));
        }
        for (MatOfPoint region : regions) {
            region.release();
        }
        bboxes.release();
        return out;
    }

    static Mat renderComponentsOverlay(Mat gray, List<ComponentStats> components) {
        Mat overlay = new Mat();
        Imgproc.cvtColor(gray, overlay, Imgproc.COLOR_GRAY2BGR);
        for (ComponentStats c : components) {
            Imgproc.rectangle(
                    overlay,
                    new Point(c.left, c.top),
                    new Point(c.right() - 1, c.bottom() - 1),
                    new Scalar(0, 255, 0),
                    1);
        }
        return overlay;
    }

    static Mat renderLinesOverlay(Mat gray, List<TextLineClusterer.TextLine> lines) {
        Mat overlay = new Mat();
        Imgproc.cvtColor(gray, overlay, Imgproc.COLOR_GRAY2BGR);
        for (TextLineClusterer.TextLine line : lines) {
            CropRect rect = line.bounds;
            Imgproc.rectangle(
                    overlay,
                    new Point(rect.left, rect.top),
                    new Point(rect.right - 1, rect.bottom - 1),
                    new Scalar(255, 128, 0),
                    2);
            for (ComponentStats c : line.components) {
                Imgproc.rectangle(
                        overlay,
                        new Point(c.left, c.top),
                        new Point(c.right() - 1, c.bottom() - 1),
                        new Scalar(0, 255, 0),
                        1);
            }
        }
        return overlay;
    }

    static Mat renderCropOverlay(Mat gray, CropRect crop) {
        Mat overlay = new Mat();
        Imgproc.cvtColor(gray, overlay, Imgproc.COLOR_GRAY2BGR);
        Imgproc.rectangle(
                overlay,
                new Point(crop.left, crop.top),
                new Point(crop.right - 1, crop.bottom - 1),
                new Scalar(0, 0, 255),
                2);
        return overlay;
    }

    static Mat matFromLuma(byte[] luma, int width, int height) {
        Mat mat = new Mat(height, width, CvType.CV_8UC1);
        mat.put(0, 0, luma);
        return mat;
    }

    static byte[] extractCropLuma(byte[] luma, int width, int height, CropRect crop) {
        int cropWidth = crop.width();
        int cropHeight = crop.height();
        byte[] out = new byte[cropWidth * cropHeight];
        for (int y = 0; y < cropHeight; y++) {
            int srcY = crop.top + y;
            int srcRow = srcY * width;
            int dstRow = y * cropWidth;
            System.arraycopy(luma, srcRow + crop.left, out, dstRow, cropWidth);
        }
        return out;
    }

    private static int ensureOdd(int value) {
        return (value % 2 == 0) ? value + 1 : value;
    }

    static final class AnalysisFrame {
        final Mat gray;
        final int width;
        final int height;
        final float scaleX;
        final float scaleY;

        AnalysisFrame(Mat gray, int width, int height, float scaleX, float scaleY) {
            this.gray = gray;
            this.width = width;
            this.height = height;
            this.scaleX = scaleX;
            this.scaleY = scaleY;
        }

        void release() {
            gray.release();
        }
    }

    static final class PolarityPipelineResult {
        final String polarity;
        final Mat thresholdMask;
        final List<ComponentStats> components;

        PolarityPipelineResult(String polarity, Mat thresholdMask, List<ComponentStats> components) {
            this.polarity = polarity;
            this.thresholdMask = thresholdMask;
            this.components = components;
        }

        void releaseMask() {
            thresholdMask.release();
        }
    }
}
