package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Unit tests for the pure orientation-lookup math in {@link JpegOrientationResolver}.
 *
 * <p>{@code getDisplayRotation(Context)} is intentionally not covered here — it depends on
 * {@code WindowManager} and {@code ServiceUtils} (which requires a real device probe). Those
 * code paths are exercised by the manual smoke matrix.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class JpegOrientationResolverTest {

    @Test
    public void lookup_zero_returnsNinety() {
        assertThat(JpegOrientationResolver.lookupJpegOrientation(0, 0)).isEqualTo(90);
    }

    @Test
    public void lookup_ninety_returnsZero() {
        assertThat(JpegOrientationResolver.lookupJpegOrientation(90, 0)).isEqualTo(0);
    }

    @Test
    public void lookup_oneEighty_returnsTwoSeventy() {
        assertThat(JpegOrientationResolver.lookupJpegOrientation(180, 0)).isEqualTo(270);
    }

    @Test
    public void lookup_twoSeventy_returnsOneEighty() {
        assertThat(JpegOrientationResolver.lookupJpegOrientation(270, 0)).isEqualTo(180);
    }

    @Test
    public void lookup_unmappedRotation_returnsCallerDefault() {
        assertThat(JpegOrientationResolver.lookupJpegOrientation(45, 90)).isEqualTo(90);
        assertThat(JpegOrientationResolver.lookupJpegOrientation(45, 0)).isEqualTo(0);
        assertThat(JpegOrientationResolver.lookupJpegOrientation(-1, 17)).isEqualTo(17);
    }

    @Test
    public void defaultConstants_matchHistoricalValues() {
        // These constants are what callers in CameraNeoService previously passed inline as the second
        // arg to JPEG_ORIENTATION.get(rotation, default).
        assertThat(JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION).isEqualTo(90);
        assertThat(JpegOrientationResolver.DEFAULT_VIDEO_ORIENTATION).isEqualTo(0);
    }
}
