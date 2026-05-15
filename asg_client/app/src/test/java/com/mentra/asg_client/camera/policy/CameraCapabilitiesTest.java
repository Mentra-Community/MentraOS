package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CaptureRequest;
import android.util.Range;

import com.mentra.asg_client.camera.testing.FakeCameraCharacteristics;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 3 prep unit tests for {@link CameraCapabilities}. The parsing must match the historical
 * inline code in {@code CameraNeoService.queryCameraCapabilities()} bit-for-bit; downstream code
 * (manual exposure decision, ISO clamping, frame-duration choice) depends on those fields.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraCapabilitiesTest {

    @Test
    public void from_manualSensorCharacteristics_setsAllManualFields() {
        CameraCharacteristics c = FakeCameraCharacteristics.withManualSensor(
                new Range<>(1_000L, 1_000_000_000L), new Range<>(100, 6400));

        CameraCapabilities caps = CameraCapabilities.from(c);

        assertThat(caps.manualSensorSupported).isTrue();
        assertThat(caps.sensorExposureTimeRange).isEqualTo(new Range<>(1_000L, 1_000_000_000L));
        assertThat(caps.sensorSensitivityRange).isEqualTo(new Range<>(100, 6400));
        assertThat(caps.sensorMaxFrameDurationNs).isEqualTo(100_000_000L);
    }

    @Test
    public void from_minimalAutoOnly_setsManualSensorFalse_andNullRanges() {
        CameraCapabilities caps = CameraCapabilities.from(
                FakeCameraCharacteristics.minimalAutoOnly());

        assertThat(caps.manualSensorSupported).isFalse();
        assertThat(caps.sensorExposureTimeRange).isNull();
        assertThat(caps.sensorSensitivityRange).isNull();
        assertThat(caps.sensorMaxFrameDurationNs).isNull();
    }

    @Test
    public void from_minimalAutoOnly_hasNoContinuousPictureAf() {
        CameraCapabilities caps = CameraCapabilities.from(
                FakeCameraCharacteristics.minimalAutoOnly());
        assertThat(caps.hasContinuousPictureAf).isFalse();
        // Empty array vs. null: the minimal helper returns int[0] for AF modes.
        assertThat(caps.availableAfModes).isNotNull();
        assertThat(caps.availableAfModes).isEmpty();
    }

    @Test
    public void from_continuousPictureAvailable_setsHasAutoFocusTrue() {
        CameraCharacteristics c = FakeCameraCharacteristics.withAutofocusAndManualSensor(
                /*minFocus=*/ 2.5f,
                new Range<>(1_000L, 1_000_000_000L),
                new Range<>(100, 6400),
                /*maxFrameDurationNs=*/ 200_000_000L);

        CameraCapabilities caps = CameraCapabilities.from(c);

        assertThat(caps.hasContinuousPictureAf).isTrue();
        assertThat(caps.minimumFocusDistance).isEqualTo(2.5f);
        assertThat(caps.availableAfModes).contains(
                CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
        assertThat(caps.sensorMaxFrameDurationNs).isEqualTo(200_000_000L);
    }

    @Test
    public void from_nullMinimumFocusDistance_fallsBackToZero() {
        CameraCharacteristics c = org.mockito.Mockito.mock(CameraCharacteristics.class);
        org.mockito.Mockito.when(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES))
                .thenReturn(null);
        org.mockito.Mockito.when(c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE))
                .thenReturn(null);
        org.mockito.Mockito.when(c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES))
                .thenReturn(null);

        CameraCapabilities caps = CameraCapabilities.from(c);

        assertThat(caps.minimumFocusDistance).isEqualTo(0.0f);
        assertThat(caps.availableAfModes).isNull();
        assertThat(caps.hasContinuousPictureAf).isFalse();
        assertThat(caps.manualSensorSupported).isFalse();
    }

    @Test
    public void from_afModesWithoutContinuousPicture_setsHasContinuousPictureFalse() {
        CameraCharacteristics c = org.mockito.Mockito.mock(CameraCharacteristics.class);
        org.mockito.Mockito.when(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES))
                .thenReturn(new int[] {
                        CaptureRequest.CONTROL_AF_MODE_OFF,
                        CaptureRequest.CONTROL_AF_MODE_AUTO});
        org.mockito.Mockito.when(c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE))
                .thenReturn(1.0f);
        org.mockito.Mockito.when(c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES))
                .thenReturn(new int[] {
                        CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE});

        CameraCapabilities caps = CameraCapabilities.from(c);

        assertThat(caps.hasContinuousPictureAf).isFalse();
        assertThat(caps.manualSensorSupported).isFalse();
    }

    @Test
    public void allFieldsAreFinal() throws Exception {
        for (java.lang.reflect.Field f : CameraCapabilities.class.getDeclaredFields()) {
            if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) {
                continue;
            }
            assertThat(java.lang.reflect.Modifier.isFinal(f.getModifiers()))
                    .as("Field %s should be final", f.getName())
                    .isTrue();
        }
    }
}
