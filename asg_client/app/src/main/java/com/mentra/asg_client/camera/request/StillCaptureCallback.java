package com.mentra.asg_client.camera.request;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.mentra.asg_client.camera.diagnostics.CameraDiagnosticsLog;
import com.mentra.asg_client.camera.policy.AeStateMachine;
import com.mentra.asg_client.io.media.core.BlePhotoTimingLog;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

/** One-shot still capture callback; image bytes are handled later by the JPEG ImageReader. */
public final class StillCaptureCallback extends CameraCaptureSession.CaptureCallback {

    public interface Hooks {
        void recordStillSensorTimestampNs(Long timestampNs);

        /** Wall-clock when HAL reported {@code onCaptureStarted}. */
        void recordStillHalStartedWallMs(long startedWallMs);

        /** Notify the request owner at the exact sensor-exposure-start boundary. */
        void notifyPhotoExposureStarted(long sensorTimestampNs, long estimatedExposureDurationNs);

        /** True when ImageReader already backfilled an estimated {@code still_hal_started}. */
        boolean stillHalStartedAlreadyLogged();

        /** True when ImageReader already wrote estimated shutter→JPEG phases. */
        boolean stillTimingFinalizedByImageReader();

        /** Wall-clock when HAL reported {@code onCaptureCompleted} (for ImageReader lag). */
        void recordStillCaptureCompletedWallMs(long completedWallMs);

        void recordCaptureMetadata(JSONObject captureMetadata);

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
    private final long shutterSubmittedWallMs;
    private final long estimatedExposureDurationNs;
    private volatile long captureStartedWallMs;

    public StillCaptureCallback(Hooks hooks) {
        this(hooks, 0L);
    }

    public StillCaptureCallback(Hooks hooks, long estimatedExposureDurationNs) {
        this.hooks = hooks;
        this.shutterSubmittedWallMs = System.currentTimeMillis();
        this.estimatedExposureDurationNs = Math.max(0L, estimatedExposureDurationNs);
    }

    private static void putIfNotNull(JSONObject json, String key, Object value)
            throws JSONException {
        if (value != null) {
            json.put(key, value);
        }
    }

    @Override
    public void onCaptureStarted(
            @NonNull CameraCaptureSession session,
            @NonNull CaptureRequest request,
            long timestamp,
            long frameNumber) {
        captureStartedWallMs = System.currentTimeMillis();
        boolean alreadyLogged = hooks.stillHalStartedAlreadyLogged();
        hooks.recordStillHalStartedWallMs(captureStartedWallMs);
        hooks.notifyPhotoExposureStarted(timestamp, estimatedExposureDurationNs);
        long submitToStartMs = captureStartedWallMs - shutterSubmittedWallMs;
        Long reqExpNs = request.get(CaptureRequest.SENSOR_EXPOSURE_TIME);
        Integer reqIso = request.get(CaptureRequest.SENSOR_SENSITIVITY);
        Boolean reqZsl = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
        Integer reqAeMode = request.get(CaptureRequest.CONTROL_AE_MODE);
        boolean manual = reqAeMode != null && reqAeMode == CaptureRequest.CONTROL_AE_MODE_OFF;
        String detail =
                String.format(
                        Locale.US,
                        "frame=#%d; submit→HAL_start=%dms (queue/schedule); mode=%s; req_exp=%s;"
                                + " req_iso=%s; zsl=%s; sensor_ts_ns=%d",
                        frameNumber,
                        submitToStartMs,
                        manual ? "MANUAL" : "AUTO",
                        formatExposureMs(reqExpNs),
                        reqIso != null ? reqIso.toString() : "ae",
                        String.valueOf(reqZsl),
                        timestamp);
        // Skip phase row if ImageReader already backfilled an ESTIMATED start (avoids dup keys).
        if (!alreadyLogged) {
            BlePhotoTimingLog.capturePhase("still_hal_started", detail);
        } else {
            Log.i(TAG, "Still capture started (HAL, phase already estimated): " + detail);
        }
        Log.i(
                TAG,
                "Still capture started (HAL): frame=#"
                        + frameNumber
                        + " submit→start="
                        + submitToStartMs
                        + "ms");
    }

