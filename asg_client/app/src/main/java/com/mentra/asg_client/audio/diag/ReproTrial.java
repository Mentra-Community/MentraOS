package com.mentra.asg_client.audio.diag;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** One trial: concrete anchored operations, cleanup, and labels used only for analysis. */
public final class ReproTrial {

    public static final String CLASS_SUPPORTED = "supported";
    public static final String CLASS_FAULT_INJECTION = "fault_injection";

    public final String id;
    public final String block;
    public final String cell;
    public final String trialClass;
    /** Reset level label (R0..R3); preconditions are expressed as explicit wait_state ops. */
    public final String reset;
    public final List<ReproOp> ops;
    /** Idempotent operations run once, immediately, whenever the trial ends. */
    public final List<ReproOp> cleanup;
    /** Delay before this trial starts, after the previous one finished; negative uses the default. */
    public final long preDelayMs;
    /** Failsafe bound, or 0 for the sequence default. */
    public final long maxDurationMs;
    /** Expected bridge classification per cue op (for example {@code reused:ready}). */
    public final Map<String, String> expect;

    public ReproTrial(
            String id,
            String block,
            String cell,
            String trialClass,
            String reset,
            List<ReproOp> ops,
            List<ReproOp> cleanup,
            long preDelayMs,
            long maxDurationMs,
            Map<String, String> expect) {
        this.id = id;
        this.block = block == null ? "" : block;
        this.cell = cell == null ? "" : cell;
        this.trialClass = trialClass == null ? CLASS_SUPPORTED : trialClass;
        this.reset = reset == null ? "" : reset;
        this.ops = Collections.unmodifiableList(new ArrayList<>(ops));
        this.cleanup =
                Collections.unmodifiableList(
                        new ArrayList<>(cleanup == null ? Collections.emptyList() : cleanup));
        this.preDelayMs = preDelayMs;
        this.maxDurationMs = maxDurationMs;
        this.expect = expect == null ? Collections.emptyMap() : Collections.unmodifiableMap(expect);
    }

    public ReproOp op(String opId) {
        for (ReproOp op : ops) {
            if (op.id.equals(opId)) return op;
        }
        return null;
    }
}
