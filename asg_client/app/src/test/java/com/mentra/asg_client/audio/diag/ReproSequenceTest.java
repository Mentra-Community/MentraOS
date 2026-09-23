package com.mentra.asg_client.audio.diag;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import android.app.Application;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class ReproSequenceTest {

    private static final String VALID =
            "{\"schema\":\"mentra.audio-repro.sequence/1\",\"run_id\":\"r-01\",\"seed\":1234,"
                    + "\"generator\":{\"name\":\"gen.py\"},"
                    + "\"defaults\":{\"anchor_timeout_ms\":9000,\"inter_trial_ms\":700},"
                    + "\"trials\":[{\"id\":\"t0007\",\"block\":\"B\",\"cell\":\"vc|start_during+100|reuse\","
                    + "\"class\":\"supported\",\"reset\":\"R0\",\"pre_delay_ms\":1200,"
                    + "\"expect\":{\"q1\":\"reused:ready\"},"
                    + "\"ops\":["
                    + "{\"id\":\"q0\",\"op\":\"cue\",\"at\":{\"anchor\":\"trial.start\",\"delay_ms\":0}},"
                    + "{\"id\":\"q1\",\"op\":\"cue\",\"at\":{\"anchor\":\"q0.complete\",\"delay_ms\":300}},"
                    + "{\"id\":\"c1\",\"op\":\"capture_start\",\"source\":\"VOICE_COMMUNICATION\",\"rate\":48000,"
                    + "\"ch\":1,\"at\":{\"anchor\":\"q1.player_start\",\"delay_ms\":100}},"
                    + "{\"id\":\"s1\",\"op\":\"capture_stop\",\"capture\":\"c1\","
                    + "\"at\":{\"anchor\":\"q1.complete\",\"delay_ms\":500}},"
                    + "{\"id\":\"e1\",\"op\":\"end\",\"timeout_ms\":12000,"
                    + "\"at\":{\"anchor\":\"q1.bridge_close\",\"delay_ms\":500}}],"
                    + "\"cleanup\":[{\"op\":\"capture_stop\",\"capture\":\"c1\"}]}]}";

    @Test
    public void parsesAConcreteSequence() throws Exception {
        ReproSequence sequence = ReproSequence.parse(new JSONObject(VALID));
        assertThat(sequence.runId).isEqualTo("r-01");
        assertThat(sequence.seed).isEqualTo(1234L);
        assertThat(sequence.anchorTimeoutMs).isEqualTo(9000L);
        assertThat(sequence.interTrialMs).isEqualTo(700L);
        ReproTrial trial = sequence.trials.get(0);
        assertThat(trial.preDelayMs).isEqualTo(1200L);
        assertThat(trial.expect).containsEntry("q1", "reused:ready");
        assertThat(trial.op("q0").stringParam("asset", "")).isEqualTo("recording_start.wav");
        assertThat(trial.op("c1").stringParam("source", "")).isEqualTo("VOICE_COMMUNICATION");
        assertThat(trial.op("c1").anchor).isEqualTo("q1.player_start");
        assertThat(trial.op("c1").delayMs).isEqualTo(100L);
        assertThat(trial.op("e1").timeoutMs).isEqualTo(12000L);
        assertThat(trial.cleanup.get(0).id).isEqualTo("cleanup0");
    }

    @Test
    public void rejectsInvalidSequencesWithEveryError() {
        String bad = VALID.replace("mentra.audio-repro.sequence/1", "other/2").replace("q0.complete", "q9.complete");
        assertThatThrownBy(() -> ReproSequence.parse(new JSONObject(bad)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unsupported schema")
                .hasMessageContaining("q9 is not an op");
    }
}
