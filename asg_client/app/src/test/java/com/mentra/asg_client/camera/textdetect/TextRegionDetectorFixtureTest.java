package com.mentra.asg_client.camera.textdetect;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.media.core.textdetect.CvInit;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.TextDetectConfig;
import com.mentra.asg_client.io.media.core.textdetect.TextRegionDetector;
import java.io.IOException;
import java.io.InputStream;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.JUnit4;
import org.opencv.core.Mat;
import org.opencv.core.MatOfByte;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;

/** Fixture-backed regression for windshield VIN text-region detection. */
@RunWith(JUnit4.class)
public class TextRegionDetectorFixtureTest {
    private static final String WINDSHIELD_VIN_FIXTURE = "/textdetect/synthetic_windshield_vin.png";

    @BeforeClass
    public static void loadOpenCv() {
        CvInit.ensureLoaded();
    }

    @Test
    public void windshieldVin_producesSmallerCropThanFullFrame() throws IOException {
        InputStream stream =
                TextRegionDetectorFixtureTest.class.getResourceAsStream(WINDSHIELD_VIN_FIXTURE);
        assertThat(stream).as("committed windshield VIN fixture").isNotNull();
        byte[] encodedBytes;
        try (stream) {
            encodedBytes = stream.readAllBytes();
        }

        MatOfByte encoded = new MatOfByte(encodedBytes);
        Mat bgr = Imgcodecs.imdecode(encoded, Imgcodecs.IMREAD_COLOR);
        encoded.release();
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
