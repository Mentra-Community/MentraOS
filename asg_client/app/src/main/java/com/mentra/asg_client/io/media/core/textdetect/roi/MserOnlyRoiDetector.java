package com.mentra.asg_client.io.media.core.textdetect.roi;

import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfPoint;
import org.opencv.core.MatOfRect;
import org.opencv.core.Rect;
import org.opencv.core.Size;
import org.opencv.features2d.MSER;
import org.opencv.imgproc.Imgproc;

/** Standalone OpenCV MSER detector that does not depend on package-private CV primitives. */
public final class MserOnlyRoiDetector implements TextRoiDetector {
    private final TextDetectConfig config;

    /**
     * Creates an MSER-only detector.
     *
     * @param config geometry, fill, analysis-size, and padding constraints
     */
    public MserOnlyRoiDetector(TextDetectConfig config) {
        this.config = Objects.requireNonNull(config, "config");
    }

    /** Detects and unions MSER regions that satisfy the configured text geometry constraints. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        Objects.requireNonNull(input, "input");
        CvInit.ensureLoaded();
        long start = System.currentTimeMillis();
        int analysisWidth = config.analysisWidth;
        int analysisHeight =
                Math.max(1, Math.round(input.height() * analysisWidth / (float) input.width()));
        Mat source = new Mat(input.height(), input.width(), CvType.CV_8UC1);
        Mat analysis = new Mat();
        source.put(0, 0, input.lumaUnsafe());
        Imgproc.resize(
                source,
                analysis,
                new Size(analysisWidth, analysisHeight),
                0,
                0,
                Imgproc.INTER_AREA);
        source.release();

        MSER mser = MSER.create();
        List<MatOfPoint> regions = new ArrayList<>();
        MatOfRect boundingBoxes = new MatOfRect();
        try {
            mser.detectRegions(analysis, regions, boundingBoxes);
            Rect[] rectangles = boundingBoxes.toArray();
            List<CropRect> accepted = new ArrayList<>();
            int heightTotal = 0;
            for (int i = 0; i < rectangles.length; i++) {
                Rect rect = rectangles[i];
                double regionArea =
                        i < regions.size() ? Imgproc.contourArea(regions.get(i)) : rect.area();
                if (accept(rect, regionArea, analysisWidth, analysisHeight)) {
                    accepted.add(
                            new CropRect(
                                    rect.x, rect.y, rect.x + rect.width, rect.y + rect.height));
                    heightTotal += rect.height;
                }
            }
            long elapsed = System.currentTimeMillis() - start;
            if (accepted.isEmpty()) {
                return RoiPostprocessor.fallback(
                        input.width(), input.height(), id(), elapsed, "no_mser_regions");
            }

            CropRect raw = accepted.get(0);
            for (int i = 1; i < accepted.size(); i++) {
                raw = CropRect.union(raw, accepted.get(i));
            }
            float areaFraction = raw.pixelCount() / (float) (analysisWidth * analysisHeight);
            if (areaFraction < config.minCropAreaFraction
                    || areaFraction > 0.90f
                    || touchesBoundary(raw, analysisWidth, analysisHeight)) {
                return RoiPostprocessor.fallback(
                        input.width(), input.height(), id(), elapsed, "untrustworthy_mser_union");
            }

            float medianLikeHeight = heightTotal / (float) accepted.size();
            int padX =
                    Math.round(
                            Math.max(
                                    raw.width() * config.paddingHorizontalFraction,
                                    medianLikeHeight * config.paddingHorizontalHeightFactor));
            int padY =
                    Math.round(
                            Math.max(
                                    raw.height() * config.paddingVerticalFraction,
                                    medianLikeHeight * config.paddingVerticalHeightFactor));
            CropRect padded =
                    CropRect.clamp(
                            new CropRect(
                                    raw.left - padX,
                                    raw.top - padY,
                                    raw.right + padX,
                                    raw.bottom + padY),
                            analysisWidth,
                            analysisHeight);
            float scaleX = input.width() / (float) analysisWidth;
            float scaleY = input.height() / (float) analysisHeight;
            CropRect mapped =
                    CropRect.clamp(
                            new CropRect(
                                    Math.round(padded.left * scaleX),
                                    Math.round(padded.top * scaleY),
                                    Math.round(padded.right * scaleX),
                                    Math.round(padded.bottom * scaleY)),
                            input.width(),
                            input.height());
            return new DetectionResult(
                    mapped,
                    DetectionResult.Confidence.MEDIUM,
                    id(),
                    accepted.size(),
                    1,
                    elapsed,
                    null,
                    null);
        } finally {
            for (MatOfPoint region : regions) {
                region.release();
            }
            boundingBoxes.release();
            mser.clear();
            analysis.release();
        }
    }

    /** Returns {@code mser_only}. */
    @Override
    public String id() {
        return TextCropModel.MSER_ONLY.id();
    }

    private boolean accept(Rect rect, double regionArea, int analysisWidth, int analysisHeight) {
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }
        float widthFraction = rect.width / (float) analysisWidth;
        float heightFraction = rect.height / (float) analysisHeight;
        float aspect = rect.width / (float) rect.height;
        float fill = (float) (regionArea / Math.max(1.0, rect.area()));
        return widthFraction >= config.minWidthFraction
                && widthFraction <= config.maxWidthFraction
                && heightFraction >= config.minHeightFraction
                && heightFraction <= config.maxHeightFraction
                && aspect >= config.minAspectRatio
                && aspect <= config.maxAspectRatio
                && fill >= config.minFillRatio
                && fill <= config.maxFillRatio;
    }

    private static boolean touchesBoundary(CropRect crop, int width, int height) {
        int margin = 2;
        return crop.left <= margin
                || crop.top <= margin
                || crop.right >= width - margin
                || crop.bottom >= height - margin;
    }
}
