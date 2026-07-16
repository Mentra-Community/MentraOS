package com.mentra.asg_client.camera.textdetect;

import static org.junit.Assume.assumeTrue;

import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.roi.DetectionInput;
import com.mentra.asg_client.io.media.core.textdetect.roi.FileSystemModelSource;
import com.mentra.asg_client.io.media.core.textdetect.roi.TextCropModel;
import com.mentra.asg_client.io.media.core.textdetect.roi.TextRoiDetector;
import com.mentra.asg_client.io.media.core.textdetect.roi.TextRoiDetectorFactory;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.JUnit4;
import org.opencv.core.Mat;
import org.opencv.core.MatOfByte;
import org.opencv.core.MatOfInt;
import org.opencv.core.Point;
import org.opencv.core.Rect;
import org.opencv.core.Scalar;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Manual offline benchmark for comparing classical and ONNX text ROI detectors.
 *
 * <p>Run from {@code asg_client} with, for example:
 *
 * <pre>
 * ./gradlew :app:testDebugUnitTest \
 *   --tests "*TextRoiBenchmarkHarnessTest" \
 *   -Dtextroi.inputDir=/path/to/images \
 *   -Dtextroi.modelDir=/path/to/models \
 *   -Dtextroi.detectors=classical,ppocr_v5_mobile_det
 * </pre>
 */
@RunWith(JUnit4.class)
public class TextRoiBenchmarkHarnessTest {
    private static final String INPUT_DIR_PROPERTY = "textroi.inputDir";
    private static final String OUTPUT_DIR_PROPERTY = "textroi.outputDir";
    private static final String MODEL_DIR_PROPERTY = "textroi.modelDir";
    private static final String DETECTORS_PROPERTY = "textroi.detectors";
    private static final String BLE_RATE_PROPERTY = "textroi.bleBytesPerSecond";
    private static final double DEFAULT_BLE_BYTES_PER_SECOND = 87040.0;
    private static final int JPEG_QUALITY = 80;

    /** Loads desktop OpenCV before the benchmark can run. */
    @BeforeClass
    public static void loadOpenCv() {
        CvInit.ensureLoaded();
    }

    /** Runs the benchmark when {@code textroi.inputDir} is explicitly configured. */
    @Test
    public void benchmarkConfiguredImages() throws Exception {
        String inputValue = System.getProperty(INPUT_DIR_PROPERTY);
        assumeTrue(
                "Set -D" + INPUT_DIR_PROPERTY + " to a directory of JPEG/PNG images",
                inputValue != null && !inputValue.trim().isEmpty());

        Path inputDirectory = Paths.get(inputValue).toAbsolutePath().normalize();
        assumeTrue(
                "Input directory does not exist: " + inputDirectory,
                Files.isDirectory(inputDirectory));
        List<Path> images = listImages(inputDirectory);
        assumeTrue("No JPEG/PNG images found in " + inputDirectory, !images.isEmpty());

        Path outputDirectory = resolveOutputDirectory(inputDirectory);
        Path modelDirectory = resolveModelDirectory(inputDirectory);
        double bleBytesPerSecond = parseBleRate();
        List<TextCropModel> requestedModels = parseRequestedModels();
        Files.createDirectories(outputDirectory);
        Files.createDirectories(outputDirectory.resolve("_originals"));

        TextDetectConfig config = productionEquivalentConfig();
        FileSystemModelSource modelSource = new FileSystemModelSource(modelDirectory);
        Map<TextCropModel, TextRoiDetector> detectors = new LinkedHashMap<>();
        List<BenchmarkResult> results = new ArrayList<>();
        try {
            for (TextCropModel model : requestedModels) {
                detectors.put(model, TextRoiDetectorFactory.create(model, config, modelSource));
            }
            for (Path image : images) {
                boolean saveOriginal = true;
                for (Map.Entry<TextCropModel, TextRoiDetector> entry : detectors.entrySet()) {
                    BenchmarkResult result =
                            benchmarkImage(
                                    image,
                                    outputDirectory,
                                    entry.getKey(),
                                    entry.getValue(),
                                    bleBytesPerSecond,
                                    saveOriginal);
                    results.add(result);
                    saveOriginal = false;
                }
            }
            writeSummaries(outputDirectory, requestedModels, results);
            writeIndex(outputDirectory, images, requestedModels, results);
        } finally {
            for (TextRoiDetector detector : detectors.values()) {
                detector.close();
            }
        }
    }

