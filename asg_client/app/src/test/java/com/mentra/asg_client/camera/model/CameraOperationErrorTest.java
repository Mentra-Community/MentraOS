package com.mentra.asg_client.camera.model;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.CameraDevice;
import com.mentra.asg_client.camera.CameraNeoService;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.json.JSONObject;

public class CameraOperationErrorTest {

    @Test
    public void fromCameraDeviceError_mapsCameraInUse() {
        CameraOperationError error =
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_CAMERA_IN_USE);

        assertThat(error.code()).isEqualTo("CAMERA_IN_USE");
        assertThat(error.message()).isEqualTo("Camera is already in use. Wait and try again.");
    }

    @Test
    public void fromCameraDeviceError_mapsMaxCamerasInUse() {
        CameraOperationError error =
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE);

        assertThat(error.code()).isEqualTo("MAX_CAMERAS_IN_USE");
        assertThat(error.message())
                .isEqualTo("Another camera operation is active. Wait and try again.");
    }

    @Test
    public void fromCameraDeviceError_mapsCameraDisabled() {
        CameraOperationError error =
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_CAMERA_DISABLED);

        assertThat(error.code()).isEqualTo("CAMERA_DISABLED");
        assertThat(error.message()).isEqualTo("Camera access is disabled by the system.");
    }

    @Test
    public void fromCameraDeviceError_mapsCameraDeviceFailure() {
        CameraOperationError error =
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_CAMERA_DEVICE);

        assertThat(error.code()).isEqualTo("CAMERA_DEVICE_ERROR");
        assertThat(error.message())
                .isEqualTo("Camera hardware was not ready. Wait a few seconds and try again.");
    }

    @Test
    public void fromCameraDeviceError_mapsCameraServiceFailure() {
        CameraOperationError error =
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_CAMERA_SERVICE);

        assertThat(error.code()).isEqualTo("CAMERA_SERVICE_ERROR");
        assertThat(error.message())
                .isEqualTo("Camera service failed. Restart the glasses if the problem continues.");
    }

    @Test
    public void fromCameraDeviceError_preservesUnknownAndroidCodeInMessage() {
        CameraOperationError error = CameraOperationError.fromCameraDeviceError(99);

        assertThat(error.code()).isEqualTo("CAMERA_DEVICE_ERROR");
        assertThat(error.message()).contains("Android code 99");
    }

    @Test
    public void photoCallback_typedErrorDelegatesToLegacyStringContract() {
        AtomicReference<String> receivedMessage = new AtomicReference<>();
        CameraNeoService.PhotoCaptureCallback callback =
                new CameraNeoService.PhotoCaptureCallback() {
                    @Override
                    public void onPhotoCaptured(
                            String filePath, JSONObject captureMetadata) {}

                    @Override
                    public void onPhotoError(String errorMessage) {
                        receivedMessage.set(errorMessage);
                    }
                };

        callback.onPhotoError(
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_CAMERA_DEVICE));

        assertThat(receivedMessage.get())
                .isEqualTo(
                        "Camera hardware was not ready. Wait a few seconds and try again.");
    }

    @Test
    public void warmUpCallback_typedErrorDelegatesToLegacyStringContract() {
        AtomicReference<String> receivedMessage = new AtomicReference<>();
        CameraNeoService.CameraWarmUpCallback callback =
                new CameraNeoService.CameraWarmUpCallback() {
                    @Override
                    public void onWarming() {}

                    @Override
                    public void onCameraReady() {}

                    @Override
                    public void onCameraStopped() {}

                    @Override
                    public void onCameraError(String errorMessage) {
                        receivedMessage.set(errorMessage);
                    }
                };

        callback.onCameraError(
                CameraOperationError.fromCameraDeviceError(
                        CameraDevice.StateCallback.ERROR_CAMERA_SERVICE));

        assertThat(receivedMessage.get())
                .isEqualTo(
                        "Camera service failed. Restart the glasses if the problem continues.");
    }

    @Test
    public void warmUpCancelled_isTerminalAndMachineReadable() {
        CameraOperationError error = CameraOperationError.warmUpCancelled();

        assertThat(error.code()).isEqualTo("camera_warm_up_cancelled");
        assertThat(error.message()).contains("cancelled");
    }
}
