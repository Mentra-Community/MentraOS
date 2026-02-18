package com.mentra.asg_client.reporting.domains;

import android.content.Context;

import com.mentra.asg_client.reporting.core.ReportData;
import com.mentra.asg_client.reporting.core.ReportLevel;
import com.mentra.asg_client.reporting.core.ReportManager;

/**
 * Streaming-specific reporting methods
 * Follows Single Responsibility Principle - only handles streaming reporting
 */
public class StreamingReporting {
    
    private static final String TAG = "StreamingReporting";
    
    /**
     * Report RTMP connection failure
     */
    public static void reportRtmpConnectionFailure(Context context, String rtmpUrl, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("RTMP connection failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.rtmp")
                .operation("connect")
                .tag("rtmp_url", rtmpUrl)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report RTMP connection lost
     */
    public static void reportRtmpConnectionLost(Context context, String rtmpUrl, long streamDuration, String reason) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("RTMP connection lost: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.rtmp")
                .operation("connection_lost")
                .tag("rtmp_url", rtmpUrl)
                .tag("stream_duration", streamDuration)
                .tag("reason", reason)
        );
    }
    
    /**
     * Report streaming initialization failure
     */
    public static void reportInitializationFailure(Context context, String rtmpUrl, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Streaming initialization failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.initialization")
                .operation("initialize")
                .tag("rtmp_url", rtmpUrl)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report camera access failure
     */
    public static void reportCameraAccessFailure(Context context, String operation, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Camera access failure: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.camera")
                .operation(operation)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report camera busy error
     */
    public static void reportCameraBusyError(Context context, String operation) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Camera is busy")
                .level(ReportLevel.WARNING)
                .category("streaming.camera")
                .operation(operation)
                .tag("reason", "camera_busy")
        );
    }
    
    /**
     * Report surface creation failure
     */
    public static void reportSurfaceCreationFailure(Context context, String operation, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Surface creation failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.surface")
                .operation(operation)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report streamer configuration failure
     */
    public static void reportConfigurationFailure(Context context, String configType, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Streamer configuration failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.configuration")
                .operation("configure")
                .tag("config_type", configType)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report preview start failure
     */
    public static void reportPreviewStartFailure(Context context, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Preview start failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.preview")
                .operation("start_preview")
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report stream start failure
     */
    public static void reportStreamStartFailure(Context context, String rtmpUrl, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Stream start failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.start")
                .operation("start_stream")
                .tag("rtmp_url", rtmpUrl)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report stream stop failure
     */
    public static void reportStreamStopFailure(Context context, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Stream stop failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.stop")
                .operation("stop_stream")
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report reconnection failure
     */
    public static void reportReconnectionFailure(Context context, String rtmpUrl, int attempt, int maxAttempts, String reason) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Reconnection failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.reconnection")
                .operation("reconnect")
                .tag("rtmp_url", rtmpUrl)
                .tag("attempt", attempt)
                .tag("max_attempts", maxAttempts)
                .tag("reason", reason)
        );
    }
    
    /**
     * Report reconnection exhaustion
     */
    public static void reportReconnectionExhaustion(Context context, String rtmpUrl, int maxAttempts, long totalDuration) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Reconnection attempts exhausted")
                .level(ReportLevel.ERROR)
                .category("streaming.reconnection")
                .operation("reconnection_exhaustion")
                .tag("rtmp_url", rtmpUrl)
                .tag("max_attempts", maxAttempts)
                .tag("total_duration", totalDuration)
        );
    }
    
    /**
     * Report loss of validated upstream connectivity while streaming
     */
    public static void reportNetworkValidationLost(Context context, String streamId, long graceWindowMs) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Upstream validation lost during streaming")
                .level(ReportLevel.WARNING)
                .category("streaming.network")
                .operation("validation_lost")
                .tag("stream_id", streamId != null ? streamId : "unknown")
                .tag("grace_window_ms", graceWindowMs)
        );
    }
    
    /**
     * Report reachability probe failure
     */
    public static void reportReachabilityProbeFailure(Context context, String rtmpUrl, int consecutiveFailures, long intervalMs) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("RTMP reachability probe failed")
                .level(ReportLevel.WARNING)
                .category("streaming.network")
                .operation("reachability_probe")
                .tag("rtmp_url", rtmpUrl != null ? rtmpUrl : "unknown")
                .tag("consecutive_failures", consecutiveFailures)
                .tag("probe_interval_ms", intervalMs)
        );
    }
    
    /**
     * Report packet stall (no packets sent for a period)
     */
    public static void reportPacketStall(Context context, String rtmpUrl, long elapsedMs, long thresholdMs) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("RTMP packet stall detected")
                .level(ReportLevel.WARNING)
                .category("streaming.network")
                .operation("packet_stall")
                .tag("rtmp_url", rtmpUrl != null ? rtmpUrl : "unknown")
                .tag("elapsed_ms", elapsedMs)
                .tag("threshold_ms", thresholdMs)
        );
    }
    
    /**
     * Report stream timeout error
     */
    public static void reportTimeoutError(Context context, String streamId, long timeoutMs) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Stream timeout error")
                .level(ReportLevel.ERROR)
                .category("streaming.timeout")
                .operation("stream_timeout")
                .tag("stream_id", streamId)
                .tag("timeout_ms", timeoutMs)
        );
    }
    
    /**
     * Report stream pack error
     */
    public static void reportPackError(Context context, String errorType, String message, boolean isRetryable) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Stream pack error: " + message)
                .level(ReportLevel.ERROR)
                .category("streaming.pack")
                .operation("pack_error")
                .tag("error_type", errorType)
                .tag("message", message)
                .tag("is_retryable", isRetryable)
        );
    }
    
    /**
     * Report streaming service failure
     */
    public static void reportServiceFailure(Context context, String operation, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Streaming service failure: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.service")
                .operation(operation)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report wake lock failure
     */
    public static void reportWakeLockFailure(Context context, String operation, String reason) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Wake lock failure: " + reason)
                .level(ReportLevel.WARNING)
                .category("streaming.wakelock")
                .operation(operation)
                .tag("reason", reason)
        );
    }
    
    /**
     * Report notification failure
     */
    public static void reportNotificationFailure(Context context, String operation, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Notification failure: " + reason)
                .level(ReportLevel.WARNING)
                .category("streaming.notification")
                .operation(operation)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report event bus failure
     */
    public static void reportEventBusFailure(Context context, String eventType, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Event bus failure: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.event_bus")
                .operation("event_bus_error")
                .tag("event_type", eventType)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report URL validation failure
     */
    public static void reportUrlValidationFailure(Context context, String rtmpUrl, String reason) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("URL validation failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("streaming.validation")
                .operation("validate_url")
                .tag("rtmp_url", rtmpUrl)
                .tag("reason", reason)
        );
    }
    
    /**
     * Report streaming permission error
     */
    public static void reportPermissionError(Context context, String permission, String operation) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Streaming permission denied: " + permission)
                .level(ReportLevel.ERROR)
                .category("streaming.permission")
                .operation(operation)
                .tag("permission", permission)
        );
    }
    
    /**
     * Report streaming state inconsistency
     */
    public static void reportStateInconsistency(Context context, String expectedState, String actualState, String operation) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Streaming state inconsistency")
                .level(ReportLevel.WARNING)
                .category("streaming.state")
                .operation(operation)
                .tag("expected_state", expectedState)
                .tag("actual_state", actualState)
        );
    }
    
    /**
     * Report resource cleanup failure
     */
    public static void reportResourceCleanupFailure(Context context, String resourceType, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Resource cleanup failed: " + reason)
                .level(ReportLevel.WARNING)
                .category("streaming.cleanup")
                .operation("cleanup_resource")
                .tag("resource_type", resourceType)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report streaming performance issue
     */
    public static void reportPerformanceIssue(Context context, String metric, long value, String unit, String threshold) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Streaming performance issue: " + metric + " = " + value + " " + unit)
                .level(ReportLevel.WARNING)
                .category("streaming.performance")
                .operation("performance_check")
                .tag("metric", metric)
                .tag("value", value)
                .tag("unit", unit)
                .tag("threshold", threshold)
        );
    }
    
    /**
     * Report camera operation
     */
    public static void reportCameraOperation(Context context, String operation, boolean success, String details) {
        ReportLevel level = success ? ReportLevel.INFO : ReportLevel.ERROR;
        
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Camera operation: " + operation + " - " + (success ? "SUCCESS" : "FAILED"))
                .level(level)
                .category("streaming.camera")
                .operation(operation)
                .tag("success", success)
                .tag("details", details)
        );
    }
    
    /**
     * Report streaming event
     */
    public static void reportStreamingEvent(Context context, String event, String streamUrl, boolean success) {
        ReportLevel level = success ? ReportLevel.INFO : ReportLevel.ERROR;
        
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Streaming event: " + event + " - " + (success ? "SUCCESS" : "FAILED"))
                .level(level)
                .category("streaming.event")
                .operation(event)
                .tag("stream_url", streamUrl)
                .tag("success", success)
        );
    }
} 
