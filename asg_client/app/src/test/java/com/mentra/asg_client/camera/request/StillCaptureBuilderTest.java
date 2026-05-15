package com.mentra.asg_client.camera.request;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.MeteringRectangle;
import android.util.Range;
import android.util.Size;

import com.mentra.asg_client.camera.testing.CaptureRequestRecorder;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 2 unit tests for {@link StillCaptureBuilder}. We use {@link CaptureRequestRecorder}
 * (which implements {@link StillCaptureBuilder.Sink}) as the direct sink, bypassing the
 * {@code final} {@link CaptureRequest.Builder} altogether. Behavior must match the inline code
 * that previously lived in {@link CameraNeoService#capturePhoto()}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class StillCaptureBuilderTest {

    private CaptureRequestRecorder recorder;

    @Before
    public void setUp() {
        recorder = new CaptureRequestRecorder();
    }

    // ===== configureExposure — manual path =====

    @Test
    public void configureExposure_manual_setsSensorKeysAndDisablesAe() {
        StillCaptureBuilder.configureExposure(recorder,
                /*useManual=*/ true,
                /*manualClampedNs=*/ 30_000_000L,
                /*manualIso=*/ 800,
                /*manualFrameDurationNs=*/ 31_000_000L,
                /*userExposureCompensation=*/ 0,
                /*selectedFpsRange=*/ new Range<>(30, 30));

        assertThat(recorder.get(CaptureRequest.CONTROL_AE_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AE_MODE_OFF);
        assertThat(recorder.get(CaptureRequest.SENSOR_EXPOSURE_TIME)).isEqualTo(30_000_000L);
        assertThat(recorder.get(CaptureRequest.SENSOR_SENSITIVITY)).isEqualTo(800);
        assertThat(recorder.get(CaptureRequest.SENSOR_FRAME_DURATION)).isEqualTo(31_000_000L);
        assertThat(recorder.get(CaptureRequest.CONTROL_AWB_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AWB_MODE_AUTO);

        // Manual path must NOT set AE lock, AE comp, FPS range, or AE region.
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_LOCK)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE)).isFalse();
    }

    // ===== configureExposure — auto path =====

    @Test
    public void configureExposure_auto_locksAeAndAppliesCompAndFpsRange() {
        Range<Integer> fps = new Range<>(15, 30);
        StillCaptureBuilder.configureExposure(recorder, false, 0L, 0, 0L, 2, fps);

        assertThat(recorder.get(CaptureRequest.CONTROL_AE_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AE_MODE_ON);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_LOCK)).isEqualTo(true);
        assertThat(recorder.get(CaptureRequest.CONTROL_AWB_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AWB_MODE_AUTO);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION)).isEqualTo(2);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE)).isEqualTo(fps);

        // Auto path must NOT set manual sensor keys.
        assertThat(recorder.containsKey(CaptureRequest.SENSOR_EXPOSURE_TIME)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.SENSOR_SENSITIVITY)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.SENSOR_FRAME_DURATION)).isFalse();
    }

    @Test
    public void configureExposure_auto_withNullFpsRange_skipsFpsKey() {
        StillCaptureBuilder.configureExposure(recorder, false, 0L, 0, 0L, 0, null);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE)).isFalse();
    }

    // ===== configureFocusAndMetering =====

    @Test
    public void configureFocusAndMetering_noAutoFocus_isNoOp() {
        StillCaptureBuilder.configureFocusAndMetering(recorder,
                /*hasAutoFocus=*/ false, new Size(1920, 1080), /*useManual=*/ false);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AF_MODE)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AF_REGIONS)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_REGIONS)).isFalse();
    }

    @Test
    public void configureFocusAndMetering_nullJpegSize_isNoOp() {
        StillCaptureBuilder.configureFocusAndMetering(recorder, true, null, false);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AF_MODE)).isFalse();
    }

    @Test
    public void configureFocusAndMetering_autoFocus_setsContinuousPictureMode() {
        StillCaptureBuilder.configureFocusAndMetering(recorder, true, new Size(1920, 1080), false);
        assertThat(recorder.get(CaptureRequest.CONTROL_AF_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
    }

    @Test
    public void configureFocusAndMetering_centerRegion_isWithinBounds_andCenterWeighted() {
        StillCaptureBuilder.configureFocusAndMetering(recorder, true, new Size(1920, 1080), false);

        MeteringRectangle[] af = recorder.get(CaptureRequest.CONTROL_AF_REGIONS);
        assertThat(af).isNotNull();
        assertThat(af).hasSize(1);
        MeteringRectangle r = af[0];
        // Center is (960, 540), regionSize = 1080/3 = 360, half = 180 → rect (780,360,360,360).
        assertThat(r.getX()).isEqualTo(780);
        assertThat(r.getY()).isEqualTo(360);
        assertThat(r.getWidth()).isEqualTo(360);
        assertThat(r.getHeight()).isEqualTo(360);
        assertThat(r.getMeteringWeight()).isEqualTo(MeteringRectangle.METERING_WEIGHT_MAX);
    }

    @Test
    public void configureFocusAndMetering_autoPath_alsoSetsAeRegion() {
        StillCaptureBuilder.configureFocusAndMetering(recorder, true, new Size(1920, 1080),
                /*useManual=*/ false);
        MeteringRectangle[] ae = recorder.get(CaptureRequest.CONTROL_AE_REGIONS);
        assertThat(ae).isNotNull().hasSize(1);
    }

    @Test
    public void configureFocusAndMetering_manualPath_skipsAeRegion() {
        StillCaptureBuilder.configureFocusAndMetering(recorder, true, new Size(1920, 1080),
                /*useManual=*/ true);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_REGIONS)).isFalse();
        // AF region is still set under manual path because focus is independent of exposure.
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AF_REGIONS)).isTrue();
    }

    // ===== configureQualityAndOrientation =====

    @Test
    public void configureQualityAndOrientation_stampsAllFourKeys() {
        StillCaptureBuilder.configureQualityAndOrientation(recorder, /*quality=*/ 85, /*rotation=*/ 90);

        assertThat(recorder.get(CaptureRequest.NOISE_REDUCTION_MODE))
                .isEqualTo(CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
        assertThat(recorder.get(CaptureRequest.EDGE_MODE))
                .isEqualTo(CaptureRequest.EDGE_MODE_HIGH_QUALITY);
        assertThat(recorder.get(CaptureRequest.JPEG_QUALITY)).isEqualTo((byte) 85);
        assertThat(recorder.get(CaptureRequest.JPEG_ORIENTATION)).isEqualTo(90);
    }

    @Test
    public void configureQualityAndOrientation_jpegQualityIsCastToByte() {
        StillCaptureBuilder.configureQualityAndOrientation(recorder, 255, 180);
        // 255 cast to byte = -1; we only care it's a byte, not the unsigned value.
        Object q = recorder.get(CaptureRequest.JPEG_QUALITY);
        assertThat(q).isInstanceOf(Byte.class);
    }

    // ===== configure (full recipe) =====

    @Test
    public void configure_full_manualRecipe_setsExposureFocusQualityKeys() {
        StillCaptureBuilder.configure(recorder,
                /*useManual=*/ true,
                /*manualClampedNs=*/ 100_000_000L,
                /*manualIso=*/ 200,
                /*manualFrameDurationNs=*/ 101_000_000L,
                /*userExposureCompensation=*/ 0,
                /*selectedFpsRange=*/ new Range<>(30, 30),
                /*hasAutoFocus=*/ true,
                /*jpegSize=*/ new Size(1920, 1080),
                /*jpegQuality=*/ 95,
                /*jpegOrientation=*/ 90);

        // Exposure block (manual)
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AE_MODE_OFF);
        assertThat(recorder.get(CaptureRequest.SENSOR_EXPOSURE_TIME)).isEqualTo(100_000_000L);
        assertThat(recorder.get(CaptureRequest.SENSOR_SENSITIVITY)).isEqualTo(200);

        // Focus block
        assertThat(recorder.get(CaptureRequest.CONTROL_AF_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AF_REGIONS)).isTrue();
        // Manual exposure must NOT touch AE regions.
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_REGIONS)).isFalse();

        // Quality block
        assertThat(recorder.get(CaptureRequest.JPEG_QUALITY)).isEqualTo((byte) 95);
        assertThat(recorder.get(CaptureRequest.JPEG_ORIENTATION)).isEqualTo(90);
    }

    @Test
    public void configure_full_autoRecipe_setsAeLockAndBothRegions() {
        StillCaptureBuilder.configure(recorder, false, 0L, 0, 0L,
                /*expComp=*/ 1, new Range<>(15, 30), true, new Size(1920, 1080), 80, 270);

        assertThat(recorder.get(CaptureRequest.CONTROL_AE_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AE_MODE_ON);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_LOCK)).isEqualTo(true);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AF_REGIONS)).isTrue();
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_REGIONS)).isTrue();
        assertThat(recorder.get(CaptureRequest.JPEG_ORIENTATION)).isEqualTo(270);
    }
}
