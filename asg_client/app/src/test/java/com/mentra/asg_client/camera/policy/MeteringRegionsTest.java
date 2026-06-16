package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.params.MeteringRectangle;
import android.util.Size;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 3.1 unit tests for {@link MeteringRegions}. The math must match the historical inline
 * formula (square 1/3-edge region, centered, clamped to image bounds, max weight).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MeteringRegionsTest {

    @Test
    public void centerWeighted_atSize_1920x1080() {
        MeteringRectangle[] regions = MeteringRegions.centerWeighted(new Size(1920, 1080));
        assertThat(regions).isNotNull().hasSize(1);
        MeteringRectangle r = regions[0];
        // center=(960,540), regionSize=min(1920,1080)/3=360, half=180 → rect (780,360,360,360).
        assertThat(r.getX()).isEqualTo(780);
        assertThat(r.getY()).isEqualTo(360);
        assertThat(r.getWidth()).isEqualTo(360);
        assertThat(r.getHeight()).isEqualTo(360);
        assertThat(r.getMeteringWeight()).isEqualTo(MeteringRectangle.METERING_WEIGHT_MAX);
    }

    @Test
    public void centerWeighted_atSize_640x480() {
        MeteringRectangle[] regions = MeteringRegions.centerWeighted(new Size(640, 480));
        assertThat(regions).hasSize(1);
        MeteringRectangle r = regions[0];
        // center=(320,240), regionSize=480/3=160, half=80 → rect (240,160,160,160).
        assertThat(r.getX()).isEqualTo(240);
        assertThat(r.getY()).isEqualTo(160);
        assertThat(r.getWidth()).isEqualTo(160);
        assertThat(r.getHeight()).isEqualTo(160);
    }

    @Test
    public void centerWeighted_atSize_3840x2160() {
        MeteringRectangle[] regions = MeteringRegions.centerWeighted(new Size(3840, 2160));
        MeteringRectangle r = regions[0];
        // center=(1920,1080), regionSize=2160/3=720, half=360 → rect (1560,720,720,720).
        assertThat(r.getX()).isEqualTo(1560);
        assertThat(r.getY()).isEqualTo(720);
        assertThat(r.getWidth()).isEqualTo(720);
        assertThat(r.getHeight()).isEqualTo(720);
    }

    @Test
    public void centerWeighted_squareImage_remainsCenteredAndOneThird() {
        MeteringRectangle r = MeteringRegions.centerWeighted(new Size(900, 900))[0];
        // regionSize=300, half=150 → rect (300,300,300,300).
        assertThat(r.getX()).isEqualTo(300);
        assertThat(r.getY()).isEqualTo(300);
        assertThat(r.getWidth()).isEqualTo(300);
        assertThat(r.getHeight()).isEqualTo(300);
    }

    @Test
    public void centerWeighted_smallImage_clampsToBounds() {
        // Tiny preview size: 6x6 → regionSize=2, half=1 → rect (2,2,2,2). All within bounds.
        MeteringRectangle r = MeteringRegions.centerWeighted(new Size(6, 6))[0];
        assertThat(r.getX()).isGreaterThanOrEqualTo(0);
        assertThat(r.getY()).isGreaterThanOrEqualTo(0);
        assertThat(r.getX() + r.getWidth()).isLessThanOrEqualTo(6);
        assertThat(r.getY() + r.getHeight()).isLessThanOrEqualTo(6);
    }

    @Test
    public void centerWeighted_nullSize_returnsNull() {
        assertThat(MeteringRegions.centerWeighted(null)).isNull();
    }

    @Test
    public void fullImage_returnsFullExtentMaxWeight() {
        MeteringRectangle[] regions = MeteringRegions.fullImage(new Size(320, 240));
        assertThat(regions).hasSize(1);
        MeteringRectangle r = regions[0];
        assertThat(r.getX()).isEqualTo(0);
        assertThat(r.getY()).isEqualTo(0);
        assertThat(r.getWidth()).isEqualTo(320);
        assertThat(r.getHeight()).isEqualTo(240);
        assertThat(r.getMeteringWeight()).isEqualTo(MeteringRectangle.METERING_WEIGHT_MAX);
    }

    @Test
    public void fullImage_nullSize_returnsNull() {
        assertThat(MeteringRegions.fullImage(null)).isNull();
    }
}
