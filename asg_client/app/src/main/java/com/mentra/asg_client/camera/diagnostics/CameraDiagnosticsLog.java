package com.mentra.asg_client.camera.diagnostics;

import com.mentra.asg_client.camera.policy.ManualExposurePolicy;

/** Structured {@code MentraDbg} log lines for camera pipeline diagnostics (shape preserved for logcat parsers). */
public final class CameraDiagnosticsLog {

    private static final String TAG = "MentraDbg";

    private CameraDiagnosticsLog() {}

    public static void savedFrameTimestampVsStill(
            long imageTimestampNs, Long stillSensorTimestampNs, boolean timestampsMatch, long deltaMs) {
        android.util.Log.i(TAG,
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H6\",\"location\":\"CameraNeo:onImageAvailable:savedFrame\",\"timestamp\":" + System.currentTimeMillis()
                        + ",\"message\":\"saved frame timestamp vs still capture timestamp\",\"data\":{"
                        + "\"image_timestamp_ns\":" + imageTimestampNs
                        + ",\"still_SENSOR_TIMESTAMP_ns\":" + stillSensorTimestampNs
                        + ",\"timestamps_match\":" + timestampsMatch
                        + ",\"delta_ms_still_minus_image\":" + deltaMs
                        + "}}");
    }

    public static void manualExposureDecision(boolean decision, String reason, Long pendingExposureNs, boolean manualSupported) {
        android.util.Log.i(TAG,
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H0\",\"location\":\"CameraNeo:shouldUseManualExposure\",\"timestamp\":" + System.currentTimeMillis()
                        + ",\"message\":\"manual exposure decision\",\"data\":{"
                        + "\"decision\":" + decision
                        + ",\"reason\":\"" + reason + "\""
                        + ",\"pendingExposureTimeNs\":" + pendingExposureNs
                        + ",\"manualSensorSupported\":" + manualSupported
                        + "}}");
    }

    public static void manualIsoComputation(
            Integer meteredIso,
            Long meteredExposureNs,
            long targetExposureNs,
            double evScale,
            int isoBeforeScale,
            int isoAfterScale,
            int isoFinalClamped,
            Integer sensorIsoLow,
            Integer sensorIsoHigh) {
        android.util.Log.i(TAG,
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H1\",\"location\":\"CameraNeo:pickSensitivityForManualCapture\",\"timestamp\":" + System.currentTimeMillis()
                        + ",\"message\":\"manual ISO computation\",\"data\":{"
                        + "\"meteredIso\":" + meteredIso
                        + ",\"meteredExposureNs\":" + meteredExposureNs
                        + ",\"targetExposureNs\":" + targetExposureNs
                        + ",\"evScale\":" + String.format(java.util.Locale.US, "%.4f", evScale)
                        + ",\"isoBeforeScale\":" + isoBeforeScale
                        + ",\"isoAfterScale\":" + isoAfterScale
                        + ",\"isoFinalClamped\":" + isoFinalClamped
                        + ",\"sensorIsoLow\":" + sensorIsoLow
                        + ",\"sensorIsoHigh\":" + sensorIsoHigh
                        + ",\"xyCamera2WouldUseIso\":" + ManualExposurePolicy.DEFAULT_ISO
                        + "}}");
    }

