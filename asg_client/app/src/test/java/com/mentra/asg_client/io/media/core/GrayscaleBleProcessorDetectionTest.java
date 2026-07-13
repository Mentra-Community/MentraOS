package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import android.graphics.Bitmap;
import android.graphics.Rect;
import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Unit tests for the detection-input helpers added to {@link GrayscaleBleProcessor} to feed
 * {@code TextRegionDetector}: the subsampled luma decode ({@link
 * GrayscaleBleProcessor#extractDetectionLuma}) and the coordinate scale-up back to source-pixel
 * space ({@link GrayscaleBleProcessor#scaleDetectionRoi}).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class GrayscaleBleProcessorDetectionTest {

    @Rule public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void extractDetectionLuma_downsamplesTowardAnalysisWidth() throws Exception {
        File jpeg = tempFolder.newFile("wide.jpg");
        writeSolidJpeg(jpeg, 640, 480, 200);

        GrayscaleBleProcessor.DetectionLuma result =
                GrayscaleBleProcessor.extractDetectionLuma(jpeg.getAbsolutePath(), 320);

        assertThat(result.sampleSize).isGreaterThanOrEqualTo(1);
        assertThat(result.width).isLessThanOrEqualTo(640);
        assertThat(result.width * result.sampleSize).isEqualTo(640);
        assertThat(result.height * result.sampleSize).isEqualTo(480);
        assertThat(result.luma).hasSize(result.width * result.height);
    }

    @Test
    public void extractDetectionLuma_noSubsampleWhenAlreadySmallerThanAnalysisWidth()
            throws Exception {
        File jpeg = tempFolder.newFile("small.jpg");
        writeSolidJpeg(jpeg, 100, 80, 128);

        GrayscaleBleProcessor.DetectionLuma result =
                GrayscaleBleProcessor.extractDetectionLuma(jpeg.getAbsolutePath(), 640);

        assertThat(result.sampleSize).isEqualTo(1);
        assertThat(result.width).isEqualTo(100);
        assertThat(result.height).isEqualTo(80);
    }

    @Test
    public void extractDetectionLuma_producesPlausibleLumaForSolidGray() throws Exception {
        File jpeg = tempFolder.newFile("gray.jpg");
        // Mid-gray so JPEG quantization noise cannot push the luma value out of a wide tolerance
        // band in either direction.
        writeSolidJpeg(jpeg, 64, 48, 128);

        GrayscaleBleProcessor.DetectionLuma result =
                GrayscaleBleProcessor.extractDetectionLuma(jpeg.getAbsolutePath(), 320);

        for (byte value : result.luma) {
            assertThat(value & 0xFF).isBetween(100, 156);
        }
    }

    @Test
    public void extractDetectionLuma_preservesAspectRatioForPortraitSource() throws Exception {
        File jpeg = tempFolder.newFile("portrait.jpg");
        writeSolidJpeg(jpeg, 480, 640, 90);

        GrayscaleBleProcessor.DetectionLuma result =
                GrayscaleBleProcessor.extractDetectionLuma(jpeg.getAbsolutePath(), 240);

        assertThat(result.width * result.sampleSize).isEqualTo(480);
        assertThat(result.height * result.sampleSize).isEqualTo(640);
        assertThat(result.luma).hasSize(result.width * result.height);
    }

    @Test
    public void scaleDetectionRoi_scalesByActualDecodedToSourceRatio() {
        CropRect roi = new CropRect(10, 20, 100, 200);
        GrayscaleBleProcessor.DetectionLuma input =
                new GrayscaleBleProcessor.DetectionLuma(
                        new byte[160 * 300], 160, 300, 4, 640, 1200);

        Rect scaled = GrayscaleBleProcessor.scaleDetectionRoi(roi, input);

        assertThat(scaled.left).isEqualTo(40);
        assertThat(scaled.top).isEqualTo(80);
        assertThat(scaled.right).isEqualTo(400);
        assertThat(scaled.bottom).isEqualTo(800);
    }

    @Test
    public void scaleDetectionRoi_isIdentityWhenDecodedMatchesSource() {
        CropRect roi = new CropRect(5, 6, 7, 8);
        GrayscaleBleProcessor.DetectionLuma input =
                new GrayscaleBleProcessor.DetectionLuma(new byte[100 * 80], 100, 80, 1, 100, 80);

        Rect scaled = GrayscaleBleProcessor.scaleDetectionRoi(roi, input);

        assertThat(scaled.left).isEqualTo(roi.left);
        assertThat(scaled.top).isEqualTo(roi.top);
        assertThat(scaled.right).isEqualTo(roi.right);
        assertThat(scaled.bottom).isEqualTo(roi.bottom);
    }

    @Test
    public void scaleDetectionRoi_handlesIntegerDivisionRemainderWithoutOvershoot() {
        // 641px source at sampleSize 2 decodes to 320px (integer division): naive
        // decoded * sampleSize mapping would place the right edge at 640, losing the last
        // source column; ratio-based scaling must clamp within the true source bounds.
        GrayscaleBleProcessor.DetectionLuma input =
                new GrayscaleBleProcessor.DetectionLuma(
                        new byte[320 * 240], 320, 240, 2, 641, 481);
        CropRect fullFrame = new CropRect(0, 0, 320, 240);

        Rect scaled = GrayscaleBleProcessor.scaleDetectionRoi(fullFrame, input);

        assertThat(scaled.left).isEqualTo(0);
        assertThat(scaled.top).isEqualTo(0);
        assertThat(scaled.right).isEqualTo(641);
        assertThat(scaled.bottom).isEqualTo(481);
    }

    @Test
    public void extractDetectionLuma_recordsSourceDimensions() throws Exception {
        File jpeg = tempFolder.newFile("dims.jpg");
        writeSolidJpeg(jpeg, 640, 480, 200);

        GrayscaleBleProcessor.DetectionLuma result =
                GrayscaleBleProcessor.extractDetectionLuma(jpeg.getAbsolutePath(), 320);

        assertThat(result.srcWidth).isEqualTo(640);
        assertThat(result.srcHeight).isEqualTo(480);
    }

    private static void writeSolidJpeg(File dest, int width, int height, int grayLevel)
            throws IOException {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        int color = 0xFF000000 | (grayLevel << 16) | (grayLevel << 8) | grayLevel;
        bitmap.eraseColor(color);
        try (FileOutputStream fos = new FileOutputStream(dest)) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 95, fos);
        } finally {
            bitmap.recycle();
        }
    }
}
