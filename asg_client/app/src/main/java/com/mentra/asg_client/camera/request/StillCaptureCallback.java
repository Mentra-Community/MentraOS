package com.mentra.asg_client.camera.request;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.util.Log;

import androidx.annotation.NonNull;

import com.mentra.asg_client.camera.diagnostics.CameraDiagnosticsLog;
import com.mentra.asg_client.camera.policy.AeStateMachine;

/** One-shot still capture callback; image bytes are handled later by the JPEG ImageReader. */
public final class StillCaptureCallback extends CameraCaptureSession.CaptureCallback {

    public interface Hooks {
        void recordStillSensorTimestampNs(Long timestampNs);

        void restorePreview(CameraCaptureSession session);

        void notifyPhotoError(String errorMessage);

        void cancelImuRecording();

        void setShotState(AeStateMachine.ShotState shotState);

        void clearAeWaitFlags();

        void cancelKeepAliveTimer();

        void closeCamera();

        void stopSelf();
    }

    private static final String TAG = "CameraNeo";

    private final Hooks hooks;

    public StillCaptureCallback(Hooks hooks) {
        this.hooks = hooks;
    }

    @Override
    public void onCaptureCompleted(@NonNull CameraCaptureSession session,
                                   @NonNull CaptureRequest request,
                                   @NonNull TotalCaptureResult result) {
        Log.i(TAG, "Photo capture completed successfully");

        Boolean zslInRequest = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
        if (zslInRequest != null && zslInRequest) {
            Log.d(TAG, "✓ ZSL confirmed active in capture result");
        }

        Integer captureIso = result.get(CaptureResult.SENSOR_SENSITIVITY);
        Long captureExposureNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
        Integer captureNrMode = result.get(CaptureResult.NOISE_REDUCTION_MODE);
        double captureExposureMs = (captureExposureNs != null) ? captureExposureNs / 1_000_000.0 : -1;
        boolean mfnrLikelyTriggered = (captureIso != null && captureIso > 800);
        Log.i(TAG, "MFNR_DIAG: ISO=" + captureIso
                + " exposure=" + String.format("%.2f", captureExposureMs) + "ms"
                + " NR_MODE=" + captureNrMode
                + " MFNR_likely=" + mfnrLikelyTriggered);

        try {
            Long stillSensorTs = result.get(CaptureResult.SENSOR_TIMESTAMP);
            hooks.recordStillSensorTimestampNs(stillSensorTs);
            CameraDiagnosticsLog.stillCaptureSensorTimestamp(stillSensorTs, captureExposureMs, captureIso);
        } catch (Throwable t) {
            // Never let logging crash capture.
        }

        try {
            Long reqExp2 = request.get(CaptureRequest.SENSOR_EXPOSURE_TIME);
            Integer reqIso2 = request.get(CaptureRequest.SENSOR_SENSITIVITY);
            Integer reqAeMode2 = request.get(CaptureRequest.CONTROL_AE_MODE);
            Integer reqNrMode2 = request.get(CaptureRequest.NOISE_REDUCTION_MODE);
            Integer reqEdgeMode2 = request.get(CaptureRequest.EDGE_MODE);
            Boolean reqZsl2 = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            Integer resAeMode = result.get(CaptureResult.CONTROL_AE_MODE);
            Integer resAeState = result.get(CaptureResult.CONTROL_AE_STATE);
            Integer resEdgeMode = result.get(CaptureResult.EDGE_MODE);
            Long resFrameDur = result.get(CaptureResult.SENSOR_FRAME_DURATION);
            boolean isManualAttempt = (reqAeMode2 != null && reqAeMode2 == CaptureRequest.CONTROL_AE_MODE_OFF);
            double totalLightProxy = -1;
            if (captureExposureNs != null && captureIso != null) {
                totalLightProxy = (captureExposureNs / 1_000_000.0) * captureIso.doubleValue();
            }
            double xyCam2TotalLight = -1;
            if (reqExp2 != null) {
                xyCam2TotalLight = (reqExp2 / 1_000_000.0) * 400.0;
            }
            CameraDiagnosticsLog.stillCaptureCompletedHalVsRequested(
                    isManualAttempt,
                    reqExp2,
                    captureExposureNs,
                    reqExp2 != null && captureExposureNs != null && reqExp2.equals(captureExposureNs),
                    reqIso2,
                    captureIso,
                    reqIso2 != null && captureIso != null && reqIso2.equals(captureIso),
                    reqAeMode2,
                    resAeMode,
                    resAeState,
                    reqNrMode2,
                    captureNrMode,
                    reqEdgeMode2,
                    resEdgeMode,
                    reqZsl2,
                    resFrameDur,
                    totalLightProxy,
                    xyCam2TotalLight);
        } catch (Throwable t) {
            // Never let logging crash capture.
        }

        hooks.restorePreview(session);
    }

    @Override
    public void onCaptureFailed(@NonNull CameraCaptureSession session,
                                @NonNull CaptureRequest request,
                                @NonNull CaptureFailure failure) {
        Log.e(TAG, "Photo capture failed: " + failure.getReason());
        hooks.notifyPhotoError("Photo capture failed: " + failure.getReason());
        hooks.cancelImuRecording();
        hooks.restorePreview(session);
        hooks.setShotState(AeStateMachine.ShotState.IDLE);
        hooks.clearAeWaitFlags();
        hooks.cancelKeepAliveTimer();
        hooks.closeCamera();
        hooks.stopSelf();
    }
}