    @Override
    public void onCaptureProgressed(
            @NonNull CameraCaptureSession session,
            @NonNull CaptureRequest request,
            @NonNull CaptureResult partialResult) {
        Integer aeState = partialResult.get(CaptureResult.CONTROL_AE_STATE);
        Integer iso = partialResult.get(CaptureResult.SENSOR_SENSITIVITY);
        Long expNs = partialResult.get(CaptureResult.SENSOR_EXPOSURE_TIME);
        long sinceSubmitMs = System.currentTimeMillis() - shutterSubmittedWallMs;
        Log.i(
                TAG,
                "Still capture progressed (HAL): +"
                        + sinceSubmitMs
                        + "ms since submit; ae="
                        + AeStateMachine.getAeStateName(aeState)
                        + " iso="
                        + iso
                        + " exp="
                        + formatExposureMs(expNs));
    }

    @Override
    public void onCaptureCompleted(
            @NonNull CameraCaptureSession session,
            @NonNull CaptureRequest request,
            @NonNull TotalCaptureResult result) {
        long completedWallMs = System.currentTimeMillis();
        hooks.recordStillCaptureCompletedWallMs(completedWallMs);
        Log.i(TAG, "Photo capture completed successfully");

        Boolean zslInRequest = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
        if (zslInRequest != null && zslInRequest) {
            Log.d(TAG, "✓ ZSL confirmed active in capture result");
        }

        Integer captureIso = result.get(CaptureResult.SENSOR_SENSITIVITY);
        Long captureExposureNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
        Integer captureNrMode = result.get(CaptureResult.NOISE_REDUCTION_MODE);
        Integer captureAeMode = result.get(CaptureResult.CONTROL_AE_MODE);
        Integer captureAeState = result.get(CaptureResult.CONTROL_AE_STATE);
        Integer captureEdgeMode = result.get(CaptureResult.EDGE_MODE);
        Long captureFrameDurationNs = result.get(CaptureResult.SENSOR_FRAME_DURATION);
        double captureExposureMs =
                (captureExposureNs != null) ? captureExposureNs / 1_000_000.0 : -1;
        boolean mfnrLikelyTriggered = (captureIso != null && captureIso > 800);
        Log.i(
                TAG,
                "MFNR_DIAG: ISO="
                        + captureIso
                        + " exposure="
                        + String.format(Locale.US, "%.2f", captureExposureMs)
                        + "ms"
                        + " NR_MODE="
                        + captureNrMode
                        + " MFNR_likely="
                        + mfnrLikelyTriggered);

        Long stillSensorTs = null;
        try {
            stillSensorTs = result.get(CaptureResult.SENSOR_TIMESTAMP);
            hooks.recordStillSensorTimestampNs(stillSensorTs);
            CameraDiagnosticsLog.stillCaptureSensorTimestamp(
                    stillSensorTs, captureExposureMs, captureIso);
        } catch (Throwable t) {
            // Never let logging crash capture.
        }

        Long reqExp2 = request.get(CaptureRequest.SENSOR_EXPOSURE_TIME);
        Integer reqIso2 = request.get(CaptureRequest.SENSOR_SENSITIVITY);
        Integer reqAeMode2 = request.get(CaptureRequest.CONTROL_AE_MODE);
        Integer reqNrMode2 = request.get(CaptureRequest.NOISE_REDUCTION_MODE);
        Integer reqEdgeMode2 = request.get(CaptureRequest.EDGE_MODE);
        Boolean reqZsl2 = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
        boolean isManualAttempt =
                (reqAeMode2 != null && reqAeMode2 == CaptureRequest.CONTROL_AE_MODE_OFF);
        double totalLightProxy = -1;
        if (captureExposureNs != null && captureIso != null) {
            totalLightProxy = (captureExposureNs / 1_000_000.0) * captureIso.doubleValue();
        }
        double xyCam2TotalLight = -1;
        if (reqExp2 != null) {
            xyCam2TotalLight = (reqExp2 / 1_000_000.0) * 400.0;
        }

        long submitToCompleteMs = completedWallMs - shutterSubmittedWallMs;
        long startToCompleteMs =
                captureStartedWallMs > 0 ? completedWallMs - captureStartedWallMs : -1L;
        long sensorExposureBudgetMs =
                captureExposureNs != null ? Math.round(captureExposureNs / 1_000_000.0) : -1L;
        long ispAfterExposureMs =
                startToCompleteMs >= 0 && sensorExposureBudgetMs >= 0
                        ? Math.max(0L, startToCompleteMs - sensorExposureBudgetMs)
                        : -1L;
        String bottleneckHint;
        if (startToCompleteMs < 0) {
            bottleneckHint = "no onCaptureStarted";
        } else if (sensorExposureBudgetMs > 0 && startToCompleteMs > sensorExposureBudgetMs * 2) {
            bottleneckHint =
                    "HAL/ISP (beyond exposure) ~"
                            + ispAfterExposureMs
                            + "ms — likely JPEG encode / NR / MFNR";
        } else if (sensorExposureBudgetMs > 50) {
            bottleneckHint = "long sensor exposure (" + sensorExposureBudgetMs + "ms)";
        } else {
            bottleneckHint = "HAL processing ~" + startToCompleteMs + "ms";
        }

        String completedDetail =
                String.format(
                        Locale.US,
                        "exp=%.2fms iso=%s nr=%s ae=%s/%s zsl=%s mfnr_likely=%s;"
                                + " submit→complete=%dms; HAL_start→complete=%dms;"
                                + " exposure_budget=%dms; isp_after_exposure≈%sms; bottleneck=%s",
                        captureExposureMs,
                        captureIso != null ? captureIso.toString() : "?",
                        captureNrMode != null ? captureNrMode.toString() : "?",
                        captureAeMode != null ? captureAeMode.toString() : "?",
                        AeStateMachine.getAeStateName(captureAeState),
                        String.valueOf(reqZsl2),
                        mfnrLikelyTriggered,
                        submitToCompleteMs,
                        startToCompleteMs,
                        sensorExposureBudgetMs,
                        ispAfterExposureMs >= 0 ? Long.toString(ispAfterExposureMs) : "?",
                        bottleneckHint);
        // If ImageReader already emitted estimated shutter→JPEG phases, keep metadata/logging
        // but don't insert a late still_hal_completed row that lands after storage steps.
        if (!hooks.stillTimingFinalizedByImageReader()) {
            BlePhotoTimingLog.capturePhase("still_hal_completed", completedDetail);
        } else {
            Log.i(
                    TAG,
                    "Still capture completed (HAL, phase already estimated): " + completedDetail);
        }

        try {
            CameraDiagnosticsLog.stillCaptureCompletedHalVsRequested(
                    isManualAttempt,
                    reqExp2,
                    captureExposureNs,
                    reqExp2 != null
                            && captureExposureNs != null
                            && reqExp2.equals(captureExposureNs),
                    reqIso2,
                    captureIso,
                    reqIso2 != null && captureIso != null && reqIso2.equals(captureIso),
                    reqAeMode2,
                    captureAeMode,
                    captureAeState,
                    reqNrMode2,
                    captureNrMode,
                    reqEdgeMode2,
                    captureEdgeMode,
                    reqZsl2,
                    captureFrameDurationNs,
                    totalLightProxy,
                    xyCam2TotalLight);
        } catch (Throwable t) {
            // Never let logging crash capture.
        }

        try {
            JSONObject captureMetadata = new JSONObject();
            captureMetadata.put("manual", isManualAttempt);
            putIfNotNull(captureMetadata, "exposureTimeNs", captureExposureNs);
            putIfNotNull(captureMetadata, "iso", captureIso);
            putIfNotNull(captureMetadata, "frameDurationNs", captureFrameDurationNs);
            putIfNotNull(captureMetadata, "aeMode", captureAeMode);
            putIfNotNull(captureMetadata, "aeState", captureAeState);
            if (captureAeState != null) {
                captureMetadata.put("aeStateName", AeStateMachine.getAeStateName(captureAeState));
            }
            putIfNotNull(captureMetadata, "noiseReductionMode", captureNrMode);
            putIfNotNull(captureMetadata, "edgeMode", captureEdgeMode);
            putIfNotNull(captureMetadata, "zsl", reqZsl2);
            putIfNotNull(captureMetadata, "sensorTimestampNs", stillSensorTs);
            if (totalLightProxy >= 0) {
                captureMetadata.put("totalLightProxy", totalLightProxy);
            }
            captureMetadata.put("mfnrLikely", mfnrLikelyTriggered);
            putIfNotNull(captureMetadata, "submitToCompleteMs", submitToCompleteMs);
            if (startToCompleteMs >= 0) {
                captureMetadata.put("halStartToCompleteMs", startToCompleteMs);
            }
            if (ispAfterExposureMs >= 0) {
                captureMetadata.put("ispAfterExposureMs", ispAfterExposureMs);
            }
            hooks.recordCaptureMetadata(captureMetadata);
        } catch (Throwable t) {
            Log.w(TAG, "Failed to build still capture metadata", t);
        }

        hooks.restorePreview(session);
    }

    @Override
    public void onCaptureFailed(
            @NonNull CameraCaptureSession session,
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

    private static String formatExposureMs(@Nullable Long exposureNs) {
        if (exposureNs == null) {
            return "ae";
        }
        return String.format(Locale.US, "%.2fms", exposureNs / 1_000_000.0);
    }
}
