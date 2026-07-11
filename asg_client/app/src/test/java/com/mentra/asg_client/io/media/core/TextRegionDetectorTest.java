package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Random;
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
public class TextRegionDetectorTest {

    @Rule public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final int W = 320;
    private static final int H = 240;

    /** Fills a luma raster with a flat background value. */
    private static byte[] flatLuma(int value) {
        byte[] luma = new byte[W * H];
        java.util.Arrays.fill(luma, (byte) value);
        return luma;
    }

    /** Draws dense text-like strokes (alternating dark segments) into a luma region. */
    private static void drawTextBlock(byte[] luma, Rect region) {
        for (int y = region.top; y < region.bottom; y++) {
            if ((y % 6) >= 2) {
                continue; // line spacing
            }
            for (int x = region.left; x < region.right; x++) {
                if ((x / 3) % 2 == 0) {
                    luma[y * W + x] = (byte) 20;
                }
            }
        }
    }

    @Test
    public void detectsConcentratedTextBlock() {
        byte[] luma = flatLuma(230);
        Rect textBlock = new Rect(40, 60, 160, 120);
        drawTextBlock(luma, textBlock);

        Rect roi = TextRegionDetector.detectOnLuma(luma, W, H);

        assertThat(roi).isNotNull();
        // ROI must cover the text block (padding may extend it) without being the whole frame.
        assertThat(roi.contains(textBlock.centerX(), textBlock.centerY())).isTrue();
        assertThat(roi.left).isLessThanOrEqualTo(textBlock.left);
        assertThat(roi.right).isGreaterThanOrEqualTo(textBlock.right);
        float areaFraction = roi.width() * roi.height() / (float) (W * H);
        assertThat(areaFraction).isLessThan(0.8f);
    }

    @Test
    public void returnsNullForFlatFrame() {
        byte[] luma = flatLuma(128);
        assertThat(TextRegionDetector.detectOnLuma(luma, W, H)).isNull();
    }

    @Test
    public void returnsNullWhenEdgesCoverWholeFrame() {
        // Uniform noise everywhere: edge energy is spread, no concentrated region.
        byte[] luma = new byte[W * H];
        Random random = new Random(42);
        random.nextBytes(luma);
        assertThat(TextRegionDetector.detectOnLuma(luma, W, H)).isNull();
    }

    @Test
    public void detectMapsRoiBackToSourcePixels() throws Exception {
        // 640x480 JPEG, text confined to the top-left quadrant.
        Bitmap source = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(source);
        canvas.drawColor(Color.WHITE);
        Paint dark = new Paint();
        dark.setColor(Color.BLACK);
        for (int line = 0; line < 8; line++) {
            int y = 40 + line * 20;
            for (int seg = 0; seg < 20; seg++) {
                if (seg % 2 == 0) {
                    canvas.drawRect(40 + seg * 10, y, 40 + seg * 10 + 8, y + 6, dark);
                }
            }
        }
        File jpeg = tempFolder.newFile("doc.jpg");
        try (FileOutputStream fos = new FileOutputStream(jpeg)) {
            source.compress(Bitmap.CompressFormat.JPEG, 92, fos);
        }
        source.recycle();

        Rect roi = TextRegionDetector.detect(jpeg.getAbsolutePath());

        assertThat(roi).isNotNull();
        // Text lives in x:[40,240), y:[40,200) - ROI should sit in the top-left, not span the
        // whole frame.
        assertThat(roi.contains(140, 120)).isTrue();
        assertThat(roi.right).isLessThan(640);
        assertThat(roi.bottom).isLessThan(480);
        float areaFraction = roi.width() * roi.height() / (float) (640 * 480);
        assertThat(areaFraction).isLessThan(0.8f);
    }
}
