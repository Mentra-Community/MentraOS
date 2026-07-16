package com.mentra.asg_client.utils;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;

import com.mentra.asg_client.MainActivity;

import java.util.List;

/**
 * Utility class for managing wake locks across the application.
 * Provides methods to acquire and release different types of wake locks
 * to keep the device CPU running or screen on for specific operations.
 */
public class WakeLockManager {
    private static final String TAG = "WakeLockManager";
    
    // Default tag prefixes for wake locks
    private static final String DEFAULT_CPU_WAKE_LOCK_TAG = "AugmentOS:CpuWakeLock";
    private static final String DEFAULT_SCREEN_WAKE_LOCK_TAG = "AugmentOS:ScreenWakeLock";
    
    // Default timeouts
    private static final long DEFAULT_CPU_TIMEOUT_MS = 60000; // 60 seconds
    private static final long DEFAULT_SCREEN_TIMEOUT_MS = 15000; // 15 seconds

    // Awake window granted per wake-flagged phone command ("W":1 string wrapper or FLAG_WAKE
    // binary frame). The BES only pulses the MTK power key for these when the SoC is already
    // asleep, so a command landing mid-awake-window gets no extra time — this window is the
    // in-band equivalent. Must outlive the longest command follow-up that runs on
    // suspend-frozen clocks: the wifi credentials flow sends its failure verdict at ~12.4s
    // (3s + 3x3s status polls), so 15s covers it with margin.
    public static final long PHONE_WAKE_COMMAND_WINDOW_MS = 15000;
    
    // Static wake lock instances for sharing across the app
    private static PowerManager.WakeLock sCpuWakeLock;
    private static PowerManager.WakeLock sScreenWakeLock;

    // Guards acquire/release so the extend-only deadline checks below are race-free when called
    // from multiple threads (OTA worker, main looper, camera/streaming threads).
    private static final Object LOCK = new Object();

    // Absolute deadlines (SystemClock.elapsedRealtime() based) for the currently-held locks.
    // Used to implement extend-only acquisition: a shorter acquire never shortens a longer-lived
    // lock that is already held. 0 means "no deadline tracked / not held".
    private static long sCpuWakeLockDeadlineMs = 0;
    private static long sScreenWakeLockDeadlineMs = 0;

    /**
     * Acquire a CPU wake lock to keep the processor running.
     * This is useful for background operations that need to continue
     * even when the screen is off.
     *
     * @param context Application context
     * @return true if the wake lock was successfully acquired
     */
    public static boolean acquireCpuWakeLock(@NonNull Context context) {
        return acquireCpuWakeLock(context, DEFAULT_CPU_TIMEOUT_MS, DEFAULT_CPU_WAKE_LOCK_TAG);
    }

    /**
     * Acquire a CPU wake lock with a custom timeout.
     *
     * @param context Application context
     * @param timeoutMs Timeout in milliseconds
     * @return true if the wake lock was successfully acquired
     */
    public static boolean acquireCpuWakeLock(@NonNull Context context, long timeoutMs) {
        return acquireCpuWakeLock(context, timeoutMs, DEFAULT_CPU_WAKE_LOCK_TAG);
    }

