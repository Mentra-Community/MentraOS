package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BesTraceTransferGateTest {
    @Test
    public void gateTakesAndReleasesTheSharedLockAsTraceTail() throws Exception {
        BesLogTransferLock lock = BesLogTransferLock.get();
        BesTraceTransferGate gate = new BesTraceTransferGate();
        assertTrue(gate.acquire(0));
        assertTrue(lock.current() == BesLogTransferLock.Owner.TRACE_TAIL);
        assertFalse(lock.acquire(BesLogTransferLock.Owner.CRASH_CS_LOG, 0));
        gate.release();
        assertTrue(lock.current() == null);
        assertTrue(lock.acquire(BesLogTransferLock.Owner.CRASH_CS_LOG, 0));
        lock.release(BesLogTransferLock.Owner.CRASH_CS_LOG);
    }
}
