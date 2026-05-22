package com.mentra.asg_client.camera.request;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.util.Log;

import androidx.annotation.NonNull;

import com.mentra.asg_client.camera.policy.AeStateMachine;

/** Repeating-request AE callback for the XyCamera2-style photo capture pipeline. */
public final class AeCaptureCallback extends CameraCaptureSession.CaptureCallback {

    public interface Hooks {
        AeStateMachine.ShotState shotState();

        void setShotState(AeStateMachine.ShotState shotState);

        void recordMeteredIso(Integer iso);

        void recordMeteredExposureNs(Long exposureNs);

        void postDelayed(Runnable runnable, long delayMs);

        void requestAeLock(CameraCaptureSession session);

        void capturePhoto();

        void notifyPhotoError(String errorMessage);

        void cancelKeepAliveTimer();

        void closeCamera();

        void stopSelf();
    }

    private static final String TAG = "CameraNeo";

    private final AeStateMachine aeStateMachine;
    private final Hooks hooks;
    private int callbackCount;

    public AeCaptureCallback(AeStateMachine aeStateMachine, Hooks hooks) {
        this.aeStateMachine = aeStateMachine;
        this.hooks = hooks;
    }

    @Override
    public void onCaptureCompleted(@NonNull CameraCaptureSession session,
                                   @NonNull CaptureRequest request,
                                   @NonNull TotalCaptureResult result) {
        callbackCount++;

        Integer sensEarly = result.get(CaptureResult.SENSOR_SENSITIVITY);
        if (sensEarly != null && sensEarly > 0) {
            hooks.recordMeteredIso(sensEarly);
        }
        Long exposureEarly = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
        if (exposureEarly != null && exposureEarly > 0) {
            hooks.recordMeteredExposureNs(exposureEarly);
        }

        if (callbackCount <= 10 || callbackCount % 30 == 0) {
            Log.d(TAG, "🔍 AE callback #" + callbackCount + " | Shot state: " + hooks.shotState()
                    + " | Waiting: " + aeStateMachine.waitingForAeConvergence()
                    + " | LockRequested: " + aeStateMachine.aeLockRequested());
        }

        if (!aeStateMachine.waitingForAeConvergence()) {
            return;
        }

        Integer aeState = result.get(CaptureResult.CONTROL_AE_STATE);
        Integer precaptureTrigger = request.get(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER);
        Boolean zslInRequest = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);

        if (callbackCount <= 5) {
            Log.d(TAG, "🔍 Request details - ZSL: " + zslInRequest + ", Precapture trigger: "
                    + precaptureTrigger + ", AE state: " + AeStateMachine.getAeStateName(aeState));
        }

        long elapsedNs = aeStateMachine.elapsedNsSinceAeStart();
        AeStateMachine.AeRepeatCaptureDecision decision =
                AeStateMachine.evaluateRepeatingRequestAeStep(
                        aeStateMachine.waitingForAeConvergence(),
                        aeStateMachine.aeLockRequested(),
                        aeState,
                        elapsedNs);