    private static BenchmarkResult benchmarkImage(
            Path image,
            Path outputDirectory,
            TextCropModel requested,
            TextRoiDetector detector,
            double bleBytesPerSecond,
            boolean saveOriginal)
            throws Exception {
        Mat color = null;
        Mat crop = null;
        Mat overlay = null;
        try {
            color = Imgcodecs.imread(image.toString(), Imgcodecs.IMREAD_COLOR);
            if (color.empty()) {
                throw new IOException("Failed to decode image: " + image);
            }
            int width = color.cols();
            int height = color.rows();
            DetectionInput input = new DetectionInput(toLuma(color), width, height);

            if (requested.assetFilename() != null && detector.id().equals(requested.id())) {
                DetectionResult warmup = detector.detect(input);
                releaseDebug(warmup);
            }

            long startNanos = System.nanoTime();
            DetectionResult detection = detector.detect(input);
            double detectionMs = (System.nanoTime() - startNanos) / 1_000_000.0;
            try {
                CropRect roi = CropRect.clamp(detection.roi, width, height);
                crop = color.submat(new Rect(roi.left, roi.top, roi.width(), roi.height()));
                overlay = color.clone();
                Imgproc.rectangle(
                        overlay,
                        new Point(roi.left, roi.top),
                        new Point(roi.right - 1, roi.bottom - 1),
                        new Scalar(0, 0, 255),
                        Math.max(2, Math.round(Math.min(width, height) / 300f)));

                byte[] fullJpeg = encodeJpeg(color);
                byte[] cropJpeg = encodeJpeg(crop);
                byte[] overlayJpeg = encodeJpeg(overlay);
                String stem = stem(image.getFileName().toString());
                Path resultDirectory = outputDirectory.resolve(requested.id()).resolve(stem);
                Files.createDirectories(resultDirectory);
                Files.write(resultDirectory.resolve("crop.jpg"), cropJpeg);
                Files.write(resultDirectory.resolve("overlay.jpg"), overlayJpeg);
                if (saveOriginal) {
                    Files.write(
                            outputDirectory.resolve("_originals").resolve(stem + ".jpg"), fullJpeg);
                }

                BenchmarkResult result =
                        BenchmarkResult.create(
                                image.getFileName().toString(),
                                stem,
                                requested,
                                detector.id(),
                                detection,
                                roi,
                                width,
                                height,
                                detectionMs,
                                fullJpeg.length,
                                cropJpeg.length,
                                bleBytesPerSecond);
                writeUtf8(resultDirectory.resolve("result.json"), result.toJson().toString(2));
                return result;
            } finally {
                releaseDebug(detection);
            }
        } finally {
            if (overlay != null) {
                overlay.release();
            }
            if (crop != null) {
                crop.release();
            }
            if (color != null) {
                color.release();
            }
        }
    }

    private static List<Path> listImages(Path inputDirectory) throws IOException {
        try (Stream<Path> files = Files.list(inputDirectory)) {
            return files.filter(Files::isRegularFile)
                    .filter(TextRoiBenchmarkHarnessTest::isImage)
                    .sorted(
                            Comparator.comparing(
                                            (Path path) ->
                                                    path.getFileName()
                                                            .toString()
                                                            .toLowerCase(Locale.US))
                                    .thenComparing(path -> path.getFileName().toString()))
                    .collect(Collectors.toList());
        }
    }

    private static boolean isImage(Path path) {
        String name = path.getFileName().toString().toLowerCase(Locale.US);
        return name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png");
    }

    private static List<TextCropModel> parseRequestedModels() {
        String configured = System.getProperty(DETECTORS_PROPERTY, TextCropModel.CLASSICAL.id());
        Map<String, TextCropModel> modelsByName = new LinkedHashMap<>();
        for (TextCropModel model : TextCropModel.values()) {
            modelsByName.put(model.id(), model);
            modelsByName.put(model.name().toLowerCase(Locale.US), model);
        }
        LinkedHashMap<TextCropModel, Boolean> selected = new LinkedHashMap<>();
        for (String token : configured.split(",")) {
            String key = token.trim().toLowerCase(Locale.US);
            if (key.isEmpty()) {
                continue;
            }
            TextCropModel model = modelsByName.get(key);
            if (model == null) {
                throw new IllegalArgumentException(
                        "Unknown textroi detector '"
                                + token.trim()
                                + "'. Valid ids: "
                                + modelsByName.keySet());
            }
            selected.put(model, Boolean.TRUE);
        }
        if (selected.isEmpty()) {
            throw new IllegalArgumentException(
                    "textroi.detectors must select at least one detector");
        }
        return new ArrayList<>(selected.keySet());
    }

