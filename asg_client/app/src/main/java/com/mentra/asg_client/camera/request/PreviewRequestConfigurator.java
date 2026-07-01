package com.mentra.asg_client.camera.request;

import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.MeteringRectangle;
import android.util.Log;
import android.util.Range;
import android.util.Size;

import com.mentra.asg_client.camera.CameraSettings;
import com.mentra.asg_client.camera.policy.EisController;
import com.mentra.asg_client.camera.policy.MeteringRegions;

/**
 * Applies shared preview / record {@link CaptureRequest} tuning (AE, AF, metering, JPEG preview hints).
 */
public final class PreviewRequestConfigurator {

    private static final String TAG = "CameraNeo";

    private PreviewRequestConfigurator() {}

    public static void configure(
            CaptureRequest.Builder previewBuilder,
            boolean forVideo,
            int videoFps,
            boolean eisEnabled,
            Range<Integer> selectedFpsRange,
            boolean hasAutoFocus,
            int userExposureCompensation,
            Size sizeForMetering,
            int photoJpegQuality,
            int jpegOrientation,
            CameraSettings cameraSettings) {
        previewBuilder.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
        previewBuilder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);

        if (forVideo) {
            Range<Integer> videoFpsRange = Range.create(videoFps, videoFps);
            previewBuilder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, videoFpsRange);
            Log.d(TAG, "Video: Using fixed FPS range " + videoFpsRange + " for consistent frame rate");
        } else {
            previewBuilder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, selectedFpsRange);
            Log.d(TAG, "Photo: Using dynamic FPS range " + selectedFpsRange + " for exposure flexibility");
        }

        if (forVideo && eisEnabled) {
            EisController.configure(previewBuilder, true);
            Log.d(TAG, "📹 EIS applied to video capture request");
        } else if (forVideo) {
            Log.d(TAG, "📹 EIS disabled for video");
        }

        if (forVideo && cameraSettings != null) {
            cameraSettings.configure3DNR(previewBuilder);
        }

        previewBuilder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, userExposureCompensation);

        previewBuilder.set(CaptureRequest.CONTROL_AE_REGIONS,
                MeteringRegions.fullImage(sizeForMetering));

        if (hasAutoFocus) {
            previewBuilder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            MeteringRectangle[] afRegions = MeteringRegions.centerWeighted(sizeForMetering);
            previewBuilder.set(CaptureRequest.CONTROL_AF_REGIONS, afRegions);
            if (afRegions != null && afRegions.length > 0) {
                MeteringRectangle r = afRegions[0];
                Log.d(TAG, "AF region set to center area: " + r.getX() + "," + r.getY()
                        + " -> " + (r.getX() + r.getWidth()) + "," + (r.getY() + r.getHeight()));
            }
        } else {
            Log.d(TAG, "Autofocus not available, using fixed focus");
        }

        previewBuilder.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);

        previewBuilder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
        previewBuilder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);

        if (!forVideo) {
            previewBuilder.set(CaptureRequest.JPEG_QUALITY, (byte) photoJpegQuality);
            previewBuilder.set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation);
            Log.d(TAG, "Setting JPEG orientation: " + jpegOrientation);

            if (cameraSettings != null && cameraSettings.isZslSupported()) {
                cameraSettings.configurePreviewBuilder(previewBuilder);
            }
        }
    }
}
