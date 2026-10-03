package com.mentra.asg_client.io.streaming;

import static org.junit.Assert.*;

import org.junit.Test;

public class StreamPhonePresencePolicyTest {
    private final StreamPhonePresencePolicy mPolicy = new StreamPhonePresencePolicy(10_000);

    @Test
    public void connectedStreamHasNoKeepAliveDeadline() {
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 0);
        long generation = mPolicy.start();
        assertEquals(-1, mPolicy.getLossDeadlineMs());
        assertFalse(mPolicy.claimExpiredStop(generation, Long.MAX_VALUE));
    }

    @Test
    public void shortDisconnectionPreservesStream() {
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 0);
        long generation = mPolicy.start();
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.ABSENT, 1_000);
        assertFalse(mPolicy.claimExpiredStop(generation, 5_000));
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 6_000);
        assertFalse(mPolicy.claimExpiredStop(generation, 11_000));
    }

    @Test
    public void repeatedReportsDoNotExtendGraceAndStopIsClaimedOnce() {
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 0);
        long generation = mPolicy.start();
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.ABSENT, 1_000);
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.ABSENT, 9_000);
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.UNKNOWN, 10_000);
        assertEquals(11_000, mPolicy.getLossDeadlineMs());
        assertFalse(mPolicy.claimExpiredStop(generation, 10_999));
        assertTrue(mPolicy.claimExpiredStop(generation, 11_000));
        assertFalse(mPolicy.claimExpiredStop(generation, 11_001));
    }

    @Test
    public void unknownPresenceCannotStartOrKeepAnActiveStreamForever() {
        assertFalse(mPolicy.canStart());
        assertThrows(IllegalStateException.class, mPolicy::start);
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 0);
        long generation = mPolicy.start();
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.UNKNOWN, 1_000);
        assertTrue(mPolicy.claimExpiredStop(generation, 11_000));
    }

    @Test
    public void oldDeadlineCannotStopReplacementStream() {
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 0);
        long oldGeneration = mPolicy.start();
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.ABSENT, 1_000);
        mPolicy.stop();
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 2_000);
        long newGeneration = mPolicy.start();
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.ABSENT, 3_000);
        assertNotEquals(oldGeneration, newGeneration);
        assertFalse(mPolicy.claimExpiredStop(oldGeneration, 13_000));
        assertTrue(mPolicy.claimExpiredStop(newGeneration, 13_000));
    }

    @Test
    public void explicitStopCancelsPendingDeadline() {
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.PRESENT, 0);
        long generation = mPolicy.start();
        mPolicy.onPresence(StreamPhonePresencePolicy.Presence.ABSENT, 1_000);
        mPolicy.stop();
        assertFalse(mPolicy.claimExpiredStop(generation, 11_000));
    }
}
