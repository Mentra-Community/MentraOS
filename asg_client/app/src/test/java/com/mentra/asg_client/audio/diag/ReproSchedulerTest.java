package com.mentra.asg_client.audio.diag;

import static com.mentra.asg_client.audio.diag.FakeLoop.ms;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;

public class ReproSchedulerTest {

    private FakeLoop loop;
    private final List<ReproScheduler.ExecRecord> execs = new ArrayList<>();
    private final List<String> anomalies = new ArrayList<>();
    private final List<String> events = new ArrayList<>();
    private final List<String> ran = new ArrayList<>();
    private ReproScheduler.TrialResult result;
    private long mainLatencyMs;
    private ReproScheduler scheduler;

    @Before
    public void setUp() {
        loop = new FakeLoop();
        ReproScheduler.OpRunner runner =
                new ReproScheduler.OpRunner() {
                    @Override
                    public ReproScheduler.Destination destinationFor(ReproOp op) {
                        return op.type == ReproOp.Type.CUE
                                ? (target, task) -> loop.destination(mainLatencyMs).postAt(target, task)
                                : loop.destination(0);
                    }

                    @Override
                    public Object run(String trialId, ReproOp op) {
                        ran.add(op.id);
                        return op.type == ReproOp.Type.CUE ? 7L : null;
                    }
                };
        ReproScheduler.Listener listener =
                new ReproScheduler.Listener() {
                    @Override
                    public void onTrialStart(String trialId, long startNs) {}

                    @Override
                    public void onEvent(
                            String trialId, String key, long monoNs, Map<String, Object> fields) {
                        events.add(key);
                    }

                    @Override
                    public void onExec(ReproScheduler.ExecRecord record) {
                        execs.add(record);
                    }

                    @Override
                    public void onAnomaly(String trialId, String kind, String detail, long monoNs) {
                        anomalies.add(kind + ":" + detail);
                    }

                    @Override
                    public void onTrialEnd(ReproScheduler.TrialResult trialResult) {
                        result = trialResult;
                    }
                };
        scheduler = new ReproScheduler(loop, loop, runner, listener, 10_000L, 5L, 60_000L);
    }

    private static ReproOp op(String id, ReproOp.Type type, String anchor, long delayMs) {
        return new ReproOp(id, type, anchor, delayMs, 0L, Collections.emptyMap());
    }

    private static ReproTrial trial(List<ReproOp> ops, List<ReproOp> cleanup) {
        return new ReproTrial("t1", "A", "cell", "supported", "R0", ops, cleanup, 0L, 0L, null);
    }

    private ReproScheduler.ExecRecord exec(String opId) {
        for (ReproScheduler.ExecRecord record : execs) {
            if (record.opId.equals(opId)) return record;
        }
        return null;
    }

    @Test
    public void armsEachOperationFromItsAnchorAndAllowsOverlap() {
        ReproTrial trial =
                trial(
                        Arrays.asList(
                                op("q0", ReproOp.Type.CUE, "trial.start", 0),
                                op("q1", ReproOp.Type.CUE, "q0.complete", 300),
                                op("c1", ReproOp.Type.CAPTURE_START, "q1.player_start", 100),
                                op("m1", ReproOp.Type.MARK, "q1.player_start", 50),
                                op("s1", ReproOp.Type.CAPTURE_STOP, "q1.complete", 500),
                                op("e1", ReproOp.Type.END, "q1.bridge_close", 500)),
                        Collections.singletonList(op("k1", ReproOp.Type.CAPTURE_STOP, "", 0)));
        scheduler.startTrial(trial, null);
        loop.runPending();
        assertThat(ran).containsExactly("q0");

        loop.advanceToMs(1000);
        scheduler.event("q0.complete", ms(1000), null);
        loop.advanceToMs(1400);
        assertThat(exec("q1").beginNs).isEqualTo(ms(1300));

        scheduler.event("q1.player_start", ms(1400), null);
        loop.advanceToMs(1600);
        assertThat(exec("m1").beginNs).isEqualTo(ms(1450));
        assertThat(exec("c1").beginNs).isEqualTo(ms(1500));

        scheduler.event("q1.complete", ms(2000), null);
        scheduler.event("q1.bridge_close", ms(2750), null);
        loop.advanceToMs(4000);

        assertThat(exec("s1").beginNs).isEqualTo(ms(2500));
        assertThat(exec("e1").beginNs).isEqualTo(ms(3250));
        assertThat(exec("k1").cleanup).isTrue();
        assertThat(result.outcome).isEqualTo(ReproScheduler.TrialResult.COMPLETED);
        assertThat(result.flags).isEmpty();
        assertThat(events).contains("trial.start", "q0.exec", "q1.exec", "e1.exec");
        assertThat(anomalies).isEmpty();
    }

