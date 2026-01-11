package com.mentra.asg_client.reporting.config;

import android.util.Log;

import com.mentra.asg_client.BuildConfig;

/**
 * Sentry configuration using BuildConfig values from .env file.
 * Consistent with mobile app approach.
 *
 * To configure Sentry:
 * 1. Copy .env.example to .env
 * 2. Set SENTRY_DSN=https://xxx@sentry.io/xxx
 * 3. Rebuild the app
 */
public class SentryConfig {

    private static final String TAG = "SentryConfig";

    /**
     * Get Sentry DSN from BuildConfig (populated from .env)
     */
    public static String getSentryDsn() {
        String dsn = BuildConfig.SENTRY_DSN;
        if (dsn != null && !dsn.trim().isEmpty()) {
            return dsn.trim();
        }
        return null;
    }

    /**
     * Check if Sentry is enabled (DSN is configured)
     */
    public static boolean isSentryEnabled() {
        String dsn = getSentryDsn();
        return dsn != null && !dsn.isEmpty();
    }

    /**
     * Get sample rate (1.0 = 100% of events)
     */
    public static double getSampleRate() {
        return 1.0;
    }

    /**
     * Get Sentry environment based on build type
     */
    public static String getEnvironment() {
        return BuildConfig.DEBUG ? "development" : "production";
    }

    /**
     * Get release version
     */
    public static String getRelease() {
        return BuildConfig.VERSION_NAME;
    }

    /**
     * Validate Sentry configuration
     */
    public static boolean isValidConfiguration() {
        String dsn = getSentryDsn();
        if (dsn == null || dsn.isEmpty()) {
            return false;
        }
        // Basic DSN validation
        return dsn.startsWith("https://") && dsn.contains("@") && dsn.contains(".sentry.io/");
    }

    /**
     * Log configuration status
     */
    public static void logConfigurationStatus() {
        Log.i(TAG, "=== Sentry Configuration Status ===");
        Log.i(TAG, "DSN configured: " + (getSentryDsn() != null ? "yes" : "no"));
        Log.i(TAG, "Environment: " + getEnvironment());
        Log.i(TAG, "Release: " + getRelease());
        Log.i(TAG, "Sample rate: " + getSampleRate());

        if (isValidConfiguration()) {
            Log.i(TAG, "✓ Sentry configuration is valid and ready");
        } else {
            Log.w(TAG, "✗ Sentry not configured - add SENTRY_DSN to .env file");
        }
        Log.i(TAG, "=====================================");
    }
}
