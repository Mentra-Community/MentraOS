package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import android.util.Range;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 2 unit tests for {@link ManualExposurePolicy}. The policy is the manual-exposure math
 * that previously lived inside CameraNeoService.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class ManualExposurePolicyTest {

    // --- clampExposureTimeNs ---

    @Test
    public void clamp_belowMin_returnsMin() {
        long out = ManualExposurePolicy.clampExposureTimeNs(50L, new Range<>(1_000L, 1_000_000L));
        assertThat(out).isEqualTo(1_000L);
    }

    @Test
    public void clamp_aboveMax_returnsMax() {
        long out = ManualExposurePolicy.clampExposureTimeNs(2_000_000L, new Range<>(1_000L, 1_000_000L));
        assertThat(out).isEqualTo(1_000_000L);
    }

    @Test
    public void clamp_withinRange_isUnchanged() {
        long out = ManualExposurePolicy.clampExposureTimeNs(500_000L, new Range<>(1_000L, 1_000_000L));
        assertThat(out).isEqualTo(500_000L);
    }

    @Test
    public void clamp_nullRange_returnsRequestedUnchanged() {
        assertThat(ManualExposurePolicy.clampExposureTimeNs(42L, null)).isEqualTo(42L);
    }

    @Test
    public void clamp_atBoundary_returnsBoundaryValue() {
        Range<Long> r = new Range<>(1_000L, 1_000_000L);
        assertThat(ManualExposurePolicy.clampExposureTimeNs(1_000L, r)).isEqualTo(1_000L);
        assertThat(ManualExposurePolicy.clampExposureTimeNs(1_000_000L, r)).isEqualTo(1_000_000L);
    }

    // --- pickSensitivityForManualCapture ---

    @Test
    public void pickIso_noMeteredValues_returnsDefaultIso() {
        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                /*targetExposureNs=*/ 10_000_000L,
                /*meteredIso=*/ null,
                /*meteredExposureNs=*/ null,
                /*range=*/ new Range<>(100, 6400));
        assertThat(iso).isEqualTo(ManualExposurePolicy.DEFAULT_ISO);
    }

    @Test
    public void pickIso_scalesInversely_withShutterRatio() {
        // metered: t=20ms, iso=200 → fast shutter 5ms requested → iso should scale up ~ x4 = 800
        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                5_000_000L, 200, 20_000_000L, new Range<>(100, 6400));
        assertThat(iso).isEqualTo(800);
    }

    @Test
    public void pickIso_clampsAboveSensorMax() {
        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                1_000_000L, 1600, 100_000_000L, new Range<>(100, 6400));
        // raw scale would be 1600 * 100 = 160_000; clamped to 6400.
        assertThat(iso).isEqualTo(6400);
    }

    @Test
    public void pickIso_clampsBelowSensorMin() {
        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                1_000_000_000L, 100, 10_000_000L, new Range<>(100, 6400));
        // raw scale would be 100 * 10/1000 = 1; clamped to 100.
        assertThat(iso).isEqualTo(100);
    }

    @Test
    public void pickIso_nullRange_doesNotClamp() {
        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                5_000_000L, 200, 20_000_000L, null);
        assertThat(iso).isEqualTo(800);
    }

    @Test
    public void pickIso_negativeMeteredIso_fallsBackToDefault() {
        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                5_000_000L, -50, 20_000_000L, new Range<>(100, 6400));
        // metered ignored → default ISO used as baseline; no scale applied because metered is rejected.
        // Actually: meteredExposureNs is still valid, but iso starts from DEFAULT_ISO; then scale applies.
        // DEFAULT_ISO=400, scale=20/5=4 → 1600.
        assertThat(iso).isEqualTo(1600);
    }

    // --- pickFrameDurationForManualCapture ---

    @Test
    public void pickFrameDuration_addsGuardBand() {
        long frameNs = ManualExposurePolicy.pickFrameDurationForManualCapture(
                /*exposureNs=*/ 30_000_000L, /*max=*/ 100_000_000L);
        assertThat(frameNs).isEqualTo(30_000_000L + ManualExposurePolicy.FRAME_DURATION_GUARD_NS);
    }

    @Test
    public void pickFrameDuration_clampsToSensorMax() {
        long frameNs = ManualExposurePolicy.pickFrameDurationForManualCapture(
                80_000_000L, 50_000_000L);
        // guard would push to 81ms, sensor max is 50ms → result clamped, but final Math.max ensures
        // frameDuration >= exposureNs. Here exposure (80ms) exceeds sensor max (50ms) so result = 80ms.
        assertThat(frameNs).isEqualTo(80_000_000L);
    }

    @Test
    public void pickFrameDuration_nullSensorMax_skipsClamp() {
        long frameNs = ManualExposurePolicy.pickFrameDurationForManualCapture(40_000_000L, null);
        assertThat(frameNs).isEqualTo(40_000_000L + ManualExposurePolicy.FRAME_DURATION_GUARD_NS);
    }

    @Test
    public void pickFrameDuration_neverBelowExposure() {
        // The Math.max() guard prevents returning a duration smaller than the exposure time itself.
        long frameNs = ManualExposurePolicy.pickFrameDurationForManualCapture(
                100_000_000L, 1_000_000L);
        assertThat(frameNs).isGreaterThanOrEqualTo(100_000_000L);
    }

    @Test
    public void pickFrameDuration_zeroExposure_returnsGuardBand() {
        long frameNs = ManualExposurePolicy.pickFrameDurationForManualCapture(0L, 100_000_000L);
        assertThat(frameNs).isEqualTo(ManualExposurePolicy.FRAME_DURATION_GUARD_NS);
    }
}
