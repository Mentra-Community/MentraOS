package com.mentra.asg_client.audio.diag;

import java.util.PriorityQueue;

/** Deterministic single-threaded loop and clock for scheduler tests. */
final class FakeLoop implements ReproScheduler.Loop, ReproScheduler.Clock {

    private static final class Task implements Comparable<Task> {
        final long atNs;
        final long seq;
        final Runnable runnable;

        Task(long atNs, long seq, Runnable runnable) {
            this.atNs = atNs;
            this.seq = seq;
            this.runnable = runnable;
        }

        @Override
        public int compareTo(Task other) {
            int byTime = Long.compare(atNs, other.atNs);
            return byTime != 0 ? byTime : Long.compare(seq, other.seq);
        }
    }

    private final PriorityQueue<Task> queue = new PriorityQueue<>();
    private long nowNs;
    private long seq;

    @Override
    public long nanoTime() {
        return nowNs;
    }

    @Override
    public void execute(Runnable task) {
        queue.add(new Task(nowNs, seq++, task));
    }

    @Override
    public void executeAt(long targetNs, Runnable task) {
        queue.add(new Task(Math.max(targetNs, nowNs), seq++, task));
    }

    /** A destination that runs {@code latencyMs} after the requested target. */
    ReproScheduler.Destination destination(long latencyMs) {
        return (targetNs, task) -> executeAt(targetNs + latencyMs * 1_000_000L, task);
    }

    void advanceToMs(long ms) {
        long target = ms * 1_000_000L;
        while (!queue.isEmpty() && queue.peek().atNs <= target) {
            Task task = queue.poll();
            nowNs = Math.max(nowNs, task.atNs);
            task.runnable.run();
        }
        nowNs = Math.max(nowNs, target);
    }

    void runPending() {
        advanceToMs(nowNs / 1_000_000L);
    }

    static long ms(long ms) {
        return ms * 1_000_000L;
    }
}
