package com.mentra.asg_client.camera.policy;

import android.util.Size;

import com.mentra.asg_client.camera.CameraConstants;

/** Resolves requested photo source/size tier to target JPEG dimensions. */
public final class PhotoResolutionPolicy {

    private PhotoResolutionPolicy() {}

    public static Size targetSize(boolean fromSdk, String requestedSizeTier) {
        if (fromSdk) {
            if (requestedSizeTier == null) {
                return sdkMedium();
            }
            switch (requestedSizeTier) {
                case CameraConstants.SIZE_SMALL:
                    return new Size(CameraConstants.SDK_WIDTH_SMALL, CameraConstants.SDK_HEIGHT_SMALL);
                case CameraConstants.SIZE_LARGE:
                    return new Size(CameraConstants.SDK_WIDTH_LARGE, CameraConstants.SDK_HEIGHT_LARGE);
                case CameraConstants.SIZE_FULL:
                    return new Size(CameraConstants.SDK_WIDTH_FULL, CameraConstants.SDK_HEIGHT_FULL);
                case CameraConstants.SIZE_MEDIUM:
                default:
                    return sdkMedium();
            }
        }

        if (requestedSizeTier == null) {
            return buttonMedium();
        }
        switch (requestedSizeTier) {
            case CameraConstants.SIZE_SMALL:
                return new Size(CameraConstants.BUTTON_WIDTH_SMALL, CameraConstants.BUTTON_HEIGHT_SMALL);
            case CameraConstants.SIZE_LARGE:
                return new Size(CameraConstants.BUTTON_WIDTH_LARGE, CameraConstants.BUTTON_HEIGHT_LARGE);
            case CameraConstants.SIZE_MEDIUM:
            default:
                return buttonMedium();
        }
    }

    private static Size sdkMedium() {
        return new Size(CameraConstants.SDK_WIDTH_MEDIUM, CameraConstants.SDK_HEIGHT_MEDIUM);
    }

    private static Size buttonMedium() {
        return new Size(CameraConstants.BUTTON_WIDTH_MEDIUM, CameraConstants.BUTTON_HEIGHT_MEDIUM);
    }
}
