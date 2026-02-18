package com.mentra.asg_client.reporting.providers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.reporting.core.IReportProvider;
import com.mentra.asg_client.reporting.core.ReportData;
import com.mentra.asg_client.reporting.core.ReportLevel;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;

/**
 * Console implementation of the report provider for debugging
 * Follows Open/Closed Principle - can be extended without modification
 */
public class ConsoleReportProvider implements IReportProvider {
    
    private static final String TAG = "ConsoleReportProvider";
    private static final SimpleDateFormat DATE_FORMAT = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
    
    private boolean isEnabled = true;
    private boolean isInitialized = false;
    
    @Override
    public boolean initialize(Context context) {
        isInitialized = true;
        Log.i(TAG, "Console report provider initialized");
        return true;
    }
    
    @Override
    public void report(ReportData reportData) {
        if (!isEnabled || !isInitialized) return;
        
        StringBuilder sb = new StringBuilder();
        sb.append("[").append(DATE_FORMAT.format(new Date(reportData.getTimestamp()))).append("] ");
        sb.append("[").append(reportData.getLevel().getName().toUpperCase()).append("] ");
        sb.append("[").append(reportData.getCategory()).append("] ");
        
        if (!reportData.getOperation().isEmpty()) {
            sb.append("[").append(reportData.getOperation()).append("] ");
        }
        
        sb.append(reportData.getMessage());
        
        // Add tags if any
        if (!reportData.getTags().isEmpty()) {
            sb.append(" | Tags: ").append(formatMap(reportData.getTags()));
        }
        
        // Add context if any
        if (!reportData.getContext().isEmpty()) {
            sb.append(" | Context: ").append(formatMap(reportData.getContext()));
        }
        
        // Add user info if available
        if (reportData.getUserId() != null) {
            sb.append(" | User: ").append(reportData.getUserId());
        }
        
        // Add session info if available
        if (reportData.getSessionId() != null) {
            sb.append(" | Session: ").append(reportData.getSessionId());
        }
        
        // Add exception if available
        if (reportData.getException() != null) {
            sb.append(" | Exception: ").append(reportData.getException().getMessage());
        }
        
        // Log based on level
        switch (reportData.getLevel()) {
            case DEBUG:
                Log.d(TAG, sb.toString());
                break;
            case INFO:
                Log.i(TAG, sb.toString());
                break;
            case WARNING:
                Log.w(TAG, sb.toString());
                break;
            case ERROR:
            case CRITICAL:
                Log.e(TAG, sb.toString(), reportData.getException());
                break;
        }
    }
    
    @Override
    public void setUserContext(String userId, String username, String email) {
        if (!isEnabled || !isInitialized) return;
        Log.i(TAG, "User context set - ID: " + userId + ", Username: " + username + ", Email: " + email);
    }
    
    @Override
    public void clearUserContext() {
        if (!isEnabled || !isInitialized) return;
        Log.i(TAG, "User context cleared");
    }
    
    @Override
    public void addBreadcrumb(String message, String category, ReportLevel level) {
        if (!isEnabled || !isInitialized) return;
        Log.d(TAG, "Breadcrumb [" + category + "] [" + level.getName() + "]: " + message);
    }
    
    @Override
    public boolean isEnabled() {
        return isEnabled && isInitialized;
    }
    
    @Override
    public void setEnabled(boolean enabled) {
        this.isEnabled = enabled;
        Log.i(TAG, "Console report provider " + (enabled ? "enabled" : "disabled"));
    }
    
    @Override
    public String getProviderName() {
        return "Console";
    }
    
    /**
     * Format a map for logging
     */
    private String formatMap(Map<String, Object> map) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            if (!first) sb.append(", ");
            sb.append(entry.getKey()).append("=").append(entry.getValue());
            first = false;
        }
        sb.append("}");
        return sb.toString();
    }
} 