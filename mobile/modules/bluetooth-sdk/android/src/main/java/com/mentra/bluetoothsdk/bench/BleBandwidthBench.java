package com.mentra.bluetoothsdk.bench;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.Handler;
import android.util.Log;
import com.mentra.bluetoothsdk.DeviceStore;

/**
 * Debug-only BLE photo bandwidth benchmark triggered automatically after the glasses link is
 * fully connected (BLE + audio, settings sync dispatched).
 *
 * <p>Enable (debuggable app installs only, on by default):
 *
 * <pre>
 *   DeviceStore.apply("bluetooth", "ble_bandwidth_bench_enabled", true);
 *   DeviceStore.apply("bluetooth", "ble_bandwidth_bench_size", "max");
 *   DeviceStore.apply("bluetooth", "ble_bandwidth_bench_every_connect", true);
 *   DeviceStore.apply("bluetooth", "ble_bandwidth_bench_max_attempts", 8);
 *   DeviceStore.apply("bluetooth", "ble_bandwidth_bench_retry_delay_ms", 5000);
 * </pre>
 *
 * <p>Filter logcat: {@code adb logcat | rg "BLE_BANDWIDTH_BENCH"}
 */
public final class BleBandwidthBench {

    public static final String TAG = "BleBandwidthBench";
    public static final String LOG_PREFIX = "BLE_BANDWIDTH_BENCH";

    public static final String KEY_ENABLED = "ble_bandwidth_bench_enabled";
    public static final String KEY_SIZE = "ble_bandwidth_bench_size";
    public static final String KEY_EVERY_CONNECT = "ble_bandwidth_bench_every_connect";
    public static final String KEY_MAX_ATTEMPTS = "ble_bandwidth_bench_max_attempts";
    public static final String KEY_RETRY_DELAY_MS = "ble_bandwidth_bench_retry_delay_ms";
    public static final String KEY_INITIAL_DELAY_MS = "ble_bandwidth_bench_initial_delay_ms";

    /** Wait for settings sync (incl. camera FOV/HAL restart) before first take_photo. */
    public static final long DEFAULT_DELAY_AFTER_FULLY_CONNECTED_MS = 10_000;
    public static final long DEFAULT_RETRY_DELAY_MS = 5_000;
    public static final int DEFAULT_MAX_ATTEMPTS = 8;

    private static volatile boolean succeededThisProcess = false;
    private static volatile boolean scheduledThisConnection = false;
    private static volatile int attemptCount = 0;

    private BleBandwidthBench() {}

    public static boolean isAppDebuggable(Context context) {
        if (context == null) {
            return false;
        }
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    public static boolean isExplicitlyEnabled() {
        Object flag = DeviceStore.INSTANCE.get("bluetooth", KEY_ENABLED);
        if (flag instanceof Boolean) {
            return (Boolean) flag;
        }
        return true;
    }

    public static boolean isEnabled(Context context) {
        return isAppDebuggable(context) && isExplicitlyEnabled();
    }

    public static boolean runEveryConnect() {
        Object flag = DeviceStore.INSTANCE.get("bluetooth", KEY_EVERY_CONNECT);
        return flag instanceof Boolean && (Boolean) flag;
    }

    public static boolean shouldSchedule(Context context) {
        if (!isEnabled(context)) {
            return false;
        }
        if (runEveryConnect()) {
            return true;
        }
        return !succeededThisProcess;
    }

    public static void markSucceeded() {
        succeededThisProcess = true;
    }

    public static void resetScheduleState() {
        scheduledThisConnection = false;
        attemptCount = 0;
    }

    public static int getAttemptCount() {
        return attemptCount;
    }

    /** Returns the attempt number for the run about to start (1-based). */
    public static int beginAttempt() {
        return ++attemptCount;
    }

    public static int getMaxAttempts() {
        Object value = DeviceStore.INSTANCE.get("bluetooth", KEY_MAX_ATTEMPTS);
        if (value instanceof Number) {
            int n = ((Number) value).intValue();
            if (n >= 1) {
                return n;
            }
        }
        return DEFAULT_MAX_ATTEMPTS;
    }

    public static long getRetryDelayMs() {
        Object value = DeviceStore.INSTANCE.get("bluetooth", KEY_RETRY_DELAY_MS);
        if (value instanceof Number) {
            long ms = ((Number) value).longValue();
            if (ms >= 0) {
                return ms;
            }
        }
        return DEFAULT_RETRY_DELAY_MS;
    }

    public static long getInitialDelayMs() {
        Object value = DeviceStore.INSTANCE.get("bluetooth", KEY_INITIAL_DELAY_MS);
        if (value instanceof Number) {
            long ms = ((Number) value).longValue();
            if (ms >= 0) {
                return ms;
            }
        }
        return DEFAULT_DELAY_AFTER_FULLY_CONNECTED_MS;
    }

    public static boolean canRetryAfterFailure() {
        return attemptCount < getMaxAttempts();
    }

    public static boolean isRetryableError(String errorCode, String errorMessage) {
        if (errorCode != null) {
            String code = errorCode.trim().toUpperCase();
            if ("CAMERA_BUSY".equals(code)) {
                return true;
            }
        }
        if (errorMessage != null) {
            String msg = errorMessage.toLowerCase();
            if (msg.contains("camera restarting")
                    || msg.contains("camera busy")
                    || msg.contains("hal restart")
                    || msg.contains("fov change")) {
                return true;
            }
        }
        return false;
    }

    public static String getPhotoSize() {
        Object size = DeviceStore.INSTANCE.get("bluetooth", KEY_SIZE);
        if (size instanceof String) {
            String s = ((String) size).trim();
            if (!s.isEmpty()) {
                return s;
            }
        }
        return "max";
    }

    public static boolean isBenchRequestId(String requestId) {
        return requestId != null && requestId.startsWith("ble-bench-");
    }

    /**
     * Schedule first {@code take_photo} bench after fully connected. Returns true if a new timer
     * was posted.
     */
    public static boolean scheduleAfterFullyConnected(
            Context context, Handler handler, Runnable trigger) {
        if (!shouldSchedule(context) || handler == null || trigger == null || scheduledThisConnection) {
            return false;
        }
        scheduledThisConnection = true;
        attemptCount = 0;
        long delayMs = getInitialDelayMs();
        Log.i(
                TAG,
                LOG_PREFIX
                        + " scheduled in "
                        + delayMs
                        + "ms after fully connected (maxAttempts="
                        + getMaxAttempts()
                        + ")");
        handler.postDelayed(trigger, delayMs);
        return true;
    }
}
