package com.mentra.asg_client.io.media.core;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Keyed timeout registry. Concurrent arms under different keys fire independently; re-arming the
 * same key replaces the prior timer.
 *
 * <p>Production wraps a {@code Handler}; tests supply a virtual-time {@link Scheduler}. Scheduler
 * calls are made without holding this monitor so a firing task cannot deadlock with {@link #arm}.
 */
final class CaptureWatchdog {

    interface Scheduler {
        void postDelayed(Runnable task, long delayMs);

        void cancel(Runnable task);
    }

    private final Scheduler scheduler;
    private final Map<String, Runnable> pending = new HashMap<>();

    CaptureWatchdog(Scheduler scheduler) {
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
    }

    void arm(String key, long timeoutMs, Runnable onTimeout) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(onTimeout, "onTimeout");
        Runnable task =
                new Runnable() {
                    @Override
                    public void run() {
                        boolean shouldFire;
                        synchronized (CaptureWatchdog.this) {
                            shouldFire = pending.get(key) == this;
                            if (shouldFire) {
                                pending.remove(key);
                            }
                        }
                        if (shouldFire) {
                            onTimeout.run();
                        }
                    }
                };
        Runnable replaced;
        synchronized (this) {
            replaced = pending.put(key, task);
        }
        if (replaced != null) {
            scheduler.cancel(replaced);
        }
        scheduler.postDelayed(task, timeoutMs);
        synchronized (this) {
            if (pending.get(key) != task) {
                scheduler.cancel(task);
            }
        }
    }

    void cancel(String key) {
        if (key == null) {
            return;
        }
        Runnable task;
        synchronized (this) {
            task = pending.remove(key);
        }
        if (task != null) {
            scheduler.cancel(task);
        }
    }
}
