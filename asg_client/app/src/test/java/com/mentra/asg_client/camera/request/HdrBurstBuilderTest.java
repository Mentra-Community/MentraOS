package com.mentra.asg_client.camera.request;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.CaptureRequest;
import android.util.Range;

import com.mentra.asg_client.camera.testing.CaptureRequestRecorder;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 2d unit tests for {@link HdrBurstBuilder}. Verifies the bracket configuration recipe
 * matches the inline code that previously lived in {@link CameraNeoService#captureHdrBurst()}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class HdrBurstBuilderTest {

    private CaptureRequestRecorder recorder;

    @Before
    public void setUp() {
        recorder = new CaptureRequestRecorder();
    }

    // ===== Constants =====

    @Test
    public void constants_matchHistoricalValues() {
        assertThat(HdrBurstBuilder.HDR_BURST_COUNT).isEqualTo(3);
        assertThat(HdrBurstBuilder.HDR_EV_BRACKETS).containsExactly(-2, 0, 2);
    }

    @Test
    public void bracketsArray_lengthMatches_burstCount() {
        assertThat(HdrBurstBuilder.HDR_EV_BRACKETS).hasSize(HdrBurstBuilder.HDR_BURST_COUNT);
    }

    // ===== configureBracket =====

    @Test
    public void configureBracket_lockedAe_andAwbAuto() {
        HdrBurstBuilder.configureBracket(recorder, /*ev=*/ 0,
                new Range<>(30, 30), /*hasAutoFocus=*/ true, /*quality=*/ 90, /*rotation=*/ 90);

        assertThat(recorder.get(CaptureRequest.CONTROL_AE_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AE_MODE_ON);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_LOCK)).isEqualTo(true);
        assertThat(recorder.get(CaptureRequest.CONTROL_AWB_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AWB_MODE_AUTO);
    }

    @Test
    public void configureBracket_setsEvCompensation_passedThrough() {
        HdrBurstBuilder.configureBracket(recorder, -2,
                new Range<>(30, 30), true, 90, 90);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION)).isEqualTo(-2);

        recorder.clear();
        HdrBurstBuilder.configureBracket(recorder, 2,
                new Range<>(30, 30), true, 90, 90);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION)).isEqualTo(2);
    }

    @Test
    public void configureBracket_stampsFpsRange_whenProvided() {
        Range<Integer> fps = new Range<>(15, 30);
        HdrBurstBuilder.configureBracket(recorder, 0, fps, true, 90, 90);
        assertThat(recorder.get(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE)).isEqualTo(fps);
    }

    @Test
    public void configureBracket_skipsFpsRange_whenNull() {
        HdrBurstBuilder.configureBracket(recorder, 0, null, true, 90, 90);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE)).isFalse();
    }

    @Test
    public void configureBracket_withAutoFocus_setsContinuousPictureMode() {
        HdrBurstBuilder.configureBracket(recorder, 0,
                new Range<>(30, 30), /*hasAutoFocus=*/ true, 90, 90);
        assertThat(recorder.get(CaptureRequest.CONTROL_AF_MODE))
                .isEqualTo(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
    }

    @Test
    public void configureBracket_withoutAutoFocus_skipsAfMode() {
        HdrBurstBuilder.configureBracket(recorder, 0,
                new Range<>(30, 30), /*hasAutoFocus=*/ false, 90, 90);
        assertThat(recorder.containsKey(CaptureRequest.CONTROL_AF_MODE)).isFalse();
    }

    @Test
    public void configureBracket_stampsHighQualityPostProcessing() {
        HdrBurstBuilder.configureBracket(recorder, 0,
                new Range<>(30, 30), true, 87, 180);
        assertThat(recorder.get(CaptureRequest.NOISE_REDUCTION_MODE))
                .isEqualTo(CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
        assertThat(recorder.get(CaptureRequest.EDGE_MODE))
                .isEqualTo(CaptureRequest.EDGE_MODE_HIGH_QUALITY);
        assertThat(recorder.get(CaptureRequest.JPEG_QUALITY)).isEqualTo((byte) 87);
        assertThat(recorder.get(CaptureRequest.JPEG_ORIENTATION)).isEqualTo(180);
    }

    @Test
    public void configureBracket_neverSetsManualSensorKeys() {
        HdrBurstBuilder.configureBracket(recorder, 0,
                new Range<>(30, 30), true, 90, 90);
        // HDR brackets always use AE on/locked — never manual sensor keys.
        assertThat(recorder.containsKey(CaptureRequest.SENSOR_EXPOSURE_TIME)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.SENSOR_SENSITIVITY)).isFalse();
        assertThat(recorder.containsKey(CaptureRequest.SENSOR_FRAME_DURATION)).isFalse();
    }

    // ===== bracketFileSuffix =====

    @Test
    public void bracketFileSuffix_perIndex_matchesHistoricalNaming() {
        assertThat(HdrBurstBuilder.bracketFileSuffix(0)).isEqualTo("ev-2");
        assertThat(HdrBurstBuilder.bracketFileSuffix(1)).isEqualTo("ev0");
        assertThat(HdrBurstBuilder.bracketFileSuffix(2)).isEqualTo("ev2");
    }

    @Test
    public void bracketFileSuffix_outOfRangeIndex_clampsToLastBracket() {
        // Historical behavior used Math.min(frameIdx, len-1) — over-range clamps to last bracket.
        assertThat(HdrBurstBuilder.bracketFileSuffix(99)).isEqualTo("ev2");
    }

    @Test
    public void bracketFileSuffix_negativeIndex_clampsToFirstBracket() {
        assertThat(HdrBurstBuilder.bracketFileSuffix(-1)).isEqualTo("ev-2");
    }
}