        switch (decision) {
            case CONTINUE_WAITING_NULL_AE:
                Log.w(TAG, "AE_STATE is null in callback");
                if (callbackCount % 10 == 0) {
                    Log.w(TAG, "🔍 Still waiting for AE state... (callback #" + callbackCount + ")");
                }
                break;
            case CAPTURE_NOW_TIMEOUT: {
                long elapsedMs = elapsedNs / 1_000_000;
                Log.w(TAG, "🔍 ⚠️ AE CONVERGENCE TIMEOUT after " + elapsedMs + "ms (limit: "
                        + (AeStateMachine.AE_WAIT_MAX_NS / 1_000_000) + "ms), forcing capture");
                aeStateMachine.clearWaitFlags();
                hooks.capturePhoto();
                break;
            }
            case CAPTURE_NOW_LOCK_CONFIRMED: {
                long totalElapsedMs = elapsedNs / 1_000_000;
                Log.i(TAG, "🔍 ✅ AE LOCKED in " + totalElapsedMs + "ms total! State: "
                        + AeStateMachine.getAeStateName(aeState) + ", capturing photo");
                aeStateMachine.clearWaitFlags();
                hooks.capturePhoto();
                break;
            }
            case CONTINUE_WAITING_FOR_LOCK:
                if (callbackCount % 10 == 0) {
                    Log.d(TAG, "🔍 Waiting for AE lock... State: "
                            + AeStateMachine.getAeStateName(aeState));
                }
                break;
            case CAPTURE_AFTER_STABILIZATION_DELAY: {
                long elapsedMs = elapsedNs / 1_000_000;
                Log.i(TAG, "🔍 ✅ AE CONVERGED in " + elapsedMs + "ms! State: "
                        + AeStateMachine.getAeStateName(aeState) + ", waiting "
                        + AeStateMachine.EXPOSURE_STABILIZATION_DELAY_MS
                        + "ms for exposure stabilization [FAST MODE]");
                aeStateMachine.clearWaitFlags();
                hooks.postDelayed(() -> {
                    Log.i(TAG, "🔍 Exposure stabilization complete, capturing photo");
                    hooks.capturePhoto();
                }, AeStateMachine.EXPOSURE_STABILIZATION_DELAY_MS);
                break;
            }
            case REQUEST_AE_LOCK: {
                long elapsedMs = elapsedNs / 1_000_000;
                Log.i(TAG, "🔍 ✅ AE CONVERGED in " + elapsedMs + "ms! State: "
                        + AeStateMachine.getAeStateName(aeState)
                        + ", requesting AE lock [LEGACY MODE]");
                hooks.requestAeLock(session);
                break;
            }
            case CONTINUE_WAITING_FOR_CONVERGENCE:
                if (callbackCount % 10 == 0) {
                    Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
                    Long exposureTime = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                    Log.d(TAG, "🔍 Waiting for AE convergence... State: "
                            + AeStateMachine.getAeStateName(aeState)
                            + ", ISO: " + iso + ", Exposure: "
                            + (exposureTime != null ? exposureTime / 1_000_000.0 : "null") + "ms");
                }
                break;
            case IGNORE_NOT_WAITING:
                break;
        }
    }

    @Override
    public void onCaptureFailed(@NonNull CameraCaptureSession session,
                                @NonNull CaptureRequest request,
                                @NonNull CaptureFailure failure) {
        Boolean zslInRequest = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
        Integer precaptureTrigger = request.get(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER);
        Boolean aeLock = request.get(CaptureRequest.CONTROL_AE_LOCK);

        Log.e(TAG, "🔍 DIAGNOSTIC: Capture failed during AE sequence");
        Log.e(TAG, "🔍 Failure reason: " + failure.getReason());
        Log.e(TAG, "🔍 ZSL in request: " + zslInRequest);
        Log.e(TAG, "🔍 AE lock in request: " + aeLock);
        Log.e(TAG, "🔍 Precapture trigger in request: " + precaptureTrigger);
        Log.e(TAG, "🔍 Shot state: " + hooks.shotState());
        Log.e(TAG, "🔍 Waiting flags - AE convergence: " + aeStateMachine.waitingForAeConvergence()
                + ", Lock requested: " + aeStateMachine.aeLockRequested());
        Log.e(TAG, "🔍 Frame number: " + failure.getFrameNumber());
        Log.e(TAG, "🔍 Was image captured: " + failure.wasImageCaptured());

        if (hooks.shotState() == AeStateMachine.ShotState.SHOOTING) {
            Log.d(TAG, "🔍 Failure during SHOOTING state - likely from repeating request, ignoring");
            return;
        }

        hooks.notifyPhotoError("AE sequence failed: " + failure.getReason());
        hooks.setShotState(AeStateMachine.ShotState.IDLE);
        aeStateMachine.clearWaitFlags();
        hooks.cancelKeepAliveTimer();
        hooks.closeCamera();
        hooks.stopSelf();
    }
}
