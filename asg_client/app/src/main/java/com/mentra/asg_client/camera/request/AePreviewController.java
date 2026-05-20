package com.mentra.asg_client.camera.request;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureRequest;
import android.os.Handler;
import android.util.Log;

import com.mentra.asg_client.camera.CameraSettings;
import com.mentra.asg_client.camera.policy.AeStateMachine;

/** Applies AE lock/unlock updates to the repeating preview request. */
public final class AePreviewController {

    private static final String TAG = "CameraNeo";

    private AePreviewController() {}

    public static boolean requestAeLock(
            CameraCaptureSession session,
            boolean hasCameraDevice,
            CaptureRequest.Builder previewBuilder,
            CameraCaptureSession.CaptureCallback callback,
            Handler handler,
            CameraSettings cameraSettings,
            AeStateMachine aeStateMachine) {
        if (session == null || !hasCameraDevice || previewBuilder == null) {
            Log.w(TAG, "Cannot lock AE: session/camera is null");
            return false;
        }

        try {
            Log.d(TAG, "🔍 Requesting AE lock by updating repeating request");
            previewBuilder.set(CaptureRequest.CONTROL_AE_LOCK, true);

            if (cameraSettings != null && cameraSettings.isZslSupported()) {
                cameraSettings.configurePreviewBuilder(previewBuilder);
            }

            session.setRepeatingRequest(previewBuilder.build(), callback, handler);
            aeStateMachine.markAeLockRequested();
            Log.d(TAG, "🔍 AE lock requested via repeating request (CONTROL_AE_LOCK=true)");
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to lock AE: " + e.getMessage());
            aeStateMachine.clearWaitFlags();
            return false;
        }
    }

    /**
     * @param clearAeWaitFlags when {@code false}, skips {@link AeStateMachine#clearWaitFlags()} so a
     * late still/HDR completion cannot wipe AE wait state for a new precapture (WAITING_AE).
     */
    public static void restorePreview(
            CameraCaptureSession session,
            boolean hasCameraDevice,
            CaptureRequest.Builder previewBuilder,
            CameraCaptureSession.CaptureCallback callback,
            Handler handler,
            CameraSettings cameraSettings,
            AeStateMachine aeStateMachine,
            boolean clearAeWaitFlags) {
        try {
            if (session == null || !hasCameraDevice || previewBuilder == null) {
                Log.w(TAG, "Cannot restore preview: session/camera is null");
                return;
            }

            Log.d(TAG, "🔍 Restoring preview after capture (unlocking AE)");
            previewBuilder.set(CaptureRequest.CONTROL_AE_LOCK, false);
            if (clearAeWaitFlags) {
                aeStateMachine.clearWaitFlags();
            } else {
                Log.i(TAG, "🔍 Preserving AE wait flags during preview restore (precapture active)");
            }

            if (cameraSettings != null && cameraSettings.isZslSupported()) {
                cameraSettings.configurePreviewBuilder(previewBuilder);
            }

            session.setRepeatingRequest(previewBuilder.build(), callback, handler);
            Log.d(TAG, "🔍 Preview restored (AE unlocked, repeating request restarted)");
        } catch (Exception e) {
            Log.e(TAG, "Failed to restore preview: " + e.getMessage());
        }
    }
}
