package com.mentra.asg_client.camera.textdetect;

import static org.junit.Assume.assumeTrue;

import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.TextRegionDetector;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.JUnit4;
import org.opencv.core.Mat;
import org.opencv.core.Rect;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;

/**
 * Offline harness for tuning the classical text-region detector against real Mentra captures.
 *
 * <p>Run manually:
 *
 * <pre>
 * cd asg_client
 * ./gradlew :app:testDebugUnitTest \
 *   -Dtest.single=TextRegionDetectorHarnessTest \
 *   -Dtextdetect.inputDir=/path/to/images \
 *   -Dtextdetect.outputDir=/path/to/output
 * </pre>
 */
@RunWith(JUnit4.class)
public class TextRegionDetectorHarnessTest {
    private static final String INPUT_DIR_PROP = "textdetect.inputDir";
    private static final String OUTPUT_DIR_PROP = "textdetect.outputDir";

    @BeforeClass
    public static void loadOpenCv() {
        CvInit.ensureLoaded();
    }

    @Test
    public void runHarnessOnInputDirectory() throws Exception {
        String inputDirPath = System.getProperty(INPUT_DIR_PROP);
        assumeTrue(
                "Set -D" + INPUT_DIR_PROP + " to a folder of JPEG/PNG test images",
                inputDirPath != null && !inputDirPath.isEmpty());

        File inputDir = new File(inputDirPath);
        assumeTrue("Input dir does not exist: " + inputDirPath, inputDir.isDirectory());

        File outputDir = resolveOutputDir(inputDir);
        Files.createDirectories(outputDir.toPath());

        File[] images =
                inputDir.listFiles(
                        (dir, name) -> {
                            String lower = name.toLowerCase(Locale.US);
                            return lower.endsWith(".jpg")
                                    || lower.endsWith(".jpeg")
                                    || lower.endsWith(".png");
                        });
        assumeTrue("No images found in " + inputDirPath, images != null && images.length > 0);

        TextDetectConfig baselineConfig =
                TextDetectConfig.defaults().toBuilder().debugCaptureIntermediates(true).build();
        TextDetectConfig tunedConfig =
                TextDetectConfig.defaults()
                        .toBuilder()
                        .debugCaptureIntermediates(true)
                        .cropFromTopLineOnly(true)
                        .strictComponentFilters(true)
                        .enableStructureFilter(true)
                        .enableStrokeWidthFilter(true)
                        .enableBlobSplitting(true)
                        .enableMser(true)
                        .minCropAreaFraction(0.004f)
                        .build();

        runBatch(images, new File(outputDir, "baseline"), baselineConfig, "results_baseline.json");
        runBatch(images, new File(outputDir, "tuned"), tunedConfig, "results_tuned.json");
    }

    private static void runBatch(
            File[] images, File batchOutputDir, TextDetectConfig config, String resultsFileName)
            throws Exception {
        Files.createDirectories(batchOutputDir.toPath());
        JSONArray allResults = new JSONArray();
        for (File imageFile : images) {
            JSONObject entry = processImage(imageFile, batchOutputDir, config);
            allResults.put(entry);
        }
        writeJson(
                new File(batchOutputDir, resultsFileName), new JSONObject().put("images", allResults));
    }

