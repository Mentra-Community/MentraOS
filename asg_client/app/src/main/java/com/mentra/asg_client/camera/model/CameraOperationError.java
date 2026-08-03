package com.mentra.asg_client.camera.model;

import android.hardware.camera2.CameraDevice;
import androidx.annotation.NonNull;

/** Structured camera failure carried from Camera2 callbacks to SDK responses. */
public final class CameraOperationError {
    public static final String CAMERA_CAPTURE_FAILED = "CAMERA_CAPTURE_FAILED";
    public static final String CAMERA_WARM_UP_FAILED = "camera_warm_up_failed";

    private final String code;
    private final String message;

    public CameraOperationError(@NonNull String code, @NonNull String message) {
        this.code = code;
        this.message = message;
    }

    @NonNull
    public String code() {
        return code;
    }

    @NonNull
    public String message() {
        return message;
    }

    public static CameraOperationError captureFailed(@NonNull String message) {
        return new CameraOperationError(CAMERA_CAPTURE_FAILED, message);
    }

    public static CameraOperationError warmUpFailed(@NonNull String message) {
        return new CameraOperationError(CAMERA_WARM_UP_FAILED, message);
    }

    public static CameraOperationError warmUpCancelled() {
        return new CameraOperationError(
                "camera_warm_up_cancelled", "Camera warm-up was cancelled by its owner.");
    }

    public static CameraOperationError cameraBusy() {
        return new CameraOperationError(
                "camera_busy", "Camera is busy with another operation. Wait and try again.");
    }

    public static CameraOperationError fromCameraDeviceError(int error) {
        switch (error) {
            case CameraDevice.StateCallback.ERROR_CAMERA_IN_USE:
                return new CameraOperationError(
                        "CAMERA_IN_USE", "Camera is already in use. Wait and try again.");
            case CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE:
                return new CameraOperationError(
                        "MAX_CAMERAS_IN_USE",
                        "Another camera operation is active. Wait and try again.");
            case CameraDevice.StateCallback.ERROR_CAMERA_DISABLED:
                return new CameraOperationError(
                        "CAMERA_DISABLED", "Camera access is disabled by the system.");
            case CameraDevice.StateCallback.ERROR_CAMERA_DEVICE:
                return new CameraOperationError(
                        "CAMERA_DEVICE_ERROR",
                        "Camera hardware was not ready. Wait a few seconds and try again.");
            case CameraDevice.StateCallback.ERROR_CAMERA_SERVICE:
                return new CameraOperationError(
                        "CAMERA_SERVICE_ERROR",
                        "Camera service failed. Restart the glasses if the problem continues.");
            default:
                return new CameraOperationError(
                        "CAMERA_DEVICE_ERROR",
                        "Camera failed with an unknown device error (Android code "
                                + error
                                + "). Try again.");
        }
    }
}
