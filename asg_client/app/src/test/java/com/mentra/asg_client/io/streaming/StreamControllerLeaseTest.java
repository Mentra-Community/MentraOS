package com.mentra.asg_client.io.streaming;

import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class StreamControllerLeaseTest {
    private StreamControllerLease lease() {
        AtomicInteger nonce = new AtomicInteger();
        return new StreamControllerLease(10_000, () -> "probe-" + nonce.incrementAndGet());
    }

    @Test public void freshResponseToleratesBriefDropButDuplicateCannotRenew() {
        StreamControllerLease lease = lease();
        lease.start(0);
        String first = lease.probeId();
        assertFalse(lease.expired(7_000));
        assertTrue(lease.acknowledge(first, 7_000));
        assertFalse(lease.acknowledge(first, 16_000));
        assertTrue(lease.expired(17_000));
    }

    @Test public void lateResponseCannotReviveExpiredOrStoppedStream() {
        StreamControllerLease lease = lease();
        lease.start(0);
        String probe = lease.probeId();
        assertFalse(lease.acknowledge(probe, 10_000));
        lease.stop();
        assertFalse(lease.acknowledge(probe, 10_001));
        assertFalse(lease.expired(20_000));
    }

    @Test public void replacementRejectsOldChallengeEvenWithSamePublicStreamId() {
        StreamControllerLease lease = lease();
        lease.start(0);
        String old = lease.probeId();
        lease.start(1_000);
        assertFalse(lease.acknowledge(old, 2_000));
        assertTrue(lease.expired(11_000));
    }
}
