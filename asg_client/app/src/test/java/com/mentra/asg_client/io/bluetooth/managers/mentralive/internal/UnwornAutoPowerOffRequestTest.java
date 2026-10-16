package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/** Exercises the real acknowledgment state machine without opening serial hardware. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class UnwornAutoPowerOffRequestTest {
    private final Object session = new Object();
    private final AtomicLong clock = new AtomicLong();
    private final List<UnwornAutoPowerOffRequest.Result> results = new ArrayList<>();
    private UnwornAutoPowerOffRequest request;

    @Before
    public void setUp() {
        request = new UnwornAutoPowerOffRequest(new Handler(Looper.getMainLooper()), clock::get);
    }

    @Test
    public void unclaimedRepliesRemainAvailableForPhoneForwarding() {
        assertThat(request.reply(session, 0, 11, 0)).isFalse();
        var token = request.begin(session, results::add);
        assertThat(request.reply(session, 0, 11, 0)).isFalse();
        request.beginWrite(token);
        assertThat(request.reply(session, 0, 11, 1)).isFalse();
        assertThat(request.reply(session, 0, 11, 0)).isTrue();
        assertThat(request.reply(session, 0, 11, 0)).isFalse();
        request.writeComplete(token, true);
        assertThat(request.reply(session, 0, 11, 0)).isFalse();
    }

    @Test
    public void requiresWriteAndCurrentExactAck_evenWhenReplyWinsTheWriteCallbackRace() {
        var token = request.begin(session, results::add);
        request.reply(session, 0, 11, 0); // Unsolicited before the write boundary.
        assertThat(request.beginWrite(token)).isTrue();
        request.reply(new Object(), 0, 11, 0);
        request.reply(session, 0, 10, 0);
        request.reply(session, 0, 11, 1);
        drain();
        assertThat(results).isEmpty();
        request.reply(session, 0, 11, 0);
        drain();
        assertThat(results).isEmpty();
        request.writeComplete(token, true);
        request.reply(session, 0, 11, 0);
        request.writeComplete(token, true);
        drain();
        assertThat(results)
                .singleElement()
                .satisfies(
                        result -> {
                            assertThat(result.status).isEqualTo("disabled");
                            assertThat(result.resultCode).isZero();
                        });
    }

    @Test
    public void successfulWriteAloneTimesOut_andLateAckCannotFulfillSameSessionRetry() {
        var token = request.begin(session, results::add);
        assertThat(request.beginWrite(token)).isTrue();
        request.writeComplete(token, true);
        expire();
        request.reply(session, 0, 11, 0);
        assertThat(request.begin(session, results::add)).isNull();
        drain();
        assertThat(results)
                .extracting(result -> result.status)
                .containsExactly("timeout", "session_changed");
        var next = request.begin(new Object(), results::add);
        assertThat(next).isNotNull();
    }

    @Test
    public void timeoutBeforeQueueDrainPreventsMutationAndKeepsOnlyOneWorkerSlot() {
        var token = request.begin(session, results::add);
        expire();
        assertThat(request.begin(session, results::add)).isNull();
        assertThat(request.beginWrite(token)).isFalse();
        request.writeComplete(token, false);
        drain();
        assertThat(results).extracting(result -> result.status).containsExactly("timeout", "busy");
        assertThat(request.begin(session, results::add)).isNotNull();
    }

    @Test
    public void attemptedWriteFailureIsAmbiguous_andNeverUsesAnEarlyAck() {
        var token = request.begin(session, results::add);
        request.beginWrite(token);
        request.reply(session, 0, 11, 0);
        request.writeComplete(token, false);
        request.begin(session, results::add);
        drain();
        assertThat(results)
                .extracting(result -> result.status)
                .containsExactly("send_failed", "session_changed");
    }

    @Test
    public void nvFailureIsExplicitAndDoesNotPoisonAnAcknowledgedSession() {
        var token = request.begin(session, results::add);
        request.beginWrite(token);
        request.writeComplete(token, true);
        request.reply(session, 5, 11, 0);
        drain();
        assertThat(results)
                .singleElement()
                .satisfies(
                        result -> {
                            assertThat(result.status).isEqualTo("rejected");
                            assertThat(result.resultCode).isEqualTo(5);
                        });
        assertThat(request.begin(session, results::add)).isNotNull();
    }

    @Test
    public void timeoutDuringWriteReportsOnce_andRetainsWorkerUntilItFinishes() {
        var token = request.begin(session, results::add);
        request.beginWrite(token);
        expire();
        request.reply(session, 0, 11, 0);
        request.begin(new Object(), results::add);
        request.writeComplete(token, true);
        drain();
        assertThat(results).extracting(result -> result.status).containsExactly("timeout", "busy");
        assertThat(request.begin(new Object(), results::add)).isNotNull();
    }

    @Test
    public void shutdownCannotAcknowledgePendingWork() {
        var token = request.begin(session, results::add);
        request.beginWrite(token);
        request.close();
        request.reply(session, 0, 11, 0);
        request.writeComplete(token, true);
        drain();
        assertThat(results).extracting(result -> result.status).containsExactly("session_changed");
    }

    private void drain() {
        shadowOf(Looper.getMainLooper()).idle();
    }

    private void expire() {
        clock.set(5000);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));
    }
}