    private static TextDetectConfig productionEquivalentConfig() {
        return TextDetectConfig.defaults().toBuilder()
                .allowSingleComponentLines(true)
                .cropFromTopLineOnly(true)
                .enableStructureFilter(true)
                .improvedCropAccuracy(true)
                .minCropAreaFraction(0.004f)
                .build();
    }

    private static Path resolveOutputDirectory(Path inputDirectory) {
        String configured = System.getProperty(OUTPUT_DIR_PROPERTY);
        return configured == null || configured.trim().isEmpty()
                ? inputDirectory.resolve("_textroi_benchmark_output")
                : Paths.get(configured).toAbsolutePath().normalize();
    }

    private static Path resolveModelDirectory(Path inputDirectory) {
        String configured = System.getProperty(MODEL_DIR_PROPERTY);
        return configured == null || configured.trim().isEmpty()
                ? inputDirectory
                : Paths.get(configured).toAbsolutePath().normalize();
    }

    private static double parseBleRate() {
        double value =
                Double.parseDouble(
                        System.getProperty(
                                BLE_RATE_PROPERTY, Double.toString(DEFAULT_BLE_BYTES_PER_SECOND)));
        if (!Double.isFinite(value) || value <= 0) {
            throw new IllegalArgumentException(BLE_RATE_PROPERTY + " must be positive");
        }
        return value;
    }

    private static byte[] toLuma(Mat color) {
        Mat gray = new Mat();
        try {
            Imgproc.cvtColor(color, gray, Imgproc.COLOR_BGR2GRAY);
            byte[] luma = new byte[(int) gray.total()];
            gray.get(0, 0, luma);
            return luma;
        } finally {
            gray.release();
        }
    }

