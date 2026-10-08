package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class FileUartPacerTest {
    private static final long MS = 1_000_000L;

    @Test
    public void firstFrameIsImmediateAndTheNextWaitsForItsWireTime() {
        FileUartPacer pacer = new FileUartPacer(35_000);
        assertEquals(0, pacer.delayNanos(0));
        pacer.onSent(832, 0);
        // 832 bytes at 35 KB/s occupy ~23.8 ms of line time.
        assertEquals(832L * 1_000_000_000L / 35_000, pacer.delayNanos(0));
        assertEquals(0, pacer.delayNanos(24 * MS));
    }

    @Test
    public void backToBackFramesAccumulateDebt() {
        FileUartPacer pacer = new FileUartPacer(50_000);
        pacer.onSent(1000, 0);
        pacer.onSent(1000, 0);
        assertEquals(40 * MS, pacer.delayNanos(0));
        assertEquals(15 * MS, pacer.delayNanos(25 * MS));
    }

    @Test
    public void idleTimeIsNotBankedAsBurstCredit() {
        FileUartPacer pacer = new FileUartPacer(50_000);
        pacer.onSent(1000, 0);
        long afterIdle = 1_000 * MS;
        assertEquals(0, pacer.delayNanos(afterIdle));
        pacer.onSent(1000, afterIdle);
        assertEquals(20 * MS, pacer.delayNanos(afterIdle));
    }

    @Test
    public void rejectsNonPositiveRate() {
        assertThrows(IllegalArgumentException.class, () -> new FileUartPacer(0));
    }
}