    private static JSONObject processImage(File imageFile, File outputDir, TextDetectConfig config)
            throws Exception {
        Mat color = Imgcodecs.imread(imageFile.getAbsolutePath(), Imgcodecs.IMREAD_COLOR);
        if (color.empty()) {
            throw new IOException("Failed to decode image: " + imageFile);
        }

        int width = color.cols();
        int height = color.rows();
        byte[] luma = toLuma(color, width, height);

        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        String stem = stripExtension(imageFile.getName());
        File imageOutDir = new File(outputDir, stem);
        Files.createDirectories(imageOutDir.toPath());

        Imgcodecs.imwrite(new File(imageOutDir, "01_original.jpg").getAbsolutePath(), color);

        if (result.debug != null) {
            saveMat(result.debug.thresholdDark, new File(imageOutDir, "02_threshold_dark.png"));
            saveMat(result.debug.thresholdLight, new File(imageOutDir, "03_threshold_light.png"));
            saveMat(result.debug.componentsOverlay, new File(imageOutDir, "04_components.png"));
            saveMat(result.debug.linesOverlay, new File(imageOutDir, "05_lines.png"));
            saveMat(result.debug.cropOverlay, new File(imageOutDir, "06_crop_overlay.jpg"));
            result.debug.release();
        }

        if (result.roi != null) {
            saveColorCrop(color, result.roi, new File(imageOutDir, "07_crop.jpg"));
        }
        color.release();

        int originalPixels = width * height;
        int croppedPixels = result.roi != null ? result.roi.pixelCount() : originalPixels;
        double reduction =
                originalPixels == 0
                        ? 0.0
                        : (1.0 - (croppedPixels / (double) originalPixels)) * 100.0;

        JSONObject json = new JSONObject();
        json.put("image", imageFile.getName());
        json.put("selected_polarity", result.selectedPolarity);
        json.put("confidence", result.confidence.name());
        json.put("fallback_reason", result.fallbackReason);
        json.put("detection_time_ms", result.detectionTimeMs);
        json.put("accepted_component_count", result.acceptedComponentCount);
        json.put("line_count", result.lineCount);
        if (result.roi != null) {
            JSONArray crop = new JSONArray();
            for (int v : result.roi.toArray()) {
                crop.put(v);
            }
            json.put("crop", crop);
        }
        json.put("original_pixels", originalPixels);
        json.put("cropped_pixels", croppedPixels);
        json.put("pixel_reduction_percent", round1(reduction));

        File requiredFile = new File(imageFile.getParentFile(), stem + ".required.json");
        if (requiredFile.exists()) {
            JSONObject requiredJson =
                    new JSONObject(
                            new String(
                                    Files.readAllBytes(requiredFile.toPath()),
                                    StandardCharsets.UTF_8));
            JSONArray requiredBox = requiredJson.getJSONArray("required_box");
            CropRect required =
                    new CropRect(
                            requiredBox.getInt(0),
                            requiredBox.getInt(1),
                            requiredBox.getInt(0) + requiredBox.getInt(2),
                            requiredBox.getInt(1) + requiredBox.getInt(3));
            boolean retained = result.roi != null && result.roi.contains(required);
            json.put("all_required_text_retained", retained);
        }

        writeJson(new File(imageOutDir, "result.json"), json);
        return json;
    }

    private static File resolveOutputDir(File inputDir) {
        String outputDirPath = System.getProperty(OUTPUT_DIR_PROP);
        if (outputDirPath != null && !outputDirPath.isEmpty()) {
            return new File(outputDirPath);
        }
        return new File(inputDir, "_textdetect_harness_output");
    }

    private static byte[] toLuma(Mat color, int width, int height) {
        Mat gray = new Mat();
        Imgproc.cvtColor(color, gray, Imgproc.COLOR_BGR2GRAY);
        byte[] luma = new byte[width * height];
        gray.get(0, 0, luma);
        gray.release();
        return luma;
    }

    private static void saveMat(Mat mat, File outFile) {
        if (mat == null || mat.empty()) {
            return;
        }
        Imgcodecs.imwrite(outFile.getAbsolutePath(), mat);
    }

    private static void saveColorCrop(Mat color, CropRect crop, File outFile) {
        Mat roi =
                color.submat(new Rect(crop.left, crop.top, crop.width(), crop.height()));
        Imgcodecs.imwrite(outFile.getAbsolutePath(), roi);
        roi.release();
    }

    private static void writeJson(File file, JSONObject json) throws Exception {
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(json.toString(2).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }
}
