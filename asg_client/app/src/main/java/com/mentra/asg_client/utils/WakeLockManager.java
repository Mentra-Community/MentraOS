package com.mentra.asg_client.utils;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;

import com.mentra.asg_client.MainActivity;
import com.mentra.asg_client.logging.BleTraceLogger;

import org.json.JSONObject;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Owner-keyed wake leases. Every subsystem that needs the SoC (or screen) awake holds its
 * OWN lease, backed by its own {@link PowerManager.WakeLock}: the kernel keeps the CPU up
 * while ANY lease is held and lets it sleep when the last one ends, so no arbitration logic
 * lives here. {@link #release(WakeOwner)} can only end that owner's leases — the historical
 * single shared lock let any subsystem's release (notably the old releaseAllWakeLocks())
 * silently revoke every other subsystem's protection, which is exactly what put the SoC to
 * sleep mid-OTA and mid-upload.
 *
 * Acquires are extend-only per owner: a shorter acquire never cuts short a longer-lived
 * lease already held by the same owner; a longer one pushes the deadline out.
 *
 * Every lease transition (acquire / extend / release / expiry) is emitted on the lifecycle
 * trace channel (BleTraceLogger.logLifecycle, component "WakeLockManager") with the full
 * set of currently-held leases, so incident logs show exactly which lease died and what
 * was left holding when the device slept.
 */
public class WakeLockManager {
    private static final String TAG = "WakeLockManager";

    /**
     * Every wake-lease owner in asg_client. One entry per subsystem: release(owner) can
     * only end that owner's leases, and per-owner lock tags (AugmentOS:Cpu:CAMERA, ...)
     * make dumpsys power / batterystats attribute wake time to the right subsystem.
     */
    public enum WakeOwner {
        /** Wake-flagged (W:1) phone command grant — see AsgConstants.PHONE_WAKE_COMMAND_WINDOW_MS. */
        PHONE_COMMAND,
        /** Camera open/capture window (CameraNeoService). */
        CAMERA,
        /** RTMP/SRT/WHIP streaming session. */
        STREAMING,
        /** BES firmware UART transfer (BesOtaManager). */
        BES_OTA,
        /** MTK/APK OTA install (OtaHelper). */
        MTK_OTA,
        /** Battery announcement while asleep (ButtonEventSubscriber). */
        BATTERY_ANNOUNCE,
        /** Boot-time service startup window (BootstrapActivity). */
        BOOTSTRAP,
    }

    private static final class Lease {
        final PowerManager.WakeLock lock;
        final long deadlineMs; // SystemClock.elapsedRealtime()-based

        Lease(PowerManager.WakeLock lock, long deadlineMs) {
            this.lock = lock;
            this.deadlineMs = deadlineMs;
        }
    }

    // Guards the lease maps so extend-only deadline checks are race-free across the
    // threads that acquire (command processors, camera/streaming/OTA workers).
    private static final Object LOCK = new Object();

    private static final Map<WakeOwner, Lease> sCpuLeases = new EnumMap<>(WakeOwner.class);
    private static final Map<WakeOwner, Lease> sScreenLeases = new EnumMap<>(WakeOwner.class);

    // Expiry watcher: WakeLock.acquire(timeout) expires inside the OS with no callback,
    // so a main-looper check at each lease's deadline emits the wake_expire trace event.
    private static final Handler sExpiryHandler = new Handler(Looper.getMainLooper());

    // Application context captured on first acquire so release()/expiry can emit trace
    // events without every caller having to thread a Context through.
    private static volatile Context sAppContext;

    /**
     * Acquire (or extend) the owner's CPU lease. Extend-only: if the owner already holds
     * a CPU lease whose deadline is at or beyond the requested one, the existing lease is
     * kept and this call is a no-op.
     *
     * @return true if the owner holds a CPU lease covering at least timeoutMs on return
     */
    public static boolean acquireCpu(@NonNull Context context, @NonNull WakeOwner owner, long timeoutMs) {
        return acquire(context, owner, timeoutMs, false);
    }

    /**
     * Acquire (or extend) the owner's screen lease (turns the screen on and keeps it on).
     * Same extend-only semantics as {@link #acquireCpu}.
     */
    public static boolean acquireScreen(@NonNull Context context, @NonNull WakeOwner owner, long timeoutMs) {
        return acquire(context, owner, timeoutMs, true);
    }

    /** Acquire both CPU and screen leases for the owner. */
    public static boolean acquireFull(@NonNull Context context, @NonNull WakeOwner owner,
                                      long cpuTimeoutMs, long screenTimeoutMs) {
        boolean cpu = acquireCpu(context, owner, cpuTimeoutMs);
        boolean screen = acquireScreen(context, owner, screenTimeoutMs);
        return cpu && screen;
    }

    /**
     * Release the owner's leases (CPU and screen). Other owners' leases are untouched —
     * the device stays awake until the LAST lease is released or expires.
     *
     * @return true if no lease remains held by this owner on return
     */
    public static boolean release(@NonNull WakeOwner owner) {
        boolean cpuOk = releaseOne(owner, false);
        boolean screenOk = releaseOne(owner, true);
        return cpuOk && screenOk;
    }

    /**
     * Acquire both leases for the owner and bring the app to the foreground if needed.
     * Camera operations require the app to be in the foreground to avoid "Camera disabled
     * by policy" errors.
     */
    public static boolean acquireFullWakeLockAndBringToForeground(@NonNull Context context,
                                                                  @NonNull WakeOwner owner,
                                                                  long cpuTimeoutMs,
                                                                  long screenTimeoutMs) {
        try {
            if (!isAppInForeground(context)) {
                Log.d(TAG, "App not in foreground, attempting to bring to front");
                if (!bringAppToForeground(context)) {
                    Log.w(TAG, "Failed to bring app to foreground, continuing with wake leases");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error checking/bringing app to foreground", e);
        }
        return acquireFull(context, owner, cpuTimeoutMs, screenTimeoutMs);
    }

    private static boolean acquire(@NonNull Context context, @NonNull WakeOwner owner,
                                   long timeoutMs, boolean screen) {
        sAppContext = context.getApplicationContext();
        synchronized (LOCK) {
            try {
                PowerManager powerManager =
                        (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (powerManager == null) {
                    Log.e(TAG, "PowerManager is null");
                    return false;
                }

                Map<WakeOwner, Lease> leases = screen ? sScreenLeases : sCpuLeases;
                long now = SystemClock.elapsedRealtime();
                long requestedDeadlineMs = now + timeoutMs;

                Lease existing = leases.get(owner);
                boolean extend = existing != null && existing.lock.isHeld();
                if (extend && requestedDeadlineMs <= existing.deadlineMs) {
                    // Extend-only: a shorter acquire must not cut short the owner's
                    // longer-lived lease (e.g. a 60s utility acquire during a 10-min OTA).
                    Log.d(TAG, kind(screen) + " lease for " + owner + " keeps existing deadline (remaining "
                            + (existing.deadlineMs - now) + "ms >= requested " + timeoutMs + "ms)");
                    return true;
                }
                if (extend) {
                    existing.lock.release();
                }

                int flags = screen
                        ? PowerManager.FULL_WAKE_LOCK
                                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                | PowerManager.ON_AFTER_RELEASE
                        : PowerManager.PARTIAL_WAKE_LOCK;
                String tag = "AugmentOS:" + (screen ? "Screen:" : "Cpu:") + owner;
                PowerManager.WakeLock lock = powerManager.newWakeLock(flags, tag);
                lock.acquire(timeoutMs);
                leases.put(owner, new Lease(lock, requestedDeadlineMs));
                scheduleExpiryCheck(owner, screen, requestedDeadlineMs);

                traceLease(extend ? "wake_extend" : "wake_acquire", owner, screen, timeoutMs);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "Error acquiring " + kind(screen) + " lease for " + owner, e);
                return false;
            }
        }
    }

    private static boolean releaseOne(@NonNull WakeOwner owner, boolean screen) {
        synchronized (LOCK) {
            try {
                Map<WakeOwner, Lease> leases = screen ? sScreenLeases : sCpuLeases;
                Lease lease = leases.remove(owner);
                if (lease == null) {
                    return true;
                }
                long remainingMs =
                        Math.max(0, lease.deadlineMs - SystemClock.elapsedRealtime());
                if (lease.lock.isHeld()) {
                    lease.lock.release();
                    traceLease("wake_release", owner, screen, remainingMs);
                }
                return true;
            } catch (Exception e) {
                Log.e(TAG, "Error releasing " + kind(screen) + " lease for " + owner, e);
                return false;
            }
        }
    }

    // OBSERVATIONAL ONLY: if the expiring CPU lease was the last partial wake lock, the
    // device can suspend right at the kernel deadline and this main-looper callback runs
    // only on the next wake (lateMs in the event shows the gap), or not at all if a
    // re-acquire lands first. The authoritative expiry moment is the deadlineWallMs
    // advertised in the wake_acquire / wake_extend event; treat wake_expire as a
    // best-effort confirmation, never as the primary signal.
    private static void scheduleExpiryCheck(WakeOwner owner, boolean screen, long deadlineMs) {
        long delayMs = Math.max(0, deadlineMs - SystemClock.elapsedRealtime()) + 250;
        sExpiryHandler.postDelayed(() -> {
            synchronized (LOCK) {
                Map<WakeOwner, Lease> leases = screen ? sScreenLeases : sCpuLeases;
                Lease lease = leases.get(owner);
                // Only the watcher for the lease's CURRENT deadline reports; an extend
                // re-schedules its own watcher and this stale one must stay silent.
                if (lease != null && lease.deadlineMs == deadlineMs && !lease.lock.isHeld()) {
                    leases.remove(owner);
                    traceLease(
                            "wake_expire",
                            owner,
                            screen,
                            0,
                            SystemClock.elapsedRealtime() - deadlineMs);
                }
            }
        }, delayMs);
    }

    /** Emit a lease transition on the lifecycle trace channel. Never throws. */
    private static void traceLease(String event, WakeOwner owner, boolean screen, long timeoutOrRemainingMs) {
        traceLease(event, owner, screen, timeoutOrRemainingMs, null);
    }

    private static void traceLease(
            String event, WakeOwner owner, boolean screen, long timeoutOrRemainingMs, Long lateMs) {
        try {
            JSONObject extra = new JSONObject();
            extra.put("owner", owner.name());
            extra.put("kind", kind(screen));
            extra.put("ms", timeoutOrRemainingMs);
            if ("wake_acquire".equals(event) || "wake_extend".equals(event)) {
                // Authoritative expiry moment for this lease; wake_expire is observational
                // (may fire late across a suspend, or be absorbed by a re-acquire).
                extra.put("deadlineWallMs", System.currentTimeMillis() + timeoutOrRemainingMs);
            }
            if (lateMs != null) {
                extra.put("lateMs", lateMs);
            }
            extra.put("held", heldLeasesLocked());
            BleTraceLogger.logLifecycle(sAppContext, "WakeLockManager", event, extra);
        } catch (Exception e) {
            Log.w(TAG, "Failed to trace lease event " + event, e);
        }
    }

    /** Comma-joined "OWNER:kind" list of currently held leases. Caller holds LOCK. */
    private static String heldLeasesLocked() {
        StringBuilder held = new StringBuilder();
        for (Map.Entry<WakeOwner, Lease> e : sCpuLeases.entrySet()) {
            if (e.getValue().lock.isHeld()) {
                if (held.length() > 0) held.append(',');
                held.append(e.getKey().name()).append(":cpu");
            }
        }
        for (Map.Entry<WakeOwner, Lease> e : sScreenLeases.entrySet()) {
            if (e.getValue().lock.isHeld()) {
                if (held.length() > 0) held.append(',');
                held.append(e.getKey().name()).append(":screen");
            }
        }
        return held.length() == 0 ? "none" : held.toString();
    }

    private static String kind(boolean screen) {
        return screen ? "screen" : "cpu";
    }

    /**
     * Check if the application is currently in the foreground.
     */
    private static boolean isAppInForeground(@NonNull Context context) {
        try {
            ActivityManager activityManager =
                    (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (activityManager == null) {
                Log.w(TAG, "ActivityManager is null, assuming app not in foreground");
                return false;
            }

            List<ActivityManager.RunningAppProcessInfo> processes =
                    activityManager.getRunningAppProcesses();
            if (processes == null) {
                Log.w(TAG, "Running processes list is null");
                return false;
            }

            String packageName = context.getPackageName();
            for (ActivityManager.RunningAppProcessInfo process : processes) {
                if (packageName.equals(process.processName)) {
                    boolean isInForeground = process.importance
                            == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
                    Log.d(TAG, "App foreground status: " + isInForeground
                            + " (importance: " + process.importance + ")");
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