    @Test
    public void armsFromEmissionTimeNotDispatchTime() {
        ReproTrial trial =
                trial(
                        Arrays.asList(
                                op("q0", ReproOp.Type.CUE, "trial.start", 0),
                                op("m1", ReproOp.Type.MARK, "q0.player_start", 300),
                                op("e1", ReproOp.Type.END, "m1.exec", 0)),
                        null);
        scheduler.startTrial(trial, null);
        loop.advanceToMs(500);
        scheduler.event("q0.player_start", ms(400), null);
        loop.advanceToMs(1000);
        assertThat(exec("m1").targetNs).isEqualTo(ms(700));
        assertThat(exec("m1").beginNs).isEqualTo(ms(700));
    }

    @Test
    public void timestampsExecutionOnTheDestinationAndFlagsLateness() {
        mainLatencyMs = 12;
        ReproTrial trial =
                trial(
                        Arrays.asList(
                                op("q0", ReproOp.Type.CUE, "trial.start", 100),
                                op("e1", ReproOp.Type.END, "q0.exec", 0)),
                        null);
        scheduler.startTrial(trial, null);
        loop.advanceToMs(1000);
        ReproScheduler.ExecRecord q0 = exec("q0");
        assertThat(q0.postNs).isEqualTo(0L);
        assertThat(q0.targetNs).isEqualTo(ms(100));
        assertThat(q0.beginNs).isEqualTo(ms(112));
        assertThat(q0.late).isTrue();
        assertThat(result.flags).contains(ReproScheduler.FLAG_SCHEDULE_MISS);
    }

    @Test
    public void duplicateEventsAreAnomaliesAndNeverReArm() {
        ReproTrial trial =
                trial(
                        Arrays.asList(
                                op("q0", ReproOp.Type.CUE, "trial.start", 0),
                                op("q1", ReproOp.Type.CUE, "q0.complete", 0),
                                op("e1", ReproOp.Type.END, "q1.exec", 0)),
                        null);
        scheduler.startTrial(trial, null);
        loop.runPending();
        scheduler.event("q0.complete", ms(0), null);
        scheduler.event("q0.complete", ms(1), null);
        loop.advanceToMs(100);
        assertThat(ran).containsExactly("q0", "q1", "e1");
        assertThat(anomalies).containsExactly("duplicate_event:q0.complete");
    }

    @Test
    public void anchorTimeoutCancelsDependentsAndStillRunsCleanup() {
        ReproTrial trial =
                trial(
                        Arrays.asList(
                                op("q0", ReproOp.Type.CUE, "trial.start", 0),
                                op("q1", ReproOp.Type.CUE, "q0.complete", 0),
                                op("c1", ReproOp.Type.CAPTURE_START, "q1.player_start", 0),
                                op("e1", ReproOp.Type.END, "c1.exec", 0)),
                        Collections.singletonList(op("k1", ReproOp.Type.CAPTURE_STOP, "", 0)));
        scheduler.startTrial(trial, null);
        loop.advanceToMs(9_999);
        assertThat(result).isNull();
        loop.advanceToMs(40_000);
        assertThat(result.outcome).isEqualTo(ReproScheduler.TrialResult.ANCHOR_TIMEOUT);
        assertThat(result.flags).contains(ReproScheduler.FLAG_ANCHOR_TIMEOUT);
        assertThat(result.opStatus.get("q1")).startsWith("cancelled:anchor q0.complete");
        assertThat(result.opStatus.get("c1")).startsWith("cancelled:producer q1");
        assertThat(ran).containsExactly("q0", "k1");
    }

    @Test
    public void armedOperationsDoNotRunAfterTheTrialEnds() {
        ReproTrial trial =
                trial(
                        Arrays.asList(
                                op("q0", ReproOp.Type.CUE, "trial.start", 5_000),
                                op("e1", ReproOp.Type.END, "trial.start", 100)),
                        null);
        scheduler.startTrial(trial, null);
        loop.advanceToMs(10_000);
        assertThat(ran).containsExactly("e1");
        assertThat(result.opStatus.get("q0")).isEqualTo("cancelled:cancelled_after_arm");
    }

    @Test
    public void eventsAfterTheTrialAreLateAnomalies() {
        ReproTrial trial =
                trial(Collections.singletonList(op("e1", ReproOp.Type.END, "trial.start", 0)), null);
        scheduler.startTrial(trial, null);
        loop.advanceToMs(10);
        scheduler.event("q0.bridge_close", ms(10), null);
        loop.advanceToMs(20);
        assertThat(anomalies).contains("late_event:q0.bridge_close");
    }

    @Test
    public void trialTimeoutIsAFailsafe() {
        ReproTrial trial =
                new ReproTrial(
                        "t1",
                        "A",
                        "cell",
                        "supported",
                        "R0",
                        Arrays.asList(
                                op("q0", ReproOp.Type.CUE, "trial.start", 0),
                                new ReproOp(
                                        "e1",
                                        ReproOp.Type.END,
                                        "q0.complete",
                                        0,
                                        600_000L,
                                        Collections.emptyMap())),
                        null,
                        0L,
                        2_000L,
                        null);
        scheduler.startTrial(trial, null);
        loop.advanceToMs(3_000);
        assertThat(result.outcome).isEqualTo(ReproScheduler.TrialResult.TRIAL_TIMEOUT);
    }
}
