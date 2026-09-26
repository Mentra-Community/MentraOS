package com.mentra.asg_client.audio.diag;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Event-driven scheduler for one trial at a time.
 *
 * <p>All scheduler state is confined to the {@link Loop} thread. Events may be reported from any
 * thread through {@link #event}; they carry the timestamp taken where they were emitted, so arming
 * is computed from emission time rather than hand-off time. Each operation is armed independently
 * when its anchor event arrives and posted to its own {@link Destination}, so operations overlap
 * freely. Execution is timestamped on the destination thread, immediately around the operation.
 *
 * <p>Every event key is {@code <producer>.<event>} and may occur once per trial; repeats are
 * recorded as {@code duplicate_event} anomalies and never re-arm anything.
 */
public final class ReproScheduler {

    public interface Clock {
        long nanoTime();
    }

    /** The scheduler's own thread. */
    public interface Loop {
        void execute(Runnable task);

        void executeAt(long targetNs, Runnable task);
    }

    /** The thread an operation runs on. */
    public interface Destination {
        void postAt(long targetNs, Runnable task);
    }

    public interface OpRunner {
        Destination destinationFor(ReproOp op);

        /** Runs on the destination thread; the return value is recorded. */
        Object run(String trialId, ReproOp op) throws Exception;

        /** Runs on the loop thread after a successful {@link #run}, before the exec event. */
        default void afterRun(String trialId, ReproOp op, Object result) {}
    }

    public interface Listener {
        void onTrialStart(String trialId, long startNs);

        void onEvent(String trialId, String key, long monoNs, Map<String, Object> fields);

        void onExec(ExecRecord record);

        void onAnomaly(String trialId, String kind, String detail, long monoNs);

        void onTrialEnd(TrialResult result);
    }

    /** Timing of one executed operation, all in CLOCK_MONOTONIC nanoseconds. */
    public static final class ExecRecord {
        public final String trialId;
        public final String opId;
        public final String type;
        public final boolean cleanup;
        public final String anchorKey;
        public final long anchorNs;
        public final long targetNs;
        public final long postNs;
        public final long beginNs;
        public final long endNs;
        public final String result;
        public final String error;
        public final boolean late;

        ExecRecord(
                String trialId,
                ReproOp op,
                boolean cleanup,
                String anchorKey,
                long anchorNs,
                long targetNs,
                long postNs,
                long beginNs,
                long endNs,
                Object result,
                Throwable error,
                boolean late) {
            this.trialId = trialId;
            this.opId = op.id;
            this.type = op.type.wireName;
            this.cleanup = cleanup;
            this.anchorKey = anchorKey;
            this.anchorNs = anchorNs;
            this.targetNs = targetNs;
            this.postNs = postNs;
            this.beginNs = beginNs;
            this.endNs = endNs;
            this.result = result == null ? null : String.valueOf(result);
            this.error = error == null ? null : error.getClass().getSimpleName() + ": " + error.getMessage();
            this.late = late;
        }

        public long latenessNs() {
            return beginNs - targetNs;
        }
    }

    public static final class TrialResult {
        public static final String COMPLETED = "completed";
        public static final String ANCHOR_TIMEOUT = "anchor_timeout";
        public static final String TRIAL_TIMEOUT = "trial_timeout";
        public static final String ABORTED = "aborted";

        public final String trialId;
        public final String outcome;
        public final Set<String> flags;
        public final long startNs;
        public final long endNs;
        /** Final status per operation: done, failed, cancelled, not_reached, or running. */
        public final Map<String, String> opStatus;

        TrialResult(
                String trialId,
                String outcome,
                Set<String> flags,
                long startNs,
                long endNs,
                Map<String, String> opStatus) {
            this.trialId = trialId;
            this.outcome = outcome;
            this.flags = Collections.unmodifiableSet(flags);
            this.startNs = startNs;
            this.endNs = endNs;
            this.opStatus = Collections.unmodifiableMap(opStatus);
        }
    }

    public static final String FLAG_SCHEDULE_MISS = "schedule_miss";
    public static final String FLAG_ANCHOR_TIMEOUT = "anchor_timeout";
    public static final String FLAG_OP_FAILED = "op_failed";

    private static final int WAITING = 0;
    private static final int ARMED = 1;
    private static final int RUNNING = 2;
    private static final int DONE = 3;
    private static final int FAILED = 4;
    private static final int CANCELLED = 5;

    private final Clock clock;
    private final Loop loop;
    private final OpRunner runner;
    private final Listener listener;
    private final long defaultAnchorTimeoutNs;
    private final long lateToleranceNs;
    private final long defaultMaxTrialNs;

    private TrialState current;
    private String lastTrialId;

    public ReproScheduler(
            Clock clock,
            Loop loop,
            OpRunner runner,
            Listener listener,
            long defaultAnchorTimeoutMs,
            long lateToleranceMs,
            long defaultMaxTrialMs) {
        this.clock = clock;
        this.loop = loop;
        this.runner = runner;
        this.listener = listener;
        this.defaultAnchorTimeoutNs = defaultAnchorTimeoutMs * 1_000_000L;
        this.lateToleranceNs = lateToleranceMs * 1_000_000L;
        this.defaultMaxTrialNs = defaultMaxTrialMs * 1_000_000L;
    }

    /** Start a trial; {@code onFinished} runs on the loop after cleanup completes. */
    public void startTrial(ReproTrial trial, Runnable onFinished) {
        loop.execute(() -> startOnLoop(trial, onFinished));
    }

    /** Report an event from any thread. */
    public void event(String key, long monoNs, Map<String, Object> fields) {
        Map<String, Object> copy =
                fields == null ? Collections.emptyMap() : new LinkedHashMap<>(fields);
        loop.execute(() -> eventOnLoop(key, monoNs, copy));
    }

    /** End the current trial now, running its cleanup. */
    public void abort() {
        loop.execute(() -> {
            TrialState t = current;
            if (t != null) finish(t, TrialResult.ABORTED);
        });
    }

    private void startOnLoop(ReproTrial trial, Runnable onFinished) {
        if (current != null) {
            listener.onAnomaly(trial.id, "trial_overlap", "previous=" + current.trial.id, clock.nanoTime());
            return;
        }
        TrialState t = new TrialState(trial, onFinished);
        current = t;
        lastTrialId = trial.id;
        for (ReproOp op : trial.ops) {
            OpState s = new OpState(op);
            t.ops.put(op.id, s);
            t.pendingByAnchor.computeIfAbsent(op.anchor, k -> new ArrayList<>()).add(s);
        }
        t.startNs = clock.nanoTime();
        listener.onTrialStart(trial.id, t.startNs);
        long maxNs = trial.maxDurationMs > 0 ? trial.maxDurationMs * 1_000_000L : defaultMaxTrialNs;
        loop.executeAt(t.startNs + maxNs, () -> {
            if (current == t && !t.ending) finish(t, TrialResult.TRIAL_TIMEOUT);
        });
        deliver(t, ReproOp.TRIAL_START, t.startNs, Collections.emptyMap());
        activateProducer(t, ReproOp.TRIAL_PRODUCER, t.startNs);
    }

    private void eventOnLoop(String key, long monoNs, Map<String, Object> fields) {
        TrialState t = current;
        if (t == null) {
            listener.onAnomaly(lastTrialId, "late_event", key, monoNs);
            return;
        }
        deliver(t, key, monoNs, fields);
    }

    private void deliver(TrialState t, String key, long monoNs, Map<String, Object> fields) {
        if (t.seen.putIfAbsent(key, monoNs) != null) {
            listener.onAnomaly(t.trial.id, "duplicate_event", key, monoNs);
            return;
        }
        listener.onEvent(t.trial.id, key, monoNs, fields);
        if (t.ending) return;
        List<OpState> waiting = t.pendingByAnchor.remove(key);
        if (waiting == null) return;
        for (OpState s : waiting) arm(t, s, key, monoNs);
    }

    private void arm(TrialState t, OpState s, String key, long anchorNs) {
        if (!s.status.compareAndSet(WAITING, ARMED)) return;
        s.anchorKey = key;
        s.anchorNs = anchorNs;
        s.targetNs = anchorNs + s.op.delayMs * 1_000_000L;
        s.postNs = clock.nanoTime();
        runner.destinationFor(s.op).postAt(s.targetNs, () -> runOnDestination(t, s, false));
    }

    private void runOnDestination(TrialState t, OpState s, boolean cleanup) {
        if (!cleanup && !s.status.compareAndSet(ARMED, RUNNING)) return;
        long begin = clock.nanoTime();
        Object result = null;
        Throwable error = null;
        try {
            result = runner.run(t.trial.id, s.op);
        } catch (Throwable e) {
            error = e;
        }
        long end = clock.nanoTime();
        Object finalResult = result;
        Throwable finalError = error;
        loop.execute(() -> onRan(t, s, cleanup, begin, end, finalResult, finalError));
    }

    private void onRan(
            TrialState t,
            OpState s,
            boolean cleanup,
            long begin,
            long end,
            Object result,
            Throwable error) {
        boolean late = !cleanup && begin - s.targetNs > lateToleranceNs;
        listener.onExec(
                new ExecRecord(
                        t.trial.id,
                        s.op,
                        cleanup,
                        s.anchorKey,
                        s.anchorNs,
                        s.targetNs,
                        s.postNs,
                        begin,
                        end,
                        result,
                        error,
                        late));
        if (cleanup) {
            if (--t.cleanupRemaining == 0) complete(t);
            return;
        }
        s.status.set(error == null ? DONE : FAILED);
        if (late) t.flags.add(FLAG_SCHEDULE_MISS);
        if (current != t) return;
        if (error == null) {
            runner.afterRun(t.trial.id, s.op, result);
            Map<String, Object> fields = new LinkedHashMap<>();
            if (result != null) fields.put("result", String.valueOf(result));
            deliver(t, s.op.id + ".exec", begin, fields);
        } else {
            t.flags.add(FLAG_OP_FAILED);
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("error", String.valueOf(error));
            deliver(t, s.op.id + ".failed", end, fields);
        }
        activateProducer(t, s.op.id, begin);
        if (error == null && s.op.type == ReproOp.Type.END) finish(t, TrialResult.COMPLETED);
    }

    /** Start anchor timeouts for operations waiting on events of {@code producer}. */
    private void activateProducer(TrialState t, String producer, long fromNs) {
        for (OpState s : t.ops.values()) {
            if (s.status.get() != WAITING || !producer.equals(s.op.anchorProducer())) continue;
            long timeoutNs = s.op.timeoutMs > 0 ? s.op.timeoutMs * 1_000_000L : defaultAnchorTimeoutNs;
            loop.executeAt(fromNs + timeoutNs, () -> {
                if (current == t && !t.ending && s.status.get() == WAITING) {
                    timeOut(t, s, "anchor " + s.op.anchor + " not observed");
                }
            });
        }
    }

    private void timeOut(TrialState t, OpState s, String reason) {
        if (!s.status.compareAndSet(WAITING, CANCELLED)) return;
        t.flags.add(FLAG_ANCHOR_TIMEOUT);
        t.cancelReasons.put(s.op.id, reason);
        listener.onAnomaly(t.trial.id, "anchor_timeout", s.op.id + ": " + reason, clock.nanoTime());
        if (s.op.type == ReproOp.Type.END) {
            finish(t, TrialResult.ANCHOR_TIMEOUT);
            return;
        }
        for (OpState dependent : t.ops.values()) {
            if (dependent.status.get() == WAITING && s.op.id.equals(dependent.op.anchorProducer())) {
                timeOut(t, dependent, "producer " + s.op.id + " cancelled");
                if (t.ending) return;
            }
        }
    }

    private void finish(TrialState t, String outcome) {
        if (t.ending) return;
        t.ending = true;
        t.outcome = outcome;
        for (OpState s : t.ops.values()) {
            if (s.status.compareAndSet(WAITING, CANCELLED)) {
                t.cancelReasons.putIfAbsent(s.op.id, "not_reached");
            } else if (s.status.compareAndSet(ARMED, CANCELLED)) {
                t.cancelReasons.putIfAbsent(s.op.id, "cancelled_after_arm");
            }
        }
        t.cleanupRemaining = t.trial.cleanup.size();
        if (t.cleanupRemaining == 0) {
            complete(t);
            return;
        }
        long now = clock.nanoTime();
        for (ReproOp op : t.trial.cleanup) {
            OpState s = new OpState(op);
            s.anchorKey = "cleanup";
            s.anchorNs = now;
            s.targetNs = now;
            s.postNs = now;
            runner.destinationFor(op).postAt(now, () -> runOnDestination(t, s, true));
        }
    }

    private void complete(TrialState t) {
        Map<String, String> status = new LinkedHashMap<>();
        for (OpState s : t.ops.values()) {
            status.put(s.op.id, statusName(s, t.cancelReasons.get(s.op.id)));
        }
        TrialResult result =
                new TrialResult(
                        t.trial.id,
                        t.outcome,
                        new LinkedHashSet<>(t.flags),
                        t.startNs,
                        clock.nanoTime(),
                        status);
        if (current == t) current = null;
        listener.onTrialEnd(result);
        if (t.onFinished != null) t.onFinished.run();
    }

    private static String statusName(OpState s, String cancelReason) {
        switch (s.status.get()) {
            case DONE:
                return "done";
            case FAILED:
                return "failed";
            case CANCELLED:
                return cancelReason == null ? "cancelled" : "cancelled:" + cancelReason;
            case RUNNING:
                return "running";
            default:
                return "not_reached";
        }
    }

    private static final class TrialState {
        final ReproTrial trial;
        final Runnable onFinished;
        final Map<String, OpState> ops = new LinkedHashMap<>();
        final Map<String, List<OpState>> pendingByAnchor = new HashMap<>();
        final Map<String, Long> seen = new HashMap<>();
        final Set<String> flags = new LinkedHashSet<>();
        final Map<String, String> cancelReasons = new HashMap<>();
        long startNs;
        boolean ending;
        String outcome;
        int cleanupRemaining;

        TrialState(ReproTrial trial, Runnable onFinished) {
            this.trial = trial;
            this.onFinished = onFinished;
        }
    }

    private static final class OpState {
        final ReproOp op;
        final AtomicInteger status = new AtomicInteger(WAITING);
        String anchorKey;
        long anchorNs = -1L;
        long targetNs;
        long postNs;

        OpState(ReproOp op) {
            this.op = op;
        }
    }
}
