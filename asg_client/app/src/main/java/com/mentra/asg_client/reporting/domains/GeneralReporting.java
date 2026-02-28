package com.mentra.asg_client.reporting.domains;

import android.content.Context;

import com.mentra.asg_client.reporting.core.ReportData;
import com.mentra.asg_client.reporting.core.ReportLevel;
import com.mentra.asg_client.reporting.core.ReportManager;

import java.util.Map;

/**
 * General reporting methods for common operations
 * Follows Single Responsibility Principle - only handles general reporting
 */
public class GeneralReporting {
    
    private static final String TAG = "GeneralReporting";
    
    /**
     * Report application startup
     */
    public static void reportAppStartup(Context context) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Application started")
                .level(ReportLevel.INFO)
                .category("app.lifecycle")
                .operation("startup")
        );
    }
    
    /**
     * Report service lifecycle events
     */
    public static void reportServiceEvent(Context context, String serviceName, String event) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(serviceName + " - " + event)
                .level(ReportLevel.INFO)
                .category("service.lifecycle")
                .operation(event)
                .tag("service_name", serviceName)
        );
    }
    
    /**
     * Report network operations
     */
    public static void reportNetworkOperation(Context context, String method, String url, int statusCode) {
        ReportLevel level = statusCode >= 400 ? ReportLevel.ERROR : ReportLevel.INFO;
        
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(method + " " + url + " (" + statusCode + ")")
                .level(level)
                .category("http")
                .operation(method)
                .tag("method", method)
                .tag("url", url)
                .tag("status_code", statusCode)
        );
    }
    
    /**
     * Report OTA update events
     */
    public static void reportOtaEvent(Context context, String event, String version, boolean success) {
        ReportLevel level = success ? ReportLevel.INFO : ReportLevel.ERROR;
        
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("OTA event: " + event + " - " + (success ? "SUCCESS" : "FAILED"))
                .level(level)
                .category("ota")
                .operation(event)
                .tag("event", event)
                .tag("version", version)
                .tag("success", success)
        );
    }
    
    /**
     * Report critical error with additional context
     */
    public static void reportCriticalError(Context context, String errorType, String message, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(message)
                .level(ReportLevel.CRITICAL)
                .category("error")
                .operation(errorType)
                .tag("error_type", errorType)
                .exception(exception)
        );
    }
    
    /**
     * Report performance metrics
     */
    public static void reportPerformanceMetric(Context context, String metricName, long value, String unit) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Performance Metric: " + metricName + " = " + value + " " + unit)
                .level(ReportLevel.INFO)
                .category("performance")
                .operation("metric")
                .tag("metric_name", metricName)
                .tag("metric_unit", unit)
                .tag("value", value)
        );
    }
    
    /**
     * Report user actions
     */
    public static void reportUserAction(Context context, String action, Map<String, Object> parameters) {
        ReportManager manager = ReportManager.getInstance(context);
        
        ReportData.Builder builder = new ReportData.Builder()
            .message("User action: " + action)
            .level(ReportLevel.INFO)
            .category("user.action")
            .operation(action)
            .tag("action", action);
        
        // Add parameters as context
        if (parameters != null) {
            for (Map.Entry<String, Object> param : parameters.entrySet()) {
                builder.context(param.getKey(), param.getValue());
            }
        }
        
        manager.report(builder);
    }
    
    /**
     * Report general error
     */
    public static void reportError(Context context, String message, String category, String operation, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(message)
                .level(ReportLevel.ERROR)
                .category(category)
                .operation(operation)
                .exception(exception)
        );
    }
    
    /**
     * Report general warning
     */
    public static void reportWarning(Context context, String message, String category, String operation) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(message)
                .level(ReportLevel.WARNING)
                .category(category)
                .operation(operation)
        );
    }
    
    /**
     * Report general info
     */
    public static void reportInfo(Context context, String message, String category, String operation) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(message)
                .level(ReportLevel.INFO)
                .category(category)
                .operation(operation)
        );
    }
    
    /**
     * Report debug information
     */
    public static void reportDebug(Context context, String message, String category, String operation) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(message)
                .level(ReportLevel.DEBUG)
                .category(category)
                .operation(operation)
        );
    }
} 