package com.mentra.asg_client.io.media.core;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** Virtual-time scheduler for {@link CaptureWatchdog} and {@link PhotoPromptOccupancy} JVM tests. */
final class FakeCaptureScheduler
        implements CaptureWatchdog.Scheduler, PhotoPromptOccupancy.Scheduler {

    private static final class Scheduled {
        final Runnable runnable;
        final long fireAtMs;
        boolean cancelled;

        Scheduled(Runnable runnable, long fireAtMs) {
            this.runnable = runnable;
            this.fireAtMs = fireAtMs;
        }
    }

    private long nowMs;
    private final List<Scheduled> tasks = new ArrayList<>();

    @Override
    public synchronized void postDelayed(Runnable task, long delayMs) {
        tasks.add(new Scheduled(task, nowMs + delayMs));
    }

    @Override
    public synchronized void cancel(Runnable task) {
        for (Scheduled scheduled : tasks) {
            if (scheduled.runnable == task) {
                scheduled.cancelled = true;
            }
        }
    }

    void advance(long deltaMs) {
        List<Scheduled> due = takeDue(deltaMs);
        for (Scheduled scheduled : due) {
            scheduled.runnable.run();
        }
    }

    private synchronized List<Scheduled> takeDue(long deltaMs) {
        nowMs += deltaMs;
        List<Scheduled> due = new ArrayList<>();
        Iterator<Scheduled> iterator = tasks.iterator();
        while (iterator.hasNext()) {
            Scheduled scheduled = iterator.next();
            if (scheduled.cancelled) {
                iterator.remove();
                continue;
            }
            if (scheduled.fireAtMs <= nowMs) {
                due.add(scheduled);
                iterator.remove();
            }
        }
        return due;
    }
}
