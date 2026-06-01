package com.mentra.asg_client.camera.policy;

import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.util.Range;

/**
 * Phase 3 prep: immutable snapshot of the autofocus + manual-sensor capabilities of a camera.
 *
 * <p>Extracted from {@link CameraNeoService#queryCameraCapabilities(CameraCharacteristics)} so the
 * scattered {@code manualSensorSupported}, {@code sensorExposureTimeRange},
 * {@code sensorMaxFrameDurationNs}, {@code sensorSensitivityRange}, {@code availableAfModes},
 * {@code minimumFocusDistance}, and {@code hasAutoFocus} fields collapse into one value object.
 *
 * <p>FPS / EV compensation capabilities deliberately stay in {@link CameraNeoService} because they drive
 * a runtime *decision* (e.g. {@code chooseOptimalFpsRange}) rather than being raw capabilities.
 *
 * <p>All fields are final; the {@link #from(CameraCharacteristics)} factory does the parsing and
 * is what unit tests exercise via {@link com.mentra.asg_client.camera.testing.FakeCameraCharacteristics}.
 */
public final class CameraCapabilities {

    /** Reported AF modes, or {@code null} if the characteristic isn't published. */
    public final int[] availableAfModes;

    /** {@code true} when the device advertises {@link CaptureRequest#CONTROL_AF_MODE_CONTINUOUS_PICTURE}. */
    public final boolean hasContinuousPictureAf;

    /** Lens minimum focus distance in dioptres; 0 when the characteristic isn't published. */
    public final float minimumFocusDistance;

    /** {@code true} when the camera advertises the MANUAL_SENSOR capability. */
    public final boolean manualSensorSupported;

    /** Sensor's supported {@code SENSOR_EXPOSURE_TIME} range, or {@code null}. */
    public final Range<Long> sensorExposureTimeRange;

    /** Sensor's reported {@code SENSOR_INFO_MAX_FRAME_DURATION}, or {@code null}. */
    public final Long sensorMaxFrameDurationNs;

    /** Sensor's supported {@code SENSOR_SENSITIVITY} (ISO) range, or {@code null}. */
    public final Range<Integer> sensorSensitivityRange;

    public CameraCapabilities(int[] availableAfModes,
                               boolean hasContinuousPictureAf,
                               float minimumFocusDistance,
                               boolean manualSensorSupported,
                               Range<Long> sensorExposureTimeRange,
                               Long sensorMaxFrameDurationNs,
                               Range<Integer> sensorSensitivityRange) {
        this.availableAfModes = availableAfModes;
        this.hasContinuousPictureAf = hasContinuousPictureAf;
        this.minimumFocusDistance = minimumFocusDistance;
        this.manualSensorSupported = manualSensorSupported;
        this.sensorExposureTimeRange = sensorExposureTimeRange;
        this.sensorMaxFrameDurationNs = sensorMaxFrameDurationNs;
        this.sensorSensitivityRange = sensorSensitivityRange;
    }

    /**
     * Parse the AF + manual-sensor capabilities out of a {@link CameraCharacteristics}.
     *
     * <p>Matches the historical inline parsing in {@code queryCameraCapabilities}:
     * <ul>
     *   <li>{@link #hasContinuousPictureAf} is {@code true} iff
     *       {@link CaptureRequest#CONTROL_AF_MODE_CONTINUOUS_PICTURE} appears in
     *       {@link CameraCharacteristics#CONTROL_AF_AVAILABLE_MODES}.</li>
     *   <li>{@link #minimumFocusDistance} falls back to {@code 0.0f} when the characteristic is null.</li>
     *   <li>{@link #manualSensorSupported} is {@code true} iff the camera advertises
     *       {@link CameraMetadata#REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR}.</li>
     * </ul>
     */
    public static CameraCapabilities from(CameraCharacteristics characteristics) {
        int[] afModes = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
        boolean hasContinuousPicture = false;
        if (afModes != null) {
            for (int mode : afModes) {
                if (mode == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) {
                    hasContinuousPicture = true;
                    break;
                }
            }
        }

        Float minFocusBoxed = characteristics.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        float minFocus = (minFocusBoxed != null) ? minFocusBoxed : 0.0f;

        int[] caps = characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        boolean manualSensor = false;
        if (caps != null) {
            for (int c : caps) {
                if (c == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) {
                    manualSensor = true;
                    break;
                }
            }
        }

        Range<Long> exposureRange =
                characteristics.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        Long maxFrameDurationNs =
                characteristics.get(CameraCharacteristics.SENSOR_INFO_MAX_FRAME_DURATION);
        Range<Integer> sensitivityRange =
                characteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);

        return new CameraCapabilities(afModes, hasContinuousPicture, minFocus,
                manualSensor, exposureRange, maxFrameDurationNs, sensitivityRange);
    }
}
