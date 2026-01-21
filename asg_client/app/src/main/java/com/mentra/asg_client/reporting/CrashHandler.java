package com.mentra.asg_client.reporting;

import android.os.Build;
import android.util.Log;

import com.mentra.asg_client.BuildConfig;
import com.mentra.asg_client.reporting.core.ReportData;
import com.mentra.asg_client.reporting.core.ReportLevel;
import com.mentra.asg_client.reporting.core.ReportManager;

/**
 * Global uncaught exception handler that ensures all crashes are captured
 * and reported to both Sentry (when online) and local file storage (always).
 *
 * This handler:
 * 1. Captures ALL uncaught exceptions from any thread
 * 2. Reports to ReportManager (which fans out to Sentry + FileReportProvider)
 * 3. Preserves the original exception handler chain
 * 4. Includes rich context (device info, thread info, memory state)
 */
public class CrashHandler implements Thread.UncaughtExceptionHandler {

    private static final String TAG = "CrashHandler";
    private static CrashHandler sInstance;

    private final Thread.UncaughtExceptionHandler mDefaultHandler;
    private ReportManager mReportManager;

    private CrashHandler() {
        mDefaultHandler = Thread.getDefaultUncaughtExceptionHandler();
    }

    /**
     * Install the crash handler as the default uncaught exception handler.
     * Should be called once during application startup.
     */
    public static synchronized void install() {
        if (sInstance != null) {
            Log.w(TAG, "CrashHandler already installed");
            return;
        }

        sInstance = new CrashHandler();
        Thread.setDefaultUncaughtExceptionHandler(sInstance);
        Log.i(TAG, "CrashHandler installed successfully");
    }

    /**
     * Set the ReportManager to use for crash reporting.
     * This should be called after ReportingModule.initialize() completes.
     *
     * @param reportManager The initialized ReportManager
     */
    public static void setReportManager(ReportManager reportManager) {
        if (sInstance != null) {
            sInstance.mReportManager = reportManager;
            Log.i(TAG, "ReportManager set for CrashHandler");
        }
    }

    /**
     * Get the singleton instance (may be null if not installed)
     */
    public static CrashHandler getInstance() {
        return sInstance;
    }

    @Override
    public void uncaughtException(Thread thread, Throwable throwable) {
        Log.e(TAG, "!!! UNCAUGHT EXCEPTION !!!");
        Log.e(TAG, "Thread: " + thread.getName() + " (ID: " + thread.getId() + ")");
        Log.e(TAG, "Exception: " + throwable.getClass().getName() + ": " + throwable.getMessage());

        try {
            // Build comprehensive crash report
            ReportData.Builder reportBuilder = new ReportData.Builder()
                    .message(buildCrashMessage(thread, throwable))
                    .level(ReportLevel.CRITICAL)
                    .category("crash")
                    .operation("uncaught_exception")
                    .exception(throwable);

            // Add thread context
            reportBuilder.tag("crash_thread_name", thread.getName());
            reportBuilder.tag("crash_thread_id", String.valueOf(thread.getId()));
            reportBuilder.tag("crash_thread_state", thread.getState().name());

            // Add exception details
            reportBuilder.tag("exception_class", throwable.getClass().getName());
            if (throwable.getMessage() != null) {
                reportBuilder.tag("exception_message", truncate(throwable.getMessage(), 200));
            }

            // Add root cause if different from main exception
            Throwable rootCause = getRootCause(throwable);
            if (rootCause != throwable) {
                reportBuilder.tag("root_cause_class", rootCause.getClass().getName());
                if (rootCause.getMessage() != null) {
                    reportBuilder.tag("root_cause_message", truncate(rootCause.getMessage(), 200));
                }
            }

            // Add device context
            reportBuilder.context("device_model", Build.MODEL);
            reportBuilder.context("device_manufacturer", Build.MANUFACTURER);
            reportBuilder.context("android_version", Build.VERSION.RELEASE);
            reportBuilder.context("sdk_int", Build.VERSION.SDK_INT);
            reportBuilder.context("app_version", BuildConfig.VERSION_NAME);
            reportBuilder.context("app_version_code", BuildConfig.VERSION_CODE);

            // Add memory context
            Runtime runtime = Runtime.getRuntime();
            long usedMemory = runtime.totalMemory() - runtime.freeMemory();
            long maxMemory = runtime.maxMemory();
            double memoryUsagePercent = (double) usedMemory / maxMemory * 100;
            reportBuilder.context("memory_used_mb", usedMemory / 1024 / 1024);
            reportBuilder.context("memory_max_mb", maxMemory / 1024 / 1024);
            reportBuilder.context("memory_usage_percent", String.format("%.1f%%", memoryUsagePercent));

            // Report the crash
            if (mReportManager != null) {
                // Report synchronously to ensure it completes before app dies
                reportCrashSync(reportBuilder.build());
            } else {
                Log.e(TAG, "ReportManager not available - crash may not be fully reported");
            }

        } catch (Exception e) {
            // Don't let reporting errors prevent the default handler from running
            Log.e(TAG, "Error during crash reporting", e);
        }

        // Always call the default handler to complete the crash
        // This allows Android to show the crash dialog and restart the app
        if (mDefaultHandler != null) {
            mDefaultHandler.uncaughtException(thread, throwable);
        } else {
            // Fallback: kill the process
            Log.e(TAG, "No default handler, killing process");
            android.os.Process.killProcess(android.os.Process.myPid());
            System.exit(1);
        }
    }

    /**
     * Report crash synchronously to ensure completion before app dies.
     * Uses ReportManager.reportSync() to block until all providers finish.
     */
    private void reportCrashSync(ReportData reportData) {
        try {
            mReportManager.reportSync(reportData);
        } catch (Exception e) {
            Log.e(TAG, "Error in sync crash report", e);
        }
    }

    private String buildCrashMessage(Thread thread, Throwable throwable) {
        StringBuilder sb = new StringBuilder();
        sb.append("FATAL CRASH in thread '").append(thread.getName()).append("'\n");
        sb.append("Exception: ").append(throwable.getClass().getName()).append("\n");
        if (throwable.getMessage() != null) {
            sb.append("Message: ").append(throwable.getMessage()).append("\n");
        }

        // Add first few stack trace elements for quick context
        StackTraceElement[] stack = throwable.getStackTrace();
        if (stack != null && stack.length > 0) {
            sb.append("At: ");
            int limit = Math.min(3, stack.length);
            for (int i = 0; i < limit; i++) {
                if (i > 0) sb.append(" <- ");
                sb.append(stack[i].getClassName())
                        .append(".")
                        .append(stack[i].getMethodName())
                        .append(":")
                        .append(stack[i].getLineNumber());
            }
        }

        return sb.toString();
    }

    private Throwable getRootCause(Throwable throwable) {
        Throwable cause = throwable;
        while (cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        return cause;
    }

    private String truncate(String str, int maxLength) {
        if (str == null) return null;
        if (str.length() <= maxLength) return str;
        return str.substring(0, maxLength) + "...";
    }
}
