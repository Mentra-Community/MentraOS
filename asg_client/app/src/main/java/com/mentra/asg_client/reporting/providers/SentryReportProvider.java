package com.mentra.asg_client.reporting.providers;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import com.mentra.asg_client.BuildConfig;
import com.mentra.asg_client.reporting.config.SentryConfig;
import com.mentra.asg_client.reporting.core.IReportProvider;
import com.mentra.asg_client.reporting.core.ReportData;
import com.mentra.asg_client.reporting.core.ReportLevel;

import io.sentry.Breadcrumb;
import io.sentry.Sentry;
import io.sentry.SentryLevel;
import io.sentry.protocol.User;

import java.util.Map;

/**
 * Sentry implementation of the report provider
 * Follows Single Responsibility Principle - only handles Sentry-specific logic
 */
public class SentryReportProvider implements IReportProvider {
    
    private static final String TAG = "SentryReportProvider";
    private boolean isEnabled = true;
    private boolean isInitialized = false;
    
    @Override
    public boolean initialize(Context context) {
        Log.i(TAG, "Initializing Sentry report provider...");
        
        if (isInitialized) {
            Log.w(TAG, "Sentry already initialized");
            return true;
        }
        
        try {
            // Check if Sentry is properly configured
            Log.d(TAG, "Validating Sentry configuration...");
            if (!SentryConfig.isValidConfiguration()) {
                Log.w(TAG, "Sentry configuration is invalid - skipping initialization");
                SentryConfig.logConfigurationStatus();
                return false;
            }
            
            // Get configuration from secure sources
            String dsn = SentryConfig.getSentryDsn();
            String environment = SentryConfig.getEnvironment();
            double sampleRate = SentryConfig.getSampleRate();
            String release = SentryConfig.getRelease();
            
            Log.i(TAG, "Initializing Sentry with secure configuration");
            Log.d(TAG, "Environment: " + environment);
            Log.d(TAG, "Release: " + release);
            Log.d(TAG, "Sample Rate: " + sampleRate);
            
            // Initialize Sentry with secure configuration
            io.sentry.android.core.SentryAndroid.init(context, options -> {
                // Set DSN from secure configuration
                options.setDsn(dsn);
                
                // Set environment
                options.setEnvironment(environment);
                
                // Set release version
                options.setRelease(release);
                
                // Set sample rates
                options.setTracesSampleRate(sampleRate);
                options.setProfilesSampleRate(sampleRate);
                
                // Disable debug mode to avoid verbose logging
                // Set to true only when actively debugging Sentry itself
                options.setDebug(false);
                options.setDiagnosticLevel(io.sentry.SentryLevel.ERROR);
                
                // Configure data collection based on environment
                if ("production".equals(environment)) {
                    // Reduce data collection in production for privacy
                    options.setSendDefaultPii(false);
                    options.setAttachScreenshot(false);
                    options.setAttachViewHierarchy(false);
                } else {
                    // Enable more data collection in development/staging
                    options.setSendDefaultPii(true);
                    options.setAttachScreenshot(true);
                    options.setAttachViewHierarchy(true);
                }
                
                // Note: Data filtering is now handled centrally by ReportManager
                // No need for provider-specific filtering callbacks
            });
            
            // Set default tags for all events
            Sentry.setTag("app_version", BuildConfig.VERSION_NAME);
            Sentry.setTag("build_number", String.valueOf(BuildConfig.VERSION_CODE));
            Sentry.setTag("device_model", Build.MODEL);
            Sentry.setTag("android_version", Build.VERSION.RELEASE);
            Sentry.setTag("sdk_int", String.valueOf(Build.VERSION.SDK_INT));
            
            // Set default context as tags (more compatible)
            Sentry.setTag("device_manufacturer", Build.MANUFACTURER);
            Sentry.setTag("device_brand", Build.BRAND);
            Sentry.setTag("device_product", Build.PRODUCT);
            Sentry.setTag("device_fingerprint", Build.FINGERPRINT);
            
            isInitialized = true;
            Log.i(TAG, "Sentry initialized successfully");
            
            // Log configuration status
            SentryConfig.logConfigurationStatus();
            
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to initialize Sentry", e);
            return false;
        }
    }
    
