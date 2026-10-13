package com.mentra.asg_client.io.bes.log;

import static com.mentra.asg_client.io.bes.log.BesLogTransferLock.Owner.CRASH_CS_LOG;
import static com.mentra.asg_client.io.bes.log.BesLogTransferLock.Owner.TRACE_TAIL;
import static com.mentra.asg_client.io.bes.log.BesLogTransferLock.Owner.USER_MH_LOGS;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public class BesLogTransferLockTest {
    @Test
    public void freeLockIsAcquiredAndReleased() throws Exception {
        BesLogTransferLock lock = new BesLogTransferLock(() -> 0L, 60_000);
        assertNull(lock.current());
        assertTrue(lock.acquire(USER_MH_LOGS, 0));
        assertEquals(USER_MH_LOGS, lock.current());
        lock.release(USER_MH_LOGS);
        assertNull(lock.current());
    }

    @Test
    public void busyLockRefusesAnImmediateTryAndTimesOutWaiters() throws Exception {
        BesLogTransferLock lock = new BesLogTransferLock(() -> 0L, 60_000);
        assertTrue(lock.acquire(CRASH_CS_LOG, 0));
        assertFalse(lock.acquire(USER_MH_LOGS, 0));
        long start = System.nanoTime();
        assertFalse(lock.acquire(TRACE_TAIL, 60));
        assertTrue(System.nanoTime() - start >= 50_000_000L);
        assertEquals(CRASH_CS_LOG, lock.current());
    }

    @Test
    public void ownerAcquiringAgainKeepsOneReleaseSemantics() throws Exception {
        BesLogTransferLock lock = new BesLogTransferLock(() -> 0L, 60_000);
        assertTrue(lock.acquire(USER_MH_LOGS, 0));
        assertTrue(lock.acquire(USER_MH_LOGS, 0));
        lock.release(USER_MH_LOGS);
        assertNull(lock.current());
    }

    @Test
    public void releaseByAnotherOwnerChangesNothing() throws Exception {
        BesLogTransferLock lock = new BesLogTransferLock(() -> 0L, 60_000);
        assertTrue(lock.acquire(CRASH_CS_LOG, 0));
        lock.release(USER_MH_LOGS);
        assertEquals(CRASH_CS_LOG, lock.current());
    }

    /** A bug report started during a crash pull waits for it and then gets the channel. */
    @Test
    public void manualReportWaitsForCrashPullInsteadOfFailing() throws Exception {
        BesLogTransferLock lock = new BesLogTransferLock(() -> 0L, 60_000);
        assertTrue(lock.acquire(CRASH_CS_LOG, 0));
        CountDownLatch waiting = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(1);
        boolean[] got = new boolean[1];
        Thread report = new Thread(() -> {
            try {
                waiting.countDown();
                got[0] = lock.acquire(USER_MH_LOGS, 10_000);
            } catch (InterruptedException ignored) {
                // test failure shows through got[0]
            }
            done.countDown();
        });
        report.start();
        assertTrue(waiting.await(2, TimeUnit.SECONDS));
        assertFalse(done.await(150, TimeUnit.MILLISECONDS));
        assertEquals(CRASH_CS_LOG, lock.current());

        lock.release(CRASH_CS_LOG); // the crash pull ends
        assertTrue(done.await(2, TimeUnit.SECONDS));
        assertTrue(got[0]);
        assertEquals(USER_MH_LOGS, lock.current());
    }

    /** Waiters are served in arrival order, so the periodic tail poll cannot starve a report. */
    @Test
    public void waitersAreServedInArrivalOrder() throws Exception {
        BesLogTransferLock lock = new BesLogTransferLock(() -> 0L, 60_000);
        assertTrue(lock.acquire(CRASH_CS_LOG, 0));
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch firstQueued = new CountDownLatch(1);
        Thread user = new Thread(() -> {
            try {
                firstQueued.countDown();
                if (lock.acquire(USER_MH_LOGS, 10_000)) {
                    order.add("user");
                    lock.release(USER_MH_LOGS);
                }
            } catch (InterruptedException ignored) {
                // order assertion fails
            }
        });
        user.start();
        assertTrue(firstQueued.await(2, TimeUnit.SECONDS));
        Thread.sleep(100);
        Thread tail = new Thread(() -> {
            try {
                if (lock.acquire(TRACE_TAIL, 10_000)) {
                    order.add("tail");
                    lock.release(TRACE_TAIL);
                }
            } catch (InterruptedException ignored) {
                // order assertion fails
            }
        });
        tail.start();
        Thread.sleep(100);
        lock.release(CRASH_CS_LOG);
        user.join(3000);
        tail.join(3000);
        assertEquals(java.util.Arrays.asList("user", "tail"), order);
    }

    @Test
    public void holderThatNeverReleasesLosesTheLock() throws Exception {
        AtomicLong now = new AtomicLong(0);
        BesLogTransferLock lock = new BesLogTransferLock(now::get, 1_000);
        assertTrue(lock.acquire(TRACE_TAIL, 0));
        now.set(999);
        assertEquals(TRACE_TAIL, lock.current());
        now.set(1_000);
        assertNull(lock.current());
        assertTrue(lock.acquire(USER_MH_LOGS, 0));
    }
}