    public static void stillRequestKeysBeforeCapture(
            boolean useManual,
            Long reqSensorExposureNs,
            Integer reqSensorSensitivity,
            Long reqSensorFrameDurationNs,
            Integer reqAeMode,
            Integer reqNrMode,
            Integer reqEdgeMode,
            Integer reqAfMode,
            Boolean reqZsl,
            Boolean reqAeLock,
            Integer reqExpComp,
            android.util.Range<Integer> reqFps) {
        android.util.Log.i(TAG,
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H1+H2+H3+H4\",\"location\":\"CameraNeo:capturePhoto:beforeCapture\",\"timestamp\":" + System.currentTimeMillis()
                        + ",\"message\":\"still request keys (what HAL will see)\",\"data\":{"
                        + "\"useManual\":" + useManual
                        + ",\"req_SENSOR_EXPOSURE_TIME_ns\":" + reqSensorExposureNs
                        + ",\"req_SENSOR_SENSITIVITY\":" + reqSensorSensitivity
                        + ",\"req_SENSOR_FRAME_DURATION_ns\":" + reqSensorFrameDurationNs
                        + ",\"req_CONTROL_AE_MODE\":" + reqAeMode
                        + ",\"req_NOISE_REDUCTION_MODE\":" + reqNrMode
                        + ",\"req_EDGE_MODE\":" + reqEdgeMode
                        + ",\"req_CONTROL_AF_MODE\":" + reqAfMode
                        + ",\"req_CONTROL_ENABLE_ZSL\":" + reqZsl
                        + ",\"req_CONTROL_AE_LOCK\":" + reqAeLock
                        + ",\"req_CONTROL_AE_EXPOSURE_COMPENSATION\":" + reqExpComp
                        + ",\"req_CONTROL_AE_TARGET_FPS_RANGE\":\"" + reqFps + "\""
                        + "}}");
    }

    public static void stillCaptureSensorTimestamp(Long stillSensorTs, double expMs, Integer iso) {
        android.util.Log.i(TAG,
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H6\",\"location\":\"CameraNeo:onCaptureCompleted:stillTs\",\"timestamp\":" + System.currentTimeMillis()
                        + ",\"message\":\"still capture sensor timestamp recorded\",\"data\":{"
                        + "\"still_SENSOR_TIMESTAMP_ns\":" + stillSensorTs
                        + ",\"exp_ms\":" + String.format(java.util.Locale.US, "%.2f", expMs)
                        + ",\"iso\":" + iso
                        + "}}");
    }

    public static void stillCaptureCompletedHalVsRequested(
            boolean isManualAttempt,
            Long reqExpNs,
            Long actualExpNs,
            boolean expMatch,
            Integer reqIso,
            Integer actualIso,
            boolean isoMatch,
            Integer reqAeMode,
            Integer actualAeMode,
            Integer actualAeState,
            Integer reqNrMode,
            Integer actualNrMode,
            Integer reqEdgeMode,
            Integer actualEdgeMode,
            Boolean reqZsl,
            Long actualFrameDurNs,
            double totalLightProxyActual,
            double totalLightProxyXy) {
        android.util.Log.i(TAG,
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H1+H2+H3+H5\",\"location\":\"CameraNeo:onCaptureCompleted\",\"timestamp\":" + System.currentTimeMillis()
                        + ",\"message\":\"actual HAL-applied values vs requested\",\"data\":{"
                        + "\"isManualAttempt\":" + isManualAttempt
                        + ",\"req_exp_ns\":" + reqExpNs
                        + ",\"actual_exp_ns\":" + actualExpNs
                        + ",\"exp_match\":" + expMatch
                        + ",\"req_iso\":" + reqIso
                        + ",\"actual_iso\":" + actualIso
                        + ",\"iso_match\":" + isoMatch
                        + ",\"req_AE_MODE\":" + reqAeMode
                        + ",\"actual_AE_MODE\":" + actualAeMode
                        + ",\"actual_AE_STATE\":" + actualAeState
                        + ",\"req_NR_MODE\":" + reqNrMode
                        + ",\"actual_NR_MODE\":" + actualNrMode
                        + ",\"req_EDGE_MODE\":" + reqEdgeMode
                        + ",\"actual_EDGE_MODE\":" + actualEdgeMode
                        + ",\"req_ZSL\":" + reqZsl
                        + ",\"actual_FRAME_DUR_ns\":" + actualFrameDurNs
                        + ",\"totalLightProxy_actual\":" + String.format(java.util.Locale.US, "%.1f", totalLightProxyActual)
                        + ",\"totalLightProxy_xyCamera2_at400ISO\":" + String.format(java.util.Locale.US, "%.1f", totalLightProxyXy)
                        + "}}");
    }
}
