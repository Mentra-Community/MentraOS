package com.mentra.asg_client.camera.textdetect;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.TextRegionDetector;
import java.io.File;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.JUnit4;
import org.opencv.core.Mat;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;

/** Fixture-backed regression for windshield VIN text-region detection. */
@RunWith(JUnit4.class)
public class TextRegionDetectorFixtureTest {
    private static final File HONDA_VIN =
            new File("testdata/textdetect/input/honda_windshield_vin_v2.png");

    @BeforeClass
    public static void loadOpenCv() {
        CvInit.ensureLoaded();
    }

    @Test
    public void hondaWindshieldVin_producesSmallerCropThanFullFrame() {
        org.junit.Assume.assumeTrue("Fixture image missing", HONDA_VIN.isFile());

        Mat bgr = Imgcodecs.imread(HONDA_VIN.getAbsolutePath());
        assertThat(bgr.empty()).isFalse();

        Mat gray = new Mat();
        Imgproc.cvtColor(bgr, gray, Imgproc.COLOR_BGR2GRAY);
        int width = gray.cols();
        int height = gray.rows();
        byte[] luma = new byte[width * height];
        gray.get(0, 0, luma);
        gray.release();
        bgr.release();

        TextDetectConfig config = TextDetectConfig.defaults();
        DetectionResult result = TextRegionDetector.detect(luma, width, height, config);

        int fullArea = width * height;
        int cropArea = result.roi.width() * result.roi.height();
        assertThat(cropArea).isLessThan(fullArea);
        assertThat(result.roi.width()).isGreaterThan(0);
        assertThat(result.roi.height()).isGreaterThan(0);
    }
}
