package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BesSilenceLadderTest {

    private static BesSilenceLadder ladder() {
        return new BesSilenceLadder(new long[] {3_000, 10_000, 30_000});
    }

    @Test
    public void reportsEachRungOnce() {
        BesSilenceLadder ladder = ladder();

        assertEquals(BesSilenceLadder.NO_RUNG, ladder.onSilence(1_000));
        assertEquals(3_000L, ladder.onSilence(3_100));
        assertEquals(BesSilenceLadder.NO_RUNG, ladder.onSilence(4_000));
        assertEquals(10_000L, ladder.onSilence(10_500));
        assertEquals(BesSilenceLadder.NO_RUNG, ladder.onSilence(29_000));
        assertEquals(30_000L, ladder.onSilence(31_000));
        assertEquals(BesSilenceLadder.NO_RUNG, ladder.onSilence(90_000));
    }

    @Test
    public void reportsOnlyTheHighestRungWhenTicksAreMissed() {
        // The watchdog thread can be starved during the reconnect burst; a late tick must not
        // emit one line per skipped rung and flood the window holding the crash.
        assertEquals(10_000L, ladder().onSilence(12_000));
    }

    @Test
    public void tracksWhetherTheStallWasNotable() {
        BesSilenceLadder ladder = ladder();
        assertFalse(ladder.reported());

        ladder.onSilence(1_000);
        assertFalse(ladder.reported());

        ladder.onSilence(3_000);
        assertTrue(ladder.reported());
    }

    @Test
    public void resetRearmsFromTheFirstRung() {
        BesSilenceLadder ladder = ladder();
        ladder.onSilence(31_000);
        ladder.reset();

        assertFalse(ladder.reported());
        assertEquals(3_000L, ladder.onSilence(3_000));
    }
}
