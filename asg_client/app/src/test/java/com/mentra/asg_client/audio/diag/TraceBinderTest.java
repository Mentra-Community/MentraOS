package com.mentra.asg_client.audio.diag;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;

public class TraceBinderTest {

    private final List<String> events = new ArrayList<>();
    private final List<String> anomalies = new ArrayList<>();
    private TraceBinder binder;

    @Before
    public void setUp() {
        binder =
                new TraceBinder(
                        new TraceBinder.Output() {
                            @Override
                            public void event(String key, long monoNs, Map<String, Object> fields) {
                                events.add(key + "@" + monoNs);
                            }

                            @Override
                            public void anomaly(String kind, String detail, long monoNs) {
                                anomalies.add(kind);
                            }
                        });
    }

    private void raw(String event, long ns, Object... kv) {
        Map<String, Object> fields = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) fields.put((String) kv[i], kv[i + 1]);
        binder.onRaw(event, ns, fields);
    }

    @Test
    public void buffersTokenEventsUntilTheCueReturnsItsToken() {
        raw(AudioTraceBus.PLAYER_REQUEST, 10, "token", 5L);
        raw(AudioTraceBus.I2S_READY_BEGIN, 11, "request_id", 42);
        raw(AudioTraceBus.BRIDGE_OPEN_REQ, 12, "token", 5L, "request_id", 42);
        raw(AudioTraceBus.UART_I2S_CMD, 13, "request_id", 42, "command", "mh_starti2s");
        assertThat(events).isEmpty();

        binder.bindToken(5L, "q0");
        assertThat(events).containsExactly(
                "q0.player_request@10", "q0.bridge_open_req@12", "q0.uart_i2s_cmd@13");

        raw(AudioTraceBus.I2S_READY, 50, "request_id", 42, "ready", true);
        raw(AudioTraceBus.PLAYER_START, 51, "token", 5L);
        raw(AudioTraceBus.PLAYER_END, 600, "token", 5L, "reason", "complete");
        assertThat(events).contains(
                "q0.i2s_ready@50", "q0.player_start@51", "q0.end@600", "q0.complete@600");
        assertThat(anomalies).isEmpty();
    }

    @Test
    public void readyReuserDoesNotInheritEarlierReadinessButSharesTheClose() {
        raw(AudioTraceBus.BRIDGE_OPEN_REQ, 10, "token", 1L, "request_id", 7);
        binder.bindToken(1L, "q0");
        raw(AudioTraceBus.I2S_READY, 40, "request_id", 7, "ready", true);
        raw(AudioTraceBus.GRACE_BEGIN, 700, "request_id", 7);
        raw(AudioTraceBus.GRACE_CANCEL, 1000, "request_id", 7);
        raw(AudioTraceBus.BRIDGE_REUSED, 1001, "token", 2L, "reason", "ready", "request_id", 7);
        binder.bindToken(2L, "q1");
        raw(AudioTraceBus.GRACE_BEGIN, 1700, "request_id", 7);
        raw(AudioTraceBus.BRIDGE_CLOSE, 2450, "request_id", 7);

        assertThat(events).contains("q1.bridge_reused@1001", "q1.grace_begin@1700", "q1.bridge_close@2450");
        assertThat(events).doesNotContain("q1.i2s_ready@40");
        assertThat(events).contains("q0.grace_begin@700", "q0.bridge_close@2450");
        assertThat(events).doesNotContain("q0.grace_begin@1700");
    }

    @Test
    public void pendingReuserReceivesTheLaterReadiness() {
        raw(AudioTraceBus.BRIDGE_OPEN_REQ, 10, "token", 1L, "request_id", 9);
        binder.bindToken(1L, "q0");
        raw(AudioTraceBus.PLAYER_END, 15, "token", 1L, "reason", "stopped");
        raw(AudioTraceBus.BRIDGE_REUSED, 15, "token", 2L, "reason", "pending", "request_id", 9);
        binder.bindToken(2L, "q1");
        raw(AudioTraceBus.I2S_READY, 60, "request_id", 9, "ready", true);
        assertThat(events).contains("q0.stopped@15", "q1.bridge_reused@15", "q1.i2s_ready@60", "q0.i2s_ready@60");
    }

    @Test
    public void reportsUnclaimedAndUnattributedPlayback() {
        raw(AudioTraceBus.PLAYER_REQUEST, 10, "token", 99L);
        raw(AudioTraceBus.BRIDGE_OPEN_REQ, 11, "token", 0L, "request_id", 3);
        binder.endTrial();
        assertThat(anomalies).containsExactly("unattributed_bridge_open_req", "foreign_playback");
    }

    @Test
    public void bindingsDoNotLeakIntoTheNextTrial() {
        raw(AudioTraceBus.BRIDGE_OPEN_REQ, 10, "token", 1L, "request_id", 4);
        binder.bindToken(1L, "q0");
        binder.endTrial();
        raw(AudioTraceBus.BRIDGE_CLOSE, 900, "request_id", 4);
        assertThat(events).containsExactly("q0.bridge_open_req@10");
    }
}