    @Override
    public void report(ReportData reportData) {
        if (!isEnabled || !isInitialized) {
            Log.w(TAG, "Sentry not enabled or not initialized");
            return;
        }
        
        try {
            Sentry.withScope(scope -> {
                // Set level
                scope.setLevel(convertLevel(reportData.getLevel()));
                
                // Set tags
                for (Map.Entry<String, Object> tag : reportData.getTags().entrySet()) {
                    scope.setTag(tag.getKey(), String.valueOf(tag.getValue()));
                }
                
                // Set context as tags (more compatible)
                if (!reportData.getContext().isEmpty()) {
                    for (Map.Entry<String, Object> entry : reportData.getContext().entrySet()) {
                        scope.setTag(entry.getKey(), String.valueOf(entry.getValue()));
                    }
                }
                
                // Set user if available
                if (reportData.getUserId() != null) {
                    User user = new User();
                    user.setId(reportData.getUserId());
                    scope.setUser(user);
                }

                addBreadcrumb(reportData.getMessage(), reportData.getCategory(), reportData.getLevel());

                // Report based on data type
                if (reportData.getException() != null) {

                    Sentry.captureException(reportData.getException());
                } else {
                    Sentry.captureMessage(reportData.getMessage(), convertLevel(reportData.getLevel()));
                }
            });
            
            Log.d(TAG, "Reported to Sentry: " + reportData.getMessage());
        } catch (Exception e) {
            Log.e(TAG, "Failed to report to Sentry", e);
        }
    }
    
    @Override
    public void setUserContext(String userId, String username, String email) {
        if (!isEnabled || !isInitialized) return;
        
        try {
            User user = new User();
            user.setId(userId);
            user.setUsername(username);
            user.setEmail(email);
            user.setIpAddress("{{auto}}");
            Sentry.setUser(user);
            
            Log.i(TAG, "User context set: " + userId);
        } catch (Exception e) {
            Log.e(TAG, "Failed to set user context", e);
        }
    }
    
    @Override
    public void clearUserContext() {
        if (!isEnabled || !isInitialized) return;
        
        try {
            Sentry.setUser(null);
            Log.i(TAG, "User context cleared");
        } catch (Exception e) {
            Log.e(TAG, "Failed to clear user context", e);
        }
    }
    
    @Override
    public void addBreadcrumb(String message, String category, ReportLevel level) {
        if (!isEnabled || !isInitialized) return;
        
        try {
            Breadcrumb breadcrumb = new Breadcrumb();
            breadcrumb.setCategory(category);
            breadcrumb.setType("debug");
            breadcrumb.setMessage(message);
            breadcrumb.setLevel(convertLevel(level));
            Sentry.addBreadcrumb(breadcrumb);
            
            Log.d(TAG, "Breadcrumb added: " + message);
        } catch (Exception e) {
            Log.e(TAG, "Failed to add breadcrumb", e);
        }
    }
    
    @Override
    public boolean isEnabled() {
        return isEnabled && isInitialized;
    }
    
    @Override
    public void setEnabled(boolean enabled) {
        this.isEnabled = enabled;
        Log.i(TAG, "Sentry " + (enabled ? "enabled" : "disabled"));
    }
    
    @Override
    public String getProviderName() {
        return "Sentry";
    }
    
    /**
     * Convert ReportLevel to SentryLevel
     */
    private SentryLevel convertLevel(ReportLevel level) {
        switch (level) {
            case DEBUG: return SentryLevel.DEBUG;
            case INFO: return SentryLevel.INFO;
            case WARNING: return SentryLevel.WARNING;
            case ERROR: return SentryLevel.ERROR;
            case CRITICAL: return SentryLevel.FATAL;
            default: return SentryLevel.INFO;
        }
    }
    
    // Note: Data filtering is now handled centrally by DataFilter utility
    // Provider-specific filtering methods have been removed to avoid duplication
} 