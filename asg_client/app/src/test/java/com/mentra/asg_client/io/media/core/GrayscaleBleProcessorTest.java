package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import java.io.File;
import java.io.FileOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

// Native graphics so BitmapFactory/Canvas produce real pixels (legacy shadows decode to zeros).
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class GrayscaleBleProcessorTest {

    @Rule public TemporaryFolder tempFolder = new TemporaryFolder();

    /** Writes a JPEG with a white background and a black left half, like a stark document edge. */
    private File writeTestJpeg(int width, int height) throws Exception {
        Bitmap source = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(source);
        canvas.drawColor(Color.WHITE);
        Paint black = new Paint();
        black.setColor(Color.BLACK);
        canvas.drawRect(0, 0, width / 2f, height, black);

        File jpeg = tempFolder.newFile("test.jpg");
        try (FileOutputStream fos = new FileOutputStream(jpeg)) {
            source.compress(Bitmap.CompressFormat.JPEG, 92, fos);
        }
        source.recycle();
        return jpeg;
    }

    @Test
    public void processToLumaPreservesAspectWithinTargetCaps() throws Exception {
        File jpeg = writeTestJpeg(640, 480);

        GrayscaleBleProcessor.LumaImage luma =
                GrayscaleBleProcessor.processToLuma(jpeg.getAbsolutePath(), null, 320, 320);

        assertThat(luma.width).isEqualTo(320);
        assertThat(luma.height).isEqualTo(240);
        assertThat(luma.luma).hasSize(320 * 240);
    }

    @Test
    public void processToLumaKeepsDarkAndBrightRegionsDistinct() throws Exception {
        File jpeg = writeTestJpeg(640, 480);

        GrayscaleBleProcessor.LumaImage luma =
                GrayscaleBleProcessor.processToLuma(jpeg.getAbsolutePath(), null, 320, 320);

        int midRow = luma.height / 2;
        int leftSample = luma.luma[midRow * luma.width + luma.width / 4] & 0xFF;
        int rightSample = luma.luma[midRow * luma.width + (3 * luma.width) / 4] & 0xFF;
        assertThat(leftSample).isLessThan(64);
        assertThat(rightSample).isGreaterThan(192);
    }

    @Test
    public void roiCropsToRequestedRegion() throws Exception {
        File jpeg = writeTestJpeg(640, 480);

        // Crop entirely inside the white (right) half; result should be uniformly bright.
        Rect roi = new Rect(400, 100, 600, 300);
        GrayscaleBleProcessor.LumaImage luma =
                GrayscaleBleProcessor.processToLuma(jpeg.getAbsolutePath(), roi, 320, 320);

        assertThat(luma.width).isGreaterThan(0);
        assertThat(luma.height).isGreaterThan(0);
        long sum = 0;
        for (byte b : luma.luma) {
            sum += (b & 0xFF);
        }
        double mean = sum / (double) luma.luma.length;
        assertThat(mean).isGreaterThan(180.0);
    }

    @Test
    public void toGrayscaleBitmapProducesEqualChannels() throws Exception {
        File jpeg = writeTestJpeg(320, 240);

        Bitmap gray =
                GrayscaleBleProcessor.process(jpeg.getAbsolutePath(), null, 160, 160);
        try {
            assertThat(gray.getWidth()).isEqualTo(160);
            assertThat(gray.getHeight()).isEqualTo(120);
            int px = gray.getPixel(gray.getWidth() - 10, gray.getHeight() / 2);
            assertThat(Color.red(px)).isEqualTo(Color.green(px));
            assertThat(Color.green(px)).isEqualTo(Color.blue(px));
            assertThat(Color.alpha(px)).isEqualTo(255);
        } finally {
            gray.recycle();
        }
    }
}
