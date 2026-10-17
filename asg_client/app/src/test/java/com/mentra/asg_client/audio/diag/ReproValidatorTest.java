package com.mentra.asg_client.audio.diag;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class ReproValidatorTest {

    private static ReproOp op(String id, ReproOp.Type type, String anchor, long delay, Map<String, Object> params) {
        return new ReproOp(id, type, anchor, delay, 0L, params);
    }

    private static ReproOp cue(String id, String anchor, long delay) {
        return op(id, ReproOp.Type.CUE, anchor, delay, Map.of("asset", "recording_start.wav"));
    }

    private static List<String> validate(String trialClass, List<ReproOp> ops, List<ReproOp> cleanup) {
        return ReproValidator.validate(
                new ReproTrial("t", "B", "c", trialClass, "R0", ops, cleanup, 0L, 0L, null));
    }

    private static List<ReproOp> validOps() {
        return new ArrayList<>(
                Arrays.asList(
                        op("w0", ReproOp.Type.WAIT_STATE, "trial.start", 0, Map.of("state", "bridge_closed")),
                        cue("q1", "w0.satisfied", 0),
                        op(
                                "c1",
                                ReproOp.Type.CAPTURE_START,
                                "q1.player_start",
                                100,
                                Map.of("source", "VOICE_COMMUNICATION", "rate", 48000, "ch", 1)),
                        op("s1", ReproOp.Type.CAPTURE_STOP, "q1.complete", 500, Map.of("capture", "c1")),
                        op("e1", ReproOp.Type.END, "q1.bridge_close", 300, Collections.emptyMap())));
    }

    private static List<ReproOp> validCleanup() {
        return Collections.singletonList(
                op("k1", ReproOp.Type.CAPTURE_STOP, "", 0, Map.of("capture", "c1")));
    }

    @Test
    public void acceptsAWellFormedTrial() {
        assertThat(validate("supported", validOps(), validCleanup())).isEmpty();
    }

    @Test
    public void rejectsUnknownProducersSelfAnchorsAndNegativeDelays() {
        List<ReproOp> ops = validOps();
        ops.set(1, cue("q1", "q9.complete", -5));
        ops.add(cue("q2", "q2.complete", 0));
        List<String> errors = validate("supported", ops, validCleanup());
        assertThat(String.join("\n", errors))
                .contains("q9 is not an op")
                .contains("negative delay")
                .contains("anchored on itself");
    }

    @Test
    public void rejectsCycles() {
        List<ReproOp> ops = validOps();
        ops.set(0, op("w0", ReproOp.Type.WAIT_STATE, "q1.complete", 0, Map.of("state", "bridge_closed")));
        assertThat(String.join("\n", validate("supported", ops, validCleanup()))).contains("anchor cycle");
    }

    @Test
    public void requiresExactlyOneEnd() {
        List<ReproOp> ops = validOps();
        ops.remove(ops.size() - 1);
        assertThat(String.join("\n", validate("supported", ops, validCleanup())))
                .contains("expected exactly one end op");
    }

    @Test
    public void restrictsSupportedTrialsToMilestoneOneCaptureAndCleanupRules() {
        List<ReproOp> ops = validOps();
        ops.set(
                2,
                op("c1", ReproOp.Type.CAPTURE_START, "q1.player_start", 0, Map.of("source", "CAMCORDER")));
        ops.add(op("x1", ReproOp.Type.STOP_PLAYBACK, "q1.player_start", 0, Collections.emptyMap()));
        String errors = String.join("\n", validate("supported", ops, validCleanup()));
        assertThat(errors).contains("capture source not allowed").contains("stop_playback is cleanup-only");
        assertThat(validate("fault_injection", ops, validCleanup())).isEmpty();
    }

    @Test
    public void rejectsBadCaptureReferencesAndAnchoredCleanup() {
        List<ReproOp> ops = validOps();
        ops.set(3, op("s1", ReproOp.Type.CAPTURE_STOP, "q1.complete", 0, Map.of("capture", "q1")));
        List<ReproOp> cleanup =
                Collections.singletonList(
                        op("k1", ReproOp.Type.CAPTURE_STOP, "q1.complete", 0, Map.of("capture", "c1")));
        String errors = String.join("\n", validate("supported", ops, cleanup));
        assertThat(errors).contains("capture must name a capture_start op").contains("no anchor");
    }
}
