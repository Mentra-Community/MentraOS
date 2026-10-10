package com.mentra.asg_client.io.bes.log;

/** Serializes one TRACE read window with the other BES log transfers through the shared lock. */
public final class BesTraceTransferGate implements BesTraceTail.TransferGate {
    @Override
    public boolean acquire(long timeoutMs) throws InterruptedException {
        return BesLogTransferLock.get().acquire(BesLogTransferLock.Owner.TRACE_TAIL, timeoutMs);
    }

    @Override
    public void release() {
        BesLogTransferLock.get().release(BesLogTransferLock.Owner.TRACE_TAIL);
    }
}