    /**
     * Acquire a CPU wake lock with a custom timeout and tag.
     *
     * @param context Application context
     * @param timeoutMs Timeout in milliseconds
     * @param tag Tag for the wake lock (for debugging)
     * @return true if the wake lock was successfully acquired
     */
    public static boolean acquireCpuWakeLock(@NonNull Context context, long timeoutMs, String tag) {
        synchronized (LOCK) {
            try {
                PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (powerManager == null) {
                    Log.e(TAG, "PowerManager is null");
                    return false;
                }

                long now = SystemClock.elapsedRealtime();
                long requestedDeadlineMs = now + timeoutMs;

                // Extend-only: if a CPU wake lock is already held and its deadline is at or beyond
                // the one being requested, keep the existing (longer-lived) lock and ignore this
                // shorter acquire. Without this, a short acquire (e.g. a 60s camera/util lock)
                // stomps a long in-flight operation (e.g. a 10-min OTA) and lets the CPU — and the
                // MTK SoC — sleep mid-update, which is exactly what stalls OTA. We never shorten;
                // we only ever push the deadline further out.
                if (sCpuWakeLock != null && sCpuWakeLock.isHeld()
                        && requestedDeadlineMs <= sCpuWakeLockDeadlineMs) {
                    Log.d(TAG, "Keeping existing CPU wake lock (remaining "
                            + (sCpuWakeLockDeadlineMs - now) + "ms) >= requested " + timeoutMs
                            + "ms; ignoring shorter acquire");
                    return true;
                }

                // Extending to a later deadline: release the shorter-lived lock first.
                if (sCpuWakeLock != null && sCpuWakeLock.isHeld()) {
                    sCpuWakeLock.release();
                    Log.d(TAG, "Released existing CPU wake lock to extend deadline");
                }

                // Create and acquire a new wake lock
                sCpuWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag);
                sCpuWakeLock.acquire(timeoutMs);
                sCpuWakeLockDeadlineMs = requestedDeadlineMs;
                Log.d(TAG, "CPU wake lock acquired with timeout: " + timeoutMs + "ms");
                return true;
            } catch (Exception e) {
                Log.e(TAG, "Error acquiring CPU wake lock", e);
                return false;
            }
        }
    }

    /**
     * Acquire a screen wake lock to turn on and keep the screen on.
     * This is useful for operations that require the screen to be on
     * such as camera operations on some Android devices.
     *
     * @param context Application context
     * @return true if the wake lock was successfully acquired
     */
    public static boolean acquireScreenWakeLock(@NonNull Context context) {
        return acquireScreenWakeLock(context, DEFAULT_SCREEN_TIMEOUT_MS, DEFAULT_SCREEN_WAKE_LOCK_TAG);
    }

    /**
     * Acquire a screen wake lock with a custom timeout.
     *
     * @param context Application context
     * @param timeoutMs Timeout in milliseconds
     * @return true if the wake lock was successfully acquired
     */
    public static boolean acquireScreenWakeLock(@NonNull Context context, long timeoutMs) {
        return acquireScreenWakeLock(context, timeoutMs, DEFAULT_SCREEN_WAKE_LOCK_TAG);
    }

    /**
     * Acquire a screen wake lock with a custom timeout and tag.
     *
     * @param context Application context
     * @param timeoutMs Timeout in milliseconds
     * @param tag Tag for the wake lock (for debugging)
     * @return true if the wake lock was successfully acquired
     */
    public static boolean acquireScreenWakeLock(@NonNull Context context, long timeoutMs, String tag) {
        synchronized (LOCK) {
            try {
                PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (powerManager == null) {
                    Log.e(TAG, "PowerManager is null");
                    return false;
                }

                long now = SystemClock.elapsedRealtime();
                long requestedDeadlineMs = now + timeoutMs;

                // Extend-only: keep the existing screen lock if it already outlives this request
                // (see acquireCpuWakeLock for the rationale — a shorter acquire must not cut a
                // longer-lived one short).
                if (sScreenWakeLock != null && sScreenWakeLock.isHeld()
                        && requestedDeadlineMs <= sScreenWakeLockDeadlineMs) {
                    Log.d(TAG, "Keeping existing screen wake lock (remaining "
                            + (sScreenWakeLockDeadlineMs - now) + "ms) >= requested " + timeoutMs
                            + "ms; ignoring shorter acquire");
                    return true;
                }

                // Extending to a later deadline: release the shorter-lived lock first.
                if (sScreenWakeLock != null && sScreenWakeLock.isHeld()) {
                    sScreenWakeLock.release();
                    Log.d(TAG, "Released existing screen wake lock to extend deadline");
                }

                // Create and acquire a new wake lock with flags to turn screen on
                sScreenWakeLock = powerManager.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK |
                        PowerManager.ACQUIRE_CAUSES_WAKEUP |
                        PowerManager.ON_AFTER_RELEASE,
                        tag);
                sScreenWakeLock.acquire(timeoutMs);
                sScreenWakeLockDeadlineMs = requestedDeadlineMs;
                Log.d(TAG, "Screen wake lock acquired with timeout: " + timeoutMs + "ms");
                return true;
            } catch (Exception e) {
                Log.e(TAG, "Error acquiring screen wake lock", e);
                return false;
            }
        }
    }

    /**
     * Acquire both CPU and screen wake locks at once.
     * This is a convenience method for operations that need
     * both the CPU to stay active and the screen to stay on.
     *
     * @param context Application context
     * @param cpuTimeoutMs Timeout for CPU wake lock in milliseconds
     * @param screenTimeoutMs Timeout for screen wake lock in milliseconds
     * @return true if both wake locks were successfully acquired
     */
    public static boolean acquireFullWakeLock(@NonNull Context context, long cpuTimeoutMs, long screenTimeoutMs) {
        boolean cpuSuccess = acquireCpuWakeLock(context, cpuTimeoutMs);
        boolean screenSuccess = acquireScreenWakeLock(context, screenTimeoutMs);
        return cpuSuccess && screenSuccess;
    }

    /**
     * Acquire both CPU and screen wake locks with default timeouts.
     *
     * @param context Application context
     * @return true if both wake locks were successfully acquired
     */
    public static boolean acquireFullWakeLock(@NonNull Context context) {
        return acquireFullWakeLock(context, DEFAULT_CPU_TIMEOUT_MS, DEFAULT_SCREEN_TIMEOUT_MS);
    }

    /**
     * Release the CPU wake lock if it is currently held.
     *
     * @return true if the wake lock was released or wasn't held
     */
    public static boolean releaseCpuWakeLock() {
        synchronized (LOCK) {
            try {
                if (sCpuWakeLock != null && sCpuWakeLock.isHeld()) {
                    sCpuWakeLock.release();
                    Log.d(TAG, "CPU wake lock released");
                }
                sCpuWakeLock = null;
                sCpuWakeLockDeadlineMs = 0;
                return true;
            } catch (Exception e) {
                Log.e(TAG, "Error releasing CPU wake lock", e);
                return false;
            }
        }
    }

    /**
     * Release the screen wake lock if it is currently held.
     *
     * @return true if the wake lock was released or wasn't held
     */
    public static boolean releaseScreenWakeLock() {
        synchronized (LOCK) {
            try {
                if (sScreenWakeLock != null && sScreenWakeLock.isHeld()) {
                    sScreenWakeLock.release();
                    Log.d(TAG, "Screen wake lock released");
                }
                sScreenWakeLock = null;
                sScreenWakeLockDeadlineMs = 0;
                return true;
            } catch (Exception e) {
                Log.e(TAG, "Error releasing screen wake lock", e);
                return false;
            }
        }
    }

    /**
     * Release all wake locks (both CPU and screen).
     *
     * @return true if all wake locks were released successfully
     */
    public static boolean releaseAllWakeLocks() {
        boolean cpuSuccess = releaseCpuWakeLock();
        boolean screenSuccess = releaseScreenWakeLock();
        return cpuSuccess && screenSuccess;
    }

    /**
     * Acquire both CPU and screen wake locks and bring the app to foreground if needed.
     * This is specifically designed for camera operations that require the app to be
     * in the foreground to avoid "Camera disabled by policy" errors.
     *
     * @param context Application context
     * @param cpuTimeoutMs Timeout for CPU wake lock in milliseconds
     * @param screenTimeoutMs Timeout for screen wake lock in milliseconds
     * @return true if wake locks were acquired and app brought to foreground successfully
     */
    public static boolean acquireFullWakeLockAndBringToForeground(@NonNull Context context, long cpuTimeoutMs, long screenTimeoutMs) {
        try {
            // First, try to bring app to foreground if not already there
            if (!isAppInForeground(context)) {
                Log.d(TAG, "App not in foreground, attempting to bring to front");
                if (!bringAppToForeground(context)) {
                    Log.w(TAG, "Failed to bring app to foreground, continuing with wake locks");
                }
            } else {
                Log.d(TAG, "App already in foreground");
            }

            // Then acquire the wake locks as usual
            return acquireFullWakeLock(context, cpuTimeoutMs, screenTimeoutMs);
        } catch (Exception e) {
            Log.e(TAG, "Error in acquireFullWakeLockAndBringToForeground", e);
            // Fallback to just acquiring wake locks
            return acquireFullWakeLock(context, cpuTimeoutMs, screenTimeoutMs);
        }
    }

    /**
     * Check if the application is currently in the foreground.
     *
     * @param context Application context
     * @return true if the app is in the foreground, false otherwise
     */
    private static boolean isAppInForeground(@NonNull Context context) {
        try {
            ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (activityManager == null) {
                Log.w(TAG, "ActivityManager is null, assuming app not in foreground");
                return false;
            }

            List<ActivityManager.RunningAppProcessInfo> processes = activityManager.getRunningAppProcesses();
            if (processes == null) {
                Log.w(TAG, "Running processes list is null");
                return false;
            }

            String packageName = context.getPackageName();
            for (ActivityManager.RunningAppProcessInfo process : processes) {
                if (packageName.equals(process.processName)) {
                    boolean isInForeground = process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
                    Log.d(TAG, "App foreground status: " + isInForeground + " (importance: " + process.importance + ")");
                    return isInForeground;
                }
            }
            Log.d(TAG, "App process not found in running processes");
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error checking if app is in foreground", e);
            return false;
        }
    }

    /**
     * Bring the application to the foreground by starting the MainActivity.
     *
     * @param context Application context
     * @return true if the intent was successfully started, false otherwise
     */
    private static boolean bringAppToForeground(@NonNull Context context) {
        try {
            Intent intent = new Intent(context, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            
            context.startActivity(intent);
            Log.d(TAG, "Started MainActivity to bring app to foreground");
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error bringing app to foreground", e);
            return false;
        }
    }
}