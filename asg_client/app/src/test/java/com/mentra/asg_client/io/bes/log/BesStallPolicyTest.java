package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BesStallPolicyTest {

    private static final long STREAM_FAULT_MS = 4_000;

    @Test
    public void idleLinkSilenceIsNotAFault() {
        // Observed on a healthy charging device: BES parked the Classic link in sniff mode and
        // said nothing for 23.9s and then 30.0s while its uptime counter kept climbing. Reading
        // that as a wedged chip is what produced false BES reboots.
        assertFalse(BesStallPolicy.isFault(23_886, 0, false, STREAM_FAULT_MS));
        assertFalse(BesStallPolicy.isFault(29_990, 0, false, STREAM_FAULT_MS));
        assertEquals("idle", BesStallPolicy.describe(29_990, 0, false, STREAM_FAULT_MS));
    }

    @Test
    public void unansweredWriteMakesSilenceAFault() {
        // BES accepts bytes into its UART FIFO even when wedged, so a write with no reply is the
        // signal that distinguishes a dead chip from one that simply has nothing to say.
        assertTrue(BesStallPolicy.isFault(3_000, 1, false, STREAM_FAULT_MS));
        assertEquals("unanswered_write", BesStallPolicy.describe(3_000, 1, false, STREAM_FAULT_MS));
    }

    @Test
    public void streamingSilenceIsAFaultEvenWithNothingOutstanding() {
        // While streaming, BES carries the mic uplink and controller probe acks continuously.
        assertTrue(BesStallPolicy.isFault(4_000, 0, true, STREAM_FAULT_MS));
        assertEquals("stream_silence", BesStallPolicy.describe(4_000, 0, true, STREAM_FAULT_MS));
    }

    @Test
    public void shortStreamingGapsStayQuiet() {
        // Encoder hiccups and scheduling jitter produce sub-second gaps mid-stream.
        assertFalse(BesStallPolicy.isFault(1_200, 0, true, STREAM_FAULT_MS));
        assertEquals("idle", BesStallPolicy.describe(1_200, 0, true, STREAM_FAULT_MS));
    }
}
