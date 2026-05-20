package com.mentra.asg_client.camera.testing;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CaptureRequest;
import android.util.Range;

/**
 * Minimal {@link CameraCharacteristics} mocks for JVM unit tests.
 */
public final class FakeCameraCharacteristics {

    private FakeCameraCharacteristics() {}

    @SuppressWarnings("unchecked")
    public static CameraCharacteristics withManualSensor(
            Range<Long> exposureRange, Range<Integer> isoRange) {
        CameraCharacteristics c = mock(CameraCharacteristics.class);
        when(c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES))
                .thenReturn(new int[] {CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR});
        when(c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)).thenReturn(exposureRange);
        when(c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)).thenReturn(isoRange);
        when(c.get(CameraCharacteristics.SENSOR_INFO_MAX_FRAME_DURATION)).thenReturn(100_000_000L);
        return c;
    }

    public static CameraCharacteristics minimalAutoOnly() {
        CameraCharacteristics c = mock(CameraCharacteristics.class);
        when(c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES))
                .thenReturn(new int[] {CaptureRequest.CONTROL_AE_MODE_ON});
        when(c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE))
                .thenReturn(Range.create(-2, 2));
        when(c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)).thenReturn(null);
        when(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)).thenReturn(new int[0]);
        when(c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)).thenReturn(0f);
        return c;
    }

    /**
     * A {@link CameraCharacteristics} with continuous-picture AF supported plus the given
     * minimum focus distance — combined with manual-sensor capabilities. Used by
     * {@link com.mentra.asg_client.camera.CameraCapabilitiesTest}.
     */
    public static CameraCharacteristics withAutofocusAndManualSensor(
            float minFocusDistance,
            Range<Long> exposureRange,
            Range<Integer> isoRange,
            Long maxFrameDurationNs) {
        CameraCharacteristics c = mock(CameraCharacteristics.class);
        when(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES))
                .thenReturn(new int[] {
                        CaptureRequest.CONTROL_AF_MODE_OFF,
                        CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE});
        when(c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)).thenReturn(minFocusDistance);
        when(c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES))
                .thenReturn(new int[] {CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR});
        when(c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)).thenReturn(exposureRange);
        when(c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)).thenReturn(isoRange);
        when(c.get(CameraCharacteristics.SENSOR_INFO_MAX_FRAME_DURATION)).thenReturn(maxFrameDurationNs);
        return c;
    }
}