    private static byte[] encodeJpeg(Mat image) throws IOException {
        MatOfByte encoded = new MatOfByte();
        MatOfInt parameters = new MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, JPEG_QUALITY);
        try {
            if (!Imgcodecs.imencode(".jpg", image, encoded, parameters)) {
                throw new IOException("OpenCV failed to encode JPEG");
            }
            return encoded.toArray();
        } finally {
            parameters.release();
            encoded.release();
        }
    }

    private static void releaseDebug(DetectionResult result) {
        if (result != null && result.debug != null) {
            result.debug.release();
        }
    }

    private static void writeSummaries(
            Path outputDirectory,
            List<TextCropModel> requestedModels,
            List<BenchmarkResult> results)
            throws IOException {
        JSONArray summaries = new JSONArray();
        StringBuilder csv =
                new StringBuilder(
                        "requested_id,detector_id,count,mean_detection_ms,p50_detection_ms,"
                                + "p95_detection_ms,mean_byte_savings_percent,fallback_rate\n");
        for (TextCropModel model : requestedModels) {
            List<BenchmarkResult> detectorResults =
                    results.stream()
                            .filter(result -> result.requested == model)
                            .collect(Collectors.toList());
            DetectorSummary summary = DetectorSummary.create(model, detectorResults);
            summaries.put(summary.toJson());
            csv.append(csv(summary.requestedId))
                    .append(',')
                    .append(csv(summary.detectorId))
                    .append(',')
                    .append(summary.count)
                    .append(',')
                    .append(format(summary.meanDetectionMs))
                    .append(',')
                    .append(format(summary.p50DetectionMs))
                    .append(',')
                    .append(format(summary.p95DetectionMs))
                    .append(',')
                    .append(format(summary.meanByteSavingsPercent))
                    .append(',')
                    .append(format(summary.fallbackRate))
                    .append('\n');
        }
        writeUtf8(outputDirectory.resolve("summary.csv"), csv.toString());
        writeUtf8(
                outputDirectory.resolve("summary.json"),
                new JSONObject().put("detectors", summaries).toString(2));
    }

    private static void writeIndex(
            Path outputDirectory,
            List<Path> images,
            List<TextCropModel> requestedModels,
            List<BenchmarkResult> results)
            throws IOException {
        Map<String, Map<TextCropModel, BenchmarkResult>> byImage = new LinkedHashMap<>();
        for (BenchmarkResult result : results) {
            byImage.computeIfAbsent(result.image, ignored -> new LinkedHashMap<>())
                    .put(result.requested, result);
        }
        StringBuilder html =
                new StringBuilder(
                        "<!doctype html><html><head><meta charset=\"utf-8\">"
                                + "<title>Text ROI benchmark</title><style>"
                                + "body{font:14px sans-serif;margin:24px;color:#222}"
                                + "table{border-collapse:collapse;width:100%;margin-bottom:32px}"
                                + "th,td{border:1px solid #bbb;padding:8px;vertical-align:top}"
                                + "th{background:#eee}img{max-width:320px;max-height:240px;"
                                + "display:block;margin:0 0 8px}.metrics{white-space:pre-line}"
                                + "</style></head><body><h1>Text ROI benchmark</h1>");
        for (Path image : images) {
            String imageName = image.getFileName().toString();
            String imageStem = stem(imageName);
            html.append("<h2>")
                    .append(html(imageName))
                    .append("</h2><table><thead><tr>")
                    .append("<th>Original</th>");
            for (TextCropModel model : requestedModels) {
                html.append("<th>").append(html(model.id())).append("</th>");
            }
            html.append("</tr></thead><tbody><tr><td><img src=\"")
                    .append(html("_originals/" + imageStem + ".jpg"))
                    .append("\" alt=\"Original\"></td>");
            for (TextCropModel model : requestedModels) {
                BenchmarkResult result = byImage.get(imageName).get(model);
                String base = model.id() + "/" + imageStem + "/";
                html.append("<td><img src=\"")
                        .append(html(base + "crop.jpg"))
                        .append("\" alt=\"Crop\"><img src=\"")
                        .append(html(base + "overlay.jpg"))
                        .append("\" alt=\"Overlay\"><div class=\"metrics\">")
                        .append(html(result.metricsText()))
                        .append("</div></td>");
            }
            html.append("</tr></tbody></table>");
        }
        html.append("</body></html>");
        writeUtf8(outputDirectory.resolve("index.html"), html.toString());
    }

    private static void writeUtf8(Path path, String value) throws IOException {
        Files.write(path, value.getBytes(StandardCharsets.UTF_8));
    }

    private static String stem(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot > 0 ? filename.substring(0, dot) : filename;
    }

    private static String html(String value) {
        return value.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    private static String csv(String value) {
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }

    private static String format(double value) {
        return String.format(Locale.US, "%.3f", value);
    }

    private static double percentile(List<Double> sorted, double percentile) {
        if (sorted.isEmpty()) {
            return 0;
        }
        int index = Math.max(0, (int) Math.ceil(percentile * sorted.size()) - 1);
        return sorted.get(Math.min(index, sorted.size() - 1));
    }

    private static final class BenchmarkResult {
        final String image;
        final String stem;
        final TextCropModel requested;
        final String detectorId;
        final double detectionMs;
        final CropRect roi;
        final DetectionResult.Confidence confidence;
        final String fallbackReason;
        final boolean fallback;
        final double pixelFraction;
        final double pixelReductionPercent;
        final int fullBytes;
        final int cropBytes;
        final int bytesSaved;
        final double bytesSavedPercent;
        final double estimatedBleSecondsSaved;

        private BenchmarkResult(
                String image,
                String stem,
                TextCropModel requested,
                String detectorId,
                double detectionMs,
                CropRect roi,
                DetectionResult.Confidence confidence,
                String fallbackReason,
                boolean fallback,
                double pixelFraction,
                double pixelReductionPercent,
                int fullBytes,
                int cropBytes,
                int bytesSaved,
                double bytesSavedPercent,
                double estimatedBleSecondsSaved) {
            this.image = image;
            this.stem = stem;
            this.requested = requested;
            this.detectorId = detectorId;
            this.detectionMs = detectionMs;
            this.roi = roi;
            this.confidence = confidence;
            this.fallbackReason = fallbackReason;
            this.fallback = fallback;
            this.pixelFraction = pixelFraction;
            this.pixelReductionPercent = pixelReductionPercent;
            this.fullBytes = fullBytes;
            this.cropBytes = cropBytes;
            this.bytesSaved = bytesSaved;
            this.bytesSavedPercent = bytesSavedPercent;
            this.estimatedBleSecondsSaved = estimatedBleSecondsSaved;
        }

        static BenchmarkResult create(
                String image,
                String stem,
                TextCropModel requested,
                String detectorId,
                DetectionResult detection,
                CropRect roi,
                int width,
                int height,
                double detectionMs,
                int fullBytes,
                int cropBytes,
                double bleBytesPerSecond) {
            long fullPixels = (long) width * height;
            double pixelFraction = roi.pixelCount() / (double) fullPixels;
            int bytesSaved = fullBytes - cropBytes;
            double bytesSavedPercent = bytesSaved * 100.0 / fullBytes;
            boolean fallback = detectorId.contains("->") || detection.fallbackReason != null;
            return new BenchmarkResult(
                    image,
                    stem,
                    requested,
                    detectorId,
                    detectionMs,
                    roi,
                    detection.confidence,
                    detection.fallbackReason,
                    fallback,
                    pixelFraction,
                    (1.0 - pixelFraction) * 100.0,
                    fullBytes,
                    cropBytes,
                    bytesSaved,
                    bytesSavedPercent,
                    bytesSaved / bleBytesPerSecond);
        }

        JSONObject toJson() {
            return new JSONObject()
                    .put("image", image)
                    .put("requested_enum", requested.name())
                    .put("requested_id", requested.id())
                    .put("detector_id", detectorId)
                    .put("detection_ms", detectionMs)
                    .put("roi", new JSONArray(roi.toArray()))
                    .put("confidence", confidence.name())
                    .put("fallback", fallback)
                    .put(
                            "fallback_reason",
                            fallbackReason == null ? JSONObject.NULL : fallbackReason)
                    .put("pixel_fraction", pixelFraction)
                    .put("pixel_reduction_percent", pixelReductionPercent)
                    .put("full_bytes", fullBytes)
                    .put("crop_bytes", cropBytes)
                    .put("bytes_saved", bytesSaved)
                    .put("bytes_saved_percent", bytesSavedPercent)
                    .put("estimated_ble_seconds_saved", estimatedBleSecondsSaved);
        }

        String metricsText() {
            return "detector: "
                    + detectorId
                    + "\ndetection: "
                    + format(detectionMs)
                    + " ms\nROI: "
                    + java.util.Arrays.toString(roi.toArray())
                    + "\nconfidence: "
                    + confidence
                    + "\nfallback: "
                    + fallback
                    + (fallbackReason == null ? "" : " (" + fallbackReason + ")")
                    + "\npixels reduced: "
                    + format(pixelReductionPercent)
                    + "%\nbytes: "
                    + cropBytes
                    + " / "
                    + fullBytes
                    + "\nbytes saved: "
                    + bytesSaved
                    + " ("
                    + format(bytesSavedPercent)
                    + "%)\nBLE time saved: "
                    + format(estimatedBleSecondsSaved)
                    + " s";
        }
    }

    private static final class DetectorSummary {
        final String requestedId;
        final String detectorId;
        final int count;
        final double meanDetectionMs;
        final double p50DetectionMs;
        final double p95DetectionMs;
        final double meanByteSavingsPercent;
        final double fallbackRate;

        private DetectorSummary(
                String requestedId,
                String detectorId,
                int count,
                double meanDetectionMs,
                double p50DetectionMs,
                double p95DetectionMs,
                double meanByteSavingsPercent,
                double fallbackRate) {
            this.requestedId = requestedId;
            this.detectorId = detectorId;
            this.count = count;
            this.meanDetectionMs = meanDetectionMs;
            this.p50DetectionMs = p50DetectionMs;
            this.p95DetectionMs = p95DetectionMs;
            this.meanByteSavingsPercent = meanByteSavingsPercent;
            this.fallbackRate = fallbackRate;
        }

        static DetectorSummary create(TextCropModel requested, List<BenchmarkResult> results) {
            List<Double> times =
                    results.stream()
                            .map(result -> result.detectionMs)
                            .sorted()
                            .collect(Collectors.toList());
            double meanTime =
                    results.stream().mapToDouble(result -> result.detectionMs).average().orElse(0);
            double meanSavings =
                    results.stream()
                            .mapToDouble(result -> result.bytesSavedPercent)
                            .average()
                            .orElse(0);
            double fallbackRate =
                    results.stream().filter(result -> result.fallback).count()
                            / (double) Math.max(1, results.size());
            String detectorId = results.isEmpty() ? requested.id() : results.get(0).detectorId;
            return new DetectorSummary(
                    requested.id(),
                    detectorId,
                    results.size(),
                    meanTime,
                    percentile(times, 0.50),
                    percentile(times, 0.95),
                    meanSavings,
                    fallbackRate);
        }

        JSONObject toJson() {
            return new JSONObject()
                    .put("requested_id", requestedId)
                    .put("detector_id", detectorId)
                    .put("count", count)
                    .put("mean_detection_ms", meanDetectionMs)
                    .put("p50_detection_ms", p50DetectionMs)
                    .put("p95_detection_ms", p95DetectionMs)
                    .put("mean_byte_savings_percent", meanByteSavingsPercent)
                    .put("fallback_rate", fallbackRate);
        }
    }
}
