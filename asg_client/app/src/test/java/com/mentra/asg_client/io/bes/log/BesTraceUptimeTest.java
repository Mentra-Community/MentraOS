package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BesTraceUptimeTest {

    /** Verbatim shape of a BES trace dump, including the hex runs that interleave with it. */
    private static final String TRACE =
            "   30266/I/NONE  / 11 | set nv ram RW: 0x2000\n"
                    + "   49391/I/NONE  /  6 | <<<lxy mh_request_logs (runtime logs) from MTK\n"
                    + "   49616/I/BT    /  0 | (d0) rfcomm_l2cap_notify:dlci 8 tx done 0\n";

    @Test
    public void readsNewestAndOldestUptime() {
        assertEquals(49616L, BesTraceUptime.newestUptimeMs(TRACE));
        assertEquals(30266L, BesTraceUptime.oldestUptimeMs(TRACE));
    }

    @Test
    public void ignoresInterleavedHexDumps() {
        // A byte dump from a concurrent buffer contains bare "7/ 11 |" runs that must not be read
        // as an uptime, or a crash gets dated to the wrong second.
        String noisy =
                "  02 01 20 87 00 83 00 04 00 52 1c 00 7/ 11 | MASTER MOBILE RSSI=-41\n"
                        + "  CT:[LMP]idx=1,lc_state=1,op=23,f=0,r=-59\n";
        assertEquals(BesTraceUptime.UNKNOWN, BesTraceUptime.newestUptimeMs(noisy));
    }

    @Test
    public void returnsUnknownForEmptyTrace() {
        assertEquals(BesTraceUptime.UNKNOWN, BesTraceUptime.newestUptimeMs(""));
        assertEquals(BesTraceUptime.UNKNOWN, BesTraceUptime.newestUptimeMs(null));
        assertEquals(BesTraceUptime.UNKNOWN, BesTraceUptime.oldestUptimeMs(""));
    }

    @Test
    public void datesTheBootFromUptimeAndWallClock() {
        assertEquals(1_000_000L, BesTraceUptime.impliedBootWallMs(50_000L, 1_050_000L));
        assertEquals(
                BesTraceUptime.UNKNOWN,
                BesTraceUptime.impliedBootWallMs(BesTraceUptime.UNKNOWN, 1_050_000L));
    }

    @Test
    public void detectsRebootOnlyWhenUptimeFallsBack() {
        assertTrue(BesTraceUptime.rebooted(49_000L, 1_200L));
        assertFalse(BesTraceUptime.rebooted(49_000L, 54_000L));
        // Snapshots are read seconds apart, so a small backwards step is jitter, not a reboot.
        assertFalse(BesTraceUptime.rebooted(49_000L, 48_500L));
        assertFalse(BesTraceUptime.rebooted(BesTraceUptime.UNKNOWN, 1_200L));
    }
}
