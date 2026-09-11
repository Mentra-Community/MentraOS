package com.mentra.asg_client.camera.policy;

import android.util.Size;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.CameraConstants;

/** Resolves requested photo source/size tier to target JPEG dimensions. */
public final class PhotoResolutionPolicy {

    private PhotoResolutionPolicy() {}

    public static Size targetSize(boolean fromSdk, String requestedSizeTier) {
        String tier = PhotoSizeTier.normalizeCaptureSize(requestedSizeTier);
        if (CameraConstants.SIZE_TEXT.equals(tier)) {
            return textModeSensorTarget();
        }
        if (fromSdk) {
            if (tier == null) {
                return sdkMedium();
            }
            switch (tier) {
                case CameraConstants.SIZE_LOW:
                    return new Size(CameraConstants.SDK_WIDTH_SMALL, CameraConstants.SDK_HEIGHT_SMALL);
                case CameraConstants.SIZE_HIGH:
                    return new Size(CameraConstants.SDK_WIDTH_LARGE, CameraConstants.SDK_HEIGHT_LARGE);
                case CameraConstants.SIZE_MEDIUM:
                default:
                    return sdkMedium();
            }
        }

        if (tier == null) {
            return buttonMedium();
        }
        switch (tier) {
            case CameraConstants.SIZE_LOW:
                return new Size(CameraConstants.BUTTON_WIDTH_SMALL, CameraConstants.BUTTON_HEIGHT_SMALL);
            case CameraConstants.SIZE_HIGH:
                return new Size(CameraConstants.BUTTON_WIDTH_LARGE, CameraConstants.BUTTON_HEIGHT_LARGE);
            case CameraConstants.SIZE_MEDIUM:
            default:
                return buttonMedium();
        }
    }

    /** Sensor JPEG target for text mode — owned by {@link AsgConstants}. */
    public static Size textModeSensorTarget() {
        return new Size(
                AsgConstants.TEXT_MODE_SENSOR_CAPTURE_WIDTH,
                AsgConstants.TEXT_MODE_SENSOR_CAPTURE_HEIGHT);
    }

    private static Size sdkMedium() {
        return new Size(CameraConstants.SDK_WIDTH_MEDIUM, CameraConstants.SDK_HEIGHT_MEDIUM);
    }

    private static Size buttonMedium() {
        return new Size(CameraConstants.BUTTON_WIDTH_MEDIUM, CameraConstants.BUTTON_HEIGHT_MEDIUM);
    }
}
