package com.mentra.asg_client.camera.lifecycle;

import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaRecorder;
import android.util.Log;
import android.util.Size;
import com.mentra.asg_client.camera.CameraConstants;
import com.mentra.asg_client.camera.policy.CameraSizeSelector;
import com.mentra.asg_client.camera.policy.PhotoResolutionPolicy;
import com.mentra.asg_client.camera.policy.PhotoSizeTier;
import com.mentra.asg_client.settings.VideoSettings;

/** Camera id selection and output size resolution for {@link CameraNeoService}. */
public final class CameraOpener {

    private static final String TAG = "CameraNeo";

    private CameraOpener() {}

    public static String selectPrimaryCameraId(CameraManager manager) throws CameraAccessException {
        String[] cameraIds = manager.getCameraIdList();
        String chosenId = null;
        for (String id : cameraIds) {
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
            Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                chosenId = id;
                break;
            }
        }
        if (chosenId == null && cameraIds.length > 0) {
            chosenId = cameraIds[0];
            Log.d(TAG, "No back camera found, using camera ID: " + chosenId);
        }
        return chosenId;
    }

    public static Size resolveVideoSize(Size[] videoSizes, VideoSettings pendingSettings) {
        if (videoSizes == null || videoSizes.length == 0) {
            return null;
        }
        int targetVideoWidth;
        int targetVideoHeight;
        if (pendingSettings != null
                && pendingSettings.isValid()
                && containsSize(videoSizes, pendingSettings.width, pendingSettings.height)) {
            targetVideoWidth = pendingSettings.width;
            targetVideoHeight = pendingSettings.height;
            Log.i(TAG, "📹 Using CUSTOM video settings from command: " + pendingSettings);
        } else {
            // Either no custom settings, or the requested size isn't one the sensor
            // actually reports via getOutputSizes(). Handing MediaRecorder a size the
            // sensor can't encode wedges the camera in a stuck recording, so fall back
            // to the safe default instead of trusting the static whitelist alone.
            if (pendingSettings != null && pendingSettings.isValid()) {
                Log.w(
                        TAG,
                        "⚠️ Requested "
                                + pendingSettings.width
                                + "x"
                                + pendingSettings.height
                                + " is not in the sensor's getOutputSizes(); falling back to"
                                + " 1920x1080");
            }
            targetVideoWidth = 1920;
            targetVideoHeight = 1080;
            Log.i(
                    TAG,
                    "📹 Using DEFAULT video settings: 1920x1080@30fps (no custom settings"
                            + " provided)");
        }
        Log.i(TAG, "📹 TARGET resolution: " + targetVideoWidth + "x" + targetVideoHeight);
        Size chosenVideoSize =
                CameraSizeSelector.chooseOptimalSize(
                        videoSizes, targetVideoWidth, targetVideoHeight);
        if (chosenVideoSize == null) {
            Log.e(
                    TAG,
                    "chooseOptimalSize returned null for video, falling back to first available"
                            + " size");
            chosenVideoSize = videoSizes[0];
        }
        Log.i(
                TAG,
                "📹 SELECTED resolution: "
                        + chosenVideoSize.getWidth()
                        + "x"
                        + chosenVideoSize.getHeight());
        if (chosenVideoSize.getWidth() != targetVideoWidth
                || chosenVideoSize.getHeight() != targetVideoHeight) {
            Log.w(
                    TAG,
                    "⚠️ VIDEO RESOLUTION MISMATCH: Requested "
                            + targetVideoWidth
                            + "x"
                            + targetVideoHeight
                            + " but got "
                            + chosenVideoSize.getWidth()
                            + "x"
                            + chosenVideoSize.getHeight()
                            + " - camera may not support requested resolution for MediaRecorder");
        }
        return chosenVideoSize;
    }

    /** True iff the sensor reports an exact (width x height) output size. */
    private static boolean containsSize(Size[] sizes, int width, int height) {
        if (sizes == null) {
            return false;
        }
        for (Size s : sizes) {
            if (s.getWidth() == width && s.getHeight() == height) {
                return true;
            }
        }
        return false;
    }

    public static Size resolveJpegSize(
            Size[] jpegSizes, boolean fromSdk, String rawRequestedSizeTier) {
        if (jpegSizes == null || jpegSizes.length == 0) {
            return null;
        }
        String requestedSizeTier = PhotoSizeTier.normalizeCaptureSize(rawRequestedSizeTier);
        if (CameraConstants.SIZE_MAX.equals(requestedSizeTier)) {
            Size maxSize = CameraSizeSelector.largestSize(jpegSizes);
            if (maxSize == null) {
                maxSize = jpegSizes[0];
            }
            Log.d(
                    TAG,
                    "Selected MAX JPEG size: "
                            + maxSize.getWidth()
                            + "x"
                            + maxSize.getHeight()
                            + " (isFromSdk: "
                            + fromSdk
                            + ")");
            return maxSize;
        }
        Size targetPhotoSize = PhotoResolutionPolicy.targetSize(fromSdk, requestedSizeTier);
        Size jpegSize =
                CameraSizeSelector.chooseOptimalSize(
                        jpegSizes, targetPhotoSize.getWidth(), targetPhotoSize.getHeight());
        if (jpegSize == null) {
            Log.e(
                    TAG,
                    "chooseOptimalSize returned null for JPEG, falling back to first available"
                            + " size");
            jpegSize = jpegSizes[0];
        }
        Log.d(
                TAG,
                "Selected JPEG size: "
                        + jpegSize.getWidth()
                        + "x"
                        + jpegSize.getHeight()
                        + " (requested: "
                        + targetPhotoSize.getWidth()
                        + "x"
                        + targetPhotoSize.getHeight()
                        + ", isFromSdk: "
                        + fromSdk
                        + ")");
        return jpegSize;
    }

    public static StreamConfigurationMap streamMapOrNull(CameraCharacteristics characteristics) {
        return characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    }

    public static Size[] jpegOutputSizes(StreamConfigurationMap map) {
        return map != null ? map.getOutputSizes(ImageFormat.JPEG) : null;
    }

    public static Size[] videoOutputSizes(StreamConfigurationMap map) {
        return map != null ? map.getOutputSizes(MediaRecorder.class) : null;
    }
}
