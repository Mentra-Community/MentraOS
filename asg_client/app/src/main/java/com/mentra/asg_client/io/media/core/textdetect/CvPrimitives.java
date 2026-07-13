package com.mentra.asg_client.io.media.core.textdetect;

import java.util.ArrayList;
import java.util.List;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Point;
import org.opencv.core.Scalar;
import org.opencv.core.Size;
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

        List<ComponentStats> components = extractComponents(cleaned, gray.cols(), gray.rows());
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

    private static List<ComponentStats> extractComponents(Mat binary, int imageWidth, int imageHeight) {
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
            components.add(
                    new ComponentStats(
                            left, top, width, height, area, centroidX, centroidY, fillRatio));
        }

        labels.release();
        stats.release();
        centroids.release();
        return components;
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
