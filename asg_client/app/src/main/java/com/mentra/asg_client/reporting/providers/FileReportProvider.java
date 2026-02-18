package com.mentra.asg_client.reporting.providers;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import com.mentra.asg_client.BuildConfig;
import com.mentra.asg_client.reporting.core.IReportProvider;
import com.mentra.asg_client.reporting.core.ReportData;
import com.mentra.asg_client.reporting.core.ReportLevel;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;
import java.util.Map;

/**
 * File-based report provider that writes crash logs to external storage.
 * Logs are accessible via ADB: adb pull /sdcard/mentra_crash_logs/
 *
 * Features:
 * - Writes to /sdcard/mentra_crash_logs/ for easy ADB access
 * - Automatic log rotation when total size exceeds limit
 * - Full stack traces and device context
 * - Works offline (no network required)
 */
public class FileReportProvider implements IReportProvider {

    private static final String TAG = "FileReportProvider";
    private static final String LOG_DIRECTORY = "mentra_crash_logs";
    private static final long MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB max total
    private static final int MAX_LOG_FILES = 20; // Keep at most 20 log files

    private boolean mIsEnabled = true;
    private boolean mIsInitialized = false;
    private File mLogDirectory;
    private String mCurrentUserId;
    private String mCurrentUsername;

    // Thread-safe date formatting
    private String formatDate(long timestamp) {
        SimpleDateFormat df = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US);
        return df.format(new Date(timestamp));
    }

    private String formatTimestamp(long timestamp) {
        SimpleDateFormat df = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
        return df.format(new Date(timestamp));
    }

    @Override
    public boolean initialize(Context context) {
        Log.i(TAG, "Initializing file report provider...");

        try {
            // Use external storage for ADB accessibility
            File externalDir = Environment.getExternalStorageDirectory();
            mLogDirectory = new File(externalDir, LOG_DIRECTORY);

            if (!mLogDirectory.exists()) {
                boolean created = mLogDirectory.mkdirs();
                if (!created) {
                    Log.e(TAG, "Failed to create log directory: " + mLogDirectory.getAbsolutePath());
                    return false;
                }
            }

            // Verify we can write to the directory
            if (!mLogDirectory.canWrite()) {
                Log.e(TAG, "Cannot write to log directory: " + mLogDirectory.getAbsolutePath());
                return false;
            }

            // Purge old logs if necessary
            purgeOldLogsIfNeeded();

            mIsInitialized = true;
            Log.i(TAG, "File report provider initialized. Logs at: " + mLogDirectory.getAbsolutePath());
            return true;

        } catch (Exception e) {
            Log.e(TAG, "Failed to initialize file report provider", e);
            return false;
        }
    }

    @Override
    public void report(ReportData reportData) {
        if (!mIsEnabled || !mIsInitialized) {
            return;
        }

        try {
            // Only log ERROR and CRITICAL to file to avoid filling up storage
            if (reportData.getLevel().ordinal() < ReportLevel.ERROR.ordinal()) {
                return;
            }

            String filename = generateFilename(reportData);
            File logFile = new File(mLogDirectory, filename);

            writeLogFile(logFile, reportData);

            // Check if we need to purge after writing
            purgeOldLogsIfNeeded();

            Log.d(TAG, "Wrote crash log: " + logFile.getAbsolutePath());

        } catch (Exception e) {
            Log.e(TAG, "Failed to write crash log", e);
        }
    }

    private String generateFilename(ReportData reportData) {
        String timestamp = formatDate(reportData.getTimestamp());
        String level = reportData.getLevel().name().toLowerCase(Locale.US);
        return String.format(Locale.US, "crash_%s_%s.log", timestamp, level);
    }

    private void writeLogFile(File logFile, ReportData reportData) throws IOException {
        try (FileWriter fw = new FileWriter(logFile, false);
             PrintWriter pw = new PrintWriter(fw)) {

            // Header
            pw.println("================================================================================");
            pw.println("MENTRA LIVE CRASH LOG");
            pw.println("================================================================================");
            pw.println();

            // Timestamp and level
            pw.println("Timestamp: " + formatTimestamp(reportData.getTimestamp()));
            pw.println("Level: " + reportData.getLevel().name());
            pw.println("Category: " + reportData.getCategory());
            if (reportData.getOperation() != null && !reportData.getOperation().isEmpty()) {
                pw.println("Operation: " + reportData.getOperation());
            }
            pw.println();

            // Message
            pw.println("--- MESSAGE ---");
            pw.println(reportData.getMessage());
            pw.println();

            // Exception/Stack trace
            if (reportData.getException() != null) {
                pw.println("--- STACK TRACE ---");
                StringWriter sw = new StringWriter();
                reportData.getException().printStackTrace(new PrintWriter(sw));
                pw.println(sw.toString());
                pw.println();
            }

            // Device info
            pw.println("--- DEVICE INFO ---");
            pw.println("App Version: " + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")");
            pw.println("Device Model: " + Build.MODEL);
            pw.println("Manufacturer: " + Build.MANUFACTURER);
            pw.println("Brand: " + Build.BRAND);
            pw.println("Product: " + Build.PRODUCT);
            pw.println("Android Version: " + Build.VERSION.RELEASE);
            pw.println("SDK Level: " + Build.VERSION.SDK_INT);
            pw.println("Build Fingerprint: " + Build.FINGERPRINT);
            pw.println();

            // User info
            if (mCurrentUserId != null || mCurrentUsername != null) {
                pw.println("--- USER INFO ---");
                if (mCurrentUserId != null) {
                    pw.println("User ID: " + mCurrentUserId);
                }
                if (mCurrentUsername != null) {
                    pw.println("Username: " + mCurrentUsername);
                }
                if (reportData.getSessionId() != null) {
                    pw.println("Session ID: " + reportData.getSessionId());
                }
                pw.println();
            }

            // Tags
            Map<String, Object> tags = reportData.getTags();
            if (!tags.isEmpty()) {
                pw.println("--- TAGS ---");
                for (Map.Entry<String, Object> entry : tags.entrySet()) {
                    pw.println(entry.getKey() + ": " + entry.getValue());
                }
                pw.println();
            }

            // Context
            Map<String, Object> context = reportData.getContext();
            if (!context.isEmpty()) {
                pw.println("--- CONTEXT ---");
                for (Map.Entry<String, Object> entry : context.entrySet()) {
                    pw.println(entry.getKey() + ": " + entry.getValue());
                }
                pw.println();
            }

            // Memory info
            pw.println("--- MEMORY INFO ---");
            Runtime runtime = Runtime.getRuntime();
            long maxMemory = runtime.maxMemory();
            long totalMemory = runtime.totalMemory();
            long freeMemory = runtime.freeMemory();
            long usedMemory = totalMemory - freeMemory;
            pw.println("Max Memory: " + (maxMemory / 1024 / 1024) + " MB");
            pw.println("Total Memory: " + (totalMemory / 1024 / 1024) + " MB");
            pw.println("Used Memory: " + (usedMemory / 1024 / 1024) + " MB");
            pw.println("Free Memory: " + (freeMemory / 1024 / 1024) + " MB");
            pw.println();

            // Thread info (from crash context if available, otherwise current thread)
            pw.println("--- THREAD INFO ---");
            Map<String, Object> crashTags = reportData.getTags();
            if (crashTags.containsKey("crash_thread_name")) {
                pw.println("Thread Name: " + crashTags.get("crash_thread_name"));
                pw.println("Thread ID: " + crashTags.get("crash_thread_id"));
                pw.println("Thread State: " + crashTags.get("crash_thread_state"));
            } else {
                Thread currentThread = Thread.currentThread();
                pw.println("Thread Name: " + currentThread.getName());
                pw.println("Thread ID: " + currentThread.getId());
                pw.println("Thread State: " + currentThread.getState());
            }
            pw.println();

            pw.println("================================================================================");
            pw.println("END OF CRASH LOG");
            pw.println("================================================================================");

            pw.flush();
        }
    }

    /**
     * Purge old log files if total size exceeds limit or too many files exist
     */
    private void purgeOldLogsIfNeeded() {
        if (mLogDirectory == null || !mLogDirectory.exists()) {
            return;
        }

        try {
            File[] logFiles = mLogDirectory.listFiles((dir, name) -> name.endsWith(".log"));
            if (logFiles == null || logFiles.length == 0) {
                return;
            }

            // Sort by last modified (oldest first)
            Arrays.sort(logFiles, Comparator.comparingLong(File::lastModified));

            // Calculate total size
            long totalSize = 0;
            for (File file : logFiles) {
                totalSize += file.length();
            }

            // Delete oldest files until we're under the limit
            int filesDeleted = 0;
            for (File file : logFiles) {
                boolean shouldDelete = false;

                // Delete if total size exceeds limit
                if (totalSize > MAX_TOTAL_SIZE_BYTES) {
                    shouldDelete = true;
                }

                // Delete if too many files (keep newest ones)
                if (logFiles.length - filesDeleted > MAX_LOG_FILES) {
                    shouldDelete = true;
                }

                if (shouldDelete) {
                    long fileSize = file.length();
                    if (file.delete()) {
                        totalSize -= fileSize;
                        filesDeleted++;
                        Log.d(TAG, "Purged old log file: " + file.getName());
                    }
                } else {
                    break; // No more files need to be deleted
                }
            }

            if (filesDeleted > 0) {
                Log.i(TAG, "Purged " + filesDeleted + " old log files");
            }

        } catch (Exception e) {
            Log.e(TAG, "Error purging old logs", e);
        }
    }

    @Override
    public void setUserContext(String userId, String username, String email) {
        mCurrentUserId = userId;
        mCurrentUsername = username;
        // Don't store email in plain text logs for privacy
        Log.d(TAG, "User context set: " + userId);
    }

    @Override
    public void clearUserContext() {
        mCurrentUserId = null;
        mCurrentUsername = null;
        Log.d(TAG, "User context cleared");
    }

    @Override
    public void addBreadcrumb(String message, String category, ReportLevel level) {
        // Breadcrumbs are not persisted to file - they're included in crash reports via Sentry
        // This avoids excessive file I/O for every breadcrumb
    }

    @Override
    public boolean isEnabled() {
        return mIsEnabled && mIsInitialized;
    }

    @Override
    public void setEnabled(boolean enabled) {
        mIsEnabled = enabled;
        Log.i(TAG, "File report provider " + (enabled ? "enabled" : "disabled"));
    }

    @Override
    public String getProviderName() {
        return "FileReport";
    }

    /**
     * Get the log directory path (useful for debugging)
     */
    public String getLogDirectoryPath() {
        return mLogDirectory != null ? mLogDirectory.getAbsolutePath() : null;
    }

    /**
     * Get the number of log files currently stored
     */
    public int getLogFileCount() {
        if (mLogDirectory == null || !mLogDirectory.exists()) {
            return 0;
        }
        File[] files = mLogDirectory.listFiles((dir, name) -> name.endsWith(".log"));
        return files != null ? files.length : 0;
    }

    /**
     * Get the total size of all log files in bytes
     */
    public long getTotalLogSize() {
        if (mLogDirectory == null || !mLogDirectory.exists()) {
            return 0;
        }
        File[] files = mLogDirectory.listFiles((dir, name) -> name.endsWith(".log"));
        if (files == null) {
            return 0;
        }
        long total = 0;
        for (File file : files) {
            total += file.length();
        }
        return total;
    }
}
