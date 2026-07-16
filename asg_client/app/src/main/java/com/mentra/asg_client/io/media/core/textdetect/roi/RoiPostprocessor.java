package com.mentra.asg_client.io.media.core.textdetect.roi;

import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import java.util.ArrayList;
import java.util.List;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfPoint;
import org.opencv.core.Rect;
import org.opencv.imgproc.Imgproc;

/** Shared geometry and probability-map postprocessing for neural ROI detectors. */
public final class RoiPostprocessor {
    private RoiPostprocessor() {}

    /**
     * Converts a segmentation probability map into one padded union crop.
     *
     * @param probabilityMap row-major probabilities
     * @param inputWidth original image width
     * @param inputHeight original image height
     * @param threshold segmentation threshold
     * @param minimumScore minimum mean probability inside a candidate box
     * @param expansion box expansion factor before union
     * @param detectorId detector identifier recorded as the selected strategy
     * @param elapsedMs inference and postprocessing time
     * @return detected union crop or the standard center fallback
     */
    public static DetectionResult postprocessProbabilityMap(
            float[][] probabilityMap,
            int inputWidth,
            int inputHeight,
            float threshold,
            float minimumScore,
            float expansion,
            String detectorId,
            long elapsedMs) {
        if (probabilityMap == null
                || probabilityMap.length == 0
                || probabilityMap[0] == null
                || probabilityMap[0].length == 0) {
            return fallback(inputWidth, inputHeight, detectorId, elapsedMs, "empty_probability_map");
        }
        CvInit.ensureLoaded();
        int mapHeight = probabilityMap.length;
        int mapWidth = probabilityMap[0].length;
        Mat mask = new Mat(mapHeight, mapWidth, CvType.CV_8UC1);
        byte[] bytes = new byte[mapWidth * mapHeight];
        for (int y = 0; y < mapHeight; y++) {
            if (probabilityMap[y] == null || probabilityMap[y].length != mapWidth) {
                mask.release();
                return fallback(
                        inputWidth, inputHeight, detectorId, elapsedMs, "ragged_probability_map");
            }
            for (int x = 0; x < mapWidth; x++) {
                bytes[y * mapWidth + x] =
                        probabilityMap[y][x] >= threshold ? (byte) 255 : (byte) 0;
            }
        }
        mask.put(0, 0, bytes);

        List<MatOfPoint> contours = new ArrayList<>();
        Mat hierarchy = new Mat();
        Imgproc.findContours(
                mask, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE);
        List<CropRect> boxes = new ArrayList<>();
        for (MatOfPoint contour : contours) {
            Rect rect = Imgproc.boundingRect(contour);
            if (rect.width >= 3
                    && rect.height >= 3
                    && mean(probabilityMap, rect) >= minimumScore) {
                boxes.add(expand(rect, expansion, mapWidth, mapHeight));
            }
            contour.release();
        }
        hierarchy.release();
        mask.release();
        return resultFromBoxes(
                boxes,
                mapWidth,
                mapHeight,
                inputWidth,
                inputHeight,
                detectorId,
                elapsedMs,
                "no_text_boxes");
    }

    static DetectionResult resultFromBoxes(
            List<CropRect> boxes,
            int coordinateWidth,
            int coordinateHeight,
            int inputWidth,
            int inputHeight,
            String detectorId,
            long elapsedMs,
            String emptyReason) {
        if (boxes == null || boxes.isEmpty()) {
            return fallback(inputWidth, inputHeight, detectorId, elapsedMs, emptyReason);
        }
        CropRect union = boxes.get(0);
        for (int i = 1; i < boxes.size(); i++) {
            union = CropRect.union(union, boxes.get(i));
        }
        int horizontalPadding = Math.max(1, Math.round(union.width() * 0.05f));
        int verticalPadding = Math.max(1, Math.round(union.height() * 0.05f));
        CropRect padded =
                new CropRect(
                        union.left - horizontalPadding,
                        union.top - verticalPadding,
                        union.right + horizontalPadding,
                        union.bottom + verticalPadding);
        float scaleX = inputWidth / (float) coordinateWidth;
        float scaleY = inputHeight / (float) coordinateHeight;
        CropRect mapped =
                CropRect.clamp(
                        new CropRect(
                                Math.round(padded.left * scaleX),
                                Math.round(padded.top * scaleY),
                                Math.round(padded.right * scaleX),
                                Math.round(padded.bottom * scaleY)),
                        inputWidth,
                        inputHeight);
        return new DetectionResult(
                mapped,
                DetectionResult.Confidence.MEDIUM,
                detectorId,
                boxes.size(),
                boxes.isEmpty() ? 0 : 1,
                elapsedMs,
                null,
                null);
    }

    static DetectionResult fallback(
            int width, int height, String detectorId, long elapsedMs, String reason) {
        int cropWidth = Math.max(1, Math.round(width * 0.75f));
        int cropHeight = Math.max(1, Math.round(height * 0.75f));
        int left = (width - cropWidth) / 2;
        int top = (height - cropHeight) / 2;
        return new DetectionResult(
                new CropRect(left, top, left + cropWidth, top + cropHeight),
                DetectionResult.Confidence.LOW,
                detectorId,
                0,
                0,
                elapsedMs,
                reason,
                null);
    }

    private static float mean(float[][] map, Rect rect) {
        double total = 0;
        int count = 0;
        for (int y = rect.y; y < rect.y + rect.height; y++) {
            for (int x = rect.x; x < rect.x + rect.width; x++) {
                total += map[y][x];
                count++;
            }
        }
        return count == 0 ? 0 : (float) (total / count);
    }

    private static CropRect expand(
            Rect rect, float expansion, int mapWidth, int mapHeight) {
        float extraX = rect.width * Math.max(0, expansion - 1f) * 0.5f;
        float extraY = rect.height * Math.max(0, expansion - 1f) * 0.5f;
        return CropRect.clamp(
                new CropRect(
                        Math.round(rect.x - extraX),
                        Math.round(rect.y - extraY),
                        Math.round(rect.x + rect.width + extraX),
                        Math.round(rect.y + rect.height + extraY)),
                mapWidth,
                mapHeight);
    }
}
