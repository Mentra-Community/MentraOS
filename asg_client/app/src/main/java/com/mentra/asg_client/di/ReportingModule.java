package com.mentra.asg_client.di;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.reporting.CrashHandler;
import com.mentra.asg_client.reporting.core.ReportManager;
import com.mentra.asg_client.reporting.providers.SentryReportProvider;
import com.mentra.asg_client.reporting.providers.FileReportProvider;
import com.mentra.asg_client.reporting.providers.ConsoleReportProvider;
import com.mentra.asg_client.service.system.managers.ConfigurationManager;

/**
 * Dependency Injection module for reporting providers
 * Follows Dependency Inversion Principle - depends on abstractions
 * Follows Open/Closed Principle - easy to add new providers
 */
public class ReportingModule {

    private static final String TAG = "ReportingModule";


    public static void initialize(Context context) {
        Log.i(TAG, "Initializing reporting system...");

        ReportManager manager = ReportManager.getInstance(context);

        // Add Sentry provider (will gracefully disable itself if DSN not configured)
        manager.addProvider(new SentryReportProvider());

        // Add File provider for local crash logs (always enabled, ADB accessible)
        manager.addProvider(new FileReportProvider());

        // Add Console provider for development debugging
        if (isDebugBuild()) {
            manager.addProvider(new ConsoleReportProvider());
        }

        // Connect CrashHandler to ReportManager
        CrashHandler.setReportManager(manager);

        // Restore user context if previously saved (e.g., after app restart)
        restoreUserContext(context, manager);

        Log.i(TAG, "Reporting system initialized successfully");
    }

    /**
     * Restore user context from saved email if available.
     * This ensures crash reports include user info even after app restarts.
     */
    private static void restoreUserContext(Context context, ReportManager manager) {
        try {
            ConfigurationManager configManager = new ConfigurationManager(context);
            String savedEmail = configManager.getUserEmail();
            if (savedEmail != null && !savedEmail.isEmpty()) {
                manager.setUserContext(savedEmail, null, savedEmail);
                Log.d(TAG, "Restored user context from saved email");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error restoring user context", e);
        }
    }

    
    /**
     * Check if this is a debug build
     */
    private static boolean isDebugBuild() {
        try {
            // This will be true for debug builds, false for release
            return com.mentra.asg_client.BuildConfig.DEBUG;
        } catch (Exception e) {
            // Fallback to false if BuildConfig is not available
            return false;
        }
    }
} 