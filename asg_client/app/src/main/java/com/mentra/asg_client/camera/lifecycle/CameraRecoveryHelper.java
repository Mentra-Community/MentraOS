package com.mentra.asg_client.camera.lifecycle;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.function.Consumer;
import java.util.function.Supplier;

/** Best-effort recovery when Camera2 open fails (policy disabled, in-use, etc.). */
public final class CameraRecoveryHelper {

    private static final String TAG = "CameraNeo";

    private CameraRecoveryHelper() {}

    /**
     * Matches historical {@code CameraNeoService.releaseCameraResources}: full {@code closeCamera()} plus an
     * extra {@code closeDeviceAndSession} nudge on Android P+.
     */
    public static void releaseCameraResources(
            Runnable closeCamera,
            Runnable closeDeviceAndSession,
            Context context) {
        try {
            closeCamera.run();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
                if (manager != null) {
                    closeDeviceAndSession.run();
                    System.gc();
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error releasing camera resources", e);
        }
    }

    public static void restartCameraServiceIfNeeded(
            Runnable releaseCameraResources,
            Context context,
            Supplier<String> cameraIdGetter,
            Consumer<String> cameraIdSetter,
            Runnable wakeUpScreen,
            Runnable closeDeviceAndSessionOnly) {
        try {
            releaseCameraResources.run();

            Log.d(TAG, "Camera service restart attempt made - waiting for system to release camera");

            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                Log.d(TAG, "Attempting camera restart with delayed retry");

                CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
                if (manager != null) {
                    try {
                        String[] cameraIds = manager.getCameraIdList();
                        if (cameraIds.length > 1 && "0".equals(cameraIdGetter.get())) {
                            cameraIdSetter.accept("1");
                            Log.d(TAG, "Switching to alternate camera ID: " + cameraIdGetter.get());
                        }
                    } catch (CameraAccessException e) {
                        Log.e(TAG, "Error accessing camera during retry", e);
                    }
                }

                wakeUpScreen.run();
                closeDeviceAndSessionOnly.run();
                System.gc();
            }, 1000);
        } catch (Exception e) {
            Log.e(TAG, "Error in camera service restart", e);
        }
    }
}
