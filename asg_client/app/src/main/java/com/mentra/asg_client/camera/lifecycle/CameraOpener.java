package com.mentra.asg_client.camera.lifecycle;

import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaRecorder;
import android.util.Log;
import android.util.Size;

import com.mentra.asg_client.settings.VideoSettings;

import com.mentra.asg_client.camera.policy.CameraSizeSelector;
import com.mentra.asg_client.camera.policy.PhotoResolutionPolicy;

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
        if (pendingSettings != null && pendingSettings.isValid()) {
            targetVideoWidth = pendingSettings.width;
            targetVideoHeight = pendingSettings.height;
            Log.i(TAG, "📹 Using CUSTOM video settings from command: " + pendingSettings);
        } else {
            targetVideoWidth = 1920;
            targetVideoHeight = 1080;
            Log.i(TAG, "📹 Using DEFAULT video settings: 1920x1080@30fps (no custom settings provided)");
        }
        Log.i(TAG, "📹 TARGET resolution: " + targetVideoWidth + "x" + targetVideoHeight);
        Size chosenVideoSize = CameraSizeSelector.chooseOptimalSize(videoSizes, targetVideoWidth, targetVideoHeight);
        if (chosenVideoSize == null) {
            Log.e(TAG, "chooseOptimalSize returned null for video, falling back to first available size");
            chosenVideoSize = videoSizes[0];
        }
        Log.i(TAG, "📹 SELECTED resolution: " + chosenVideoSize.getWidth() + "x" + chosenVideoSize.getHeight());
        if (chosenVideoSize.getWidth() != targetVideoWidth || chosenVideoSize.getHeight() != targetVideoHeight) {
            Log.w(TAG, "⚠️ VIDEO RESOLUTION MISMATCH: Requested " + targetVideoWidth + "x" + targetVideoHeight +
                    " but got " + chosenVideoSize.getWidth() + "x" + chosenVideoSize.getHeight() +
                    " - camera may not support requested resolution for MediaRecorder");
        }
        return chosenVideoSize;
    }

    public static Size resolveJpegSize(Size[] jpegSizes, boolean fromSdk, String requestedSizeTier) {
        if (jpegSizes == null || jpegSizes.length == 0) {
            return null;
        }
        Size targetPhotoSize = PhotoResolutionPolicy.targetSize(fromSdk, requestedSizeTier);
        Size jpegSize = CameraSizeSelector.chooseOptimalSize(
                jpegSizes, targetPhotoSize.getWidth(), targetPhotoSize.getHeight());
        if (jpegSize == null) {
            Log.e(TAG, "chooseOptimalSize returned null for JPEG, falling back to first available size");
            jpegSize = jpegSizes[0];
        }
        Log.d(TAG, "Selected JPEG size: " + jpegSize.getWidth() + "x" + jpegSize.getHeight() +
                " (requested: " + targetPhotoSize.getWidth() + "x" + targetPhotoSize.getHeight()
                + ", isFromSdk: " + fromSdk + ")");
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
