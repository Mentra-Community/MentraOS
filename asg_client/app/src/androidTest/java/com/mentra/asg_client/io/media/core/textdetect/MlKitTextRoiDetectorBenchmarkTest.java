package com.mentra.asg_client.io.media.core.textdetect;

import static org.junit.Assert.assertNotNull;

import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.nio.file.Files;

/** Manual MT8766 benchmark. Push a sensor JPEG to /sdcard/Download/mlkit-benchmark.jpg first. */
@RunWith(AndroidJUnit4.class)
public class MlKitTextRoiDetectorBenchmarkTest {
    private static final String TAG = "MLKIT_BENCH";

    @Test
    public void benchmarkAnalysisSizes() throws Exception {
        File input = new File("/sdcard/Download/mlkit-benchmark.jpg");
        byte[] jpeg = Files.readAllBytes(input.toPath());
        assertNotNull(jpeg);

        for (int longEdge : new int[] {480, 640, 800, 960, 1280}) {
            try (MlKitTextRoiDetector detector =
                    new MlKitTextRoiDetector(
                            InstrumentationRegistry.getInstrumentation().getTargetContext(),
                            longEdge)) {
                detector.warmUp();
                for (int run = 1; run <= 3; run++) {
                    MlKitTextRoiDetector.Detection result = detector.detect(jpeg);
                    Log.i(
                            TAG,
                            "edge="
                                    + longEdge
                                    + " run="
                                    + run
                                    + " elapsedMs="
                                    + result.elapsedMs
                                    + " lines="
                                    + result.lineCount
                                    + " reason="
                                    + result.reason
                                    + " analysis="
                                    + result.analysisWidth
                                    + "x"
                                    + result.analysisHeight
                                    + " roi="
                                    + (result.roi != null ? result.roi.toShortString() : "full"));
                }
            }
        }
    }
}
