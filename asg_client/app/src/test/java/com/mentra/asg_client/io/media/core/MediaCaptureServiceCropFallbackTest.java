package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.ByteArrayOutputStream;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MediaCaptureServiceCropFallbackTest {

    @Test
    public void fullDecodeFallbackReturnsOnlyRequestedRegion() {
        Bitmap source = Bitmap.createBitmap(12, 8, Bitmap.Config.ARGB_8888);
        source.eraseColor(Color.WHITE);
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
        assertThat(source.compress(Bitmap.CompressFormat.JPEG, 90, jpeg)).isTrue();
        source.recycle();

        Bitmap cropped =
                MediaCaptureService.decodeFullJpegAndCrop(
                        jpeg.toByteArray(), new Rect(3, 2, 10, 7));

        assertThat(cropped).isNotNull();
        assertThat(cropped.getWidth()).isEqualTo(7);
        assertThat(cropped.getHeight()).isEqualTo(5);
        cropped.recycle();
    }
}
