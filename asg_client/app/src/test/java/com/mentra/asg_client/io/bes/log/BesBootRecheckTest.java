package com.mentra.asg_client.io.bes.log;

import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.BOOT_A;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.BOOT_B;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.syvr;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.FakeFreezer;
import com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.FakeScheduler;
import com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.FakeSender;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * A BES-only reset (hardware watchdog) leaves the MTK up and no {@code sr_syvr} follows by itself.
 * The tail seeing a new {@code bid} must make ASG ask for it, so the collector runs.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesBootRecheckTest {
    private static final String BID_A = "00000000000000a1";
    private static final String BID_B = "00000000000000b2";
    private static final long WDT_HW = 0x01;
    private static final long WDT_SW = 0x00800030L;

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    /** Manual delayed executor for the recheck. */
    private static final class ManualScheduler implements BesBootRecheck.Scheduler {
        long nowMs;
        final List<long[]> due = new ArrayList<>(); // {at, id}
        final List<Runnable> tasks = new ArrayList<>();
        final List<Boolean> cancelled = new ArrayList<>();

        @Override
        public BesBootRecheck.Cancellable postDelayed(Runnable task, long delayMs) {
            int id = tasks.size();
            tasks.add(task);
            cancelled.add(false);
            due.add(new long[] {nowMs + delayMs, id});
            return () -> cancelled.set(id, true);
        }

        void advance(long ms) {
            long target = nowMs + ms;
            while (true) {
                long[] next = null;
                for (long[] d : due) {
                    if (d[0] <= target && (next == null || d[0] < next[0])) {
                        next = d;
                    }
                }
                if (next == null) {
                    break;
                }
                due.remove(next);
                nowMs = next[0];
                if (!cancelled.get((int) next[1])) {
                    tasks.get((int) next[1]).run();
                }
            }
            nowMs = target;
        }
    }

    @Test
    public void triggersInsideTheDebounceCollapseIntoOneRequest() {
        ManualScheduler sched = new ManualScheduler();
        List<Long> requests = new ArrayList<>();
        BesBootRecheck recheck = new BesBootRecheck(() -> {
            requests.add(sched.nowMs);
            return true;
        }, sched);
        recheck.onBootChange("trace");
        sched.advance(500);
        recheck.onBootChange("liveness");
        recheck.onBootChange("trace again");
        sched.advance(BesBootRecheck.DEBOUNCE_MS);
        assertEquals(1, requests.size());
        assertEquals(BesBootRecheck.DEBOUNCE_MS, (long) requests.get(0));
        sched.advance(60_000);
        assertEquals("accepted requests are not repeated", 1, requests.size());
        recheck.onBootChange("a later boot");
        sched.advance(BesBootRecheck.DEBOUNCE_MS);
        assertEquals(2, requests.size());
    }

    @Test
    public void aRefusedRequestIsRetriedAndThenGivenUp() {
        ManualScheduler sched = new ManualScheduler();
        List<Long> requests = new ArrayList<>();
        boolean[] accept = {false};
        BesBootRecheck recheck = new BesBootRecheck(() -> {
            requests.add(sched.nowMs);
            return accept[0];
        }, sched);
        recheck.onBootChange("trace");
        sched.advance(BesBootRecheck.DEBOUNCE_MS + 2 * BesBootRecheck.RETRY_MS);
        assertEquals(3, requests.size());
        accept[0] = true;
        sched.advance(BesBootRecheck.RETRY_MS);
        assertEquals(4, requests.size());
        sched.advance(60_000);
        assertEquals(4, requests.size());

        accept[0] = false;
        recheck.onBootChange("again");
        sched.advance(10 * 60_000);
        assertEquals("bounded retries", 4 + BesBootRecheck.MAX_ATTEMPTS, requests.size());
    }

    @Test
    public void aThrowingRequesterNeverKillsTheScheduler() {
        ManualScheduler sched = new ManualScheduler();
        int[] calls = {0};
        BesBootRecheck recheck = new BesBootRecheck(() -> {
            calls[0]++;
            throw new IllegalStateException("lane closed");
        }, sched);
        recheck.onBootChange("trace");
        sched.advance(60_000);
        assertEquals(BesBootRecheck.MAX_ATTEMPTS, calls[0]);
    }

    // ------------------------------------------- the whole chain, as on unit 1 (OS-1988 BUGS.md 2)

    private static byte[] frame(String name, JSONObject body) throws Exception {
        return new JSONObject().put("C", name).put("B", body).toString()
                .getBytes(StandardCharsets.UTF_8);
    }

    private static JSONObject bidData(String bid, long g, long p, long e, String text)
            throws Exception {
        return new JSONObject().put("g", g).put("bid", bid)
                .put("p", String.format(Locale.US, "%016x", p))
                .put("e", String.format(Locale.US, "%016x", e))
                .put("c", String.format(Locale.US, "%016x", p))
                .put("l", String.format(Locale.US, "%016x", 0))
                .put("n", text.getBytes(StandardCharsets.UTF_8).length)
                .put("t", 1000).put("tp", 1000).put("d", text);
    }

    private BesTraceTail mTail;

    @Before
    public void setUp() {
        mTail = BesTraceTail.get();
        mTail.resetForTest();
        Context context = ApplicationProvider.getApplicationContext();
        BesTraceTailTest.deleteRecursively(new File(context.getFilesDir(), "bes_trace"));
        mTail.attach(context);
        mTail.setSender(json -> true);
    }

    @After
    public void tearDown() {
        mTail.resetForTest();
    }

    @Test
    public void aBesOnlyWatchdogResetIsCollectedOnceTheTailSeesTheNewBootId() throws Exception {
        FakeScheduler collectorSched = new FakeScheduler();
        BesIncidentStore store = new BesIncidentStore(new File(folder.getRoot(), "bes_incident"),
                () -> collectorSched.nowMs, () -> "ML395018B", () -> "0123456789abcdef");
        store.recover();
        BesCrashDumpCollector collector = new BesCrashDumpCollector(store,
                new BesLogTransferLock(() -> collectorSched.nowMs, 600_000), new FakeFreezer(),
                collectorSched, () -> collectorSched.nowMs, () -> true);
        FakeSender sender = new FakeSender();
        List<String> stored = new ArrayList<>();
        collector.setStoredListener(stored::add);

        // The BES the unit was running: sr_syvr read at connect, last_boot saved.
        collector.onSystemVersion(syvr(true, BOOT_A, null, 0, null, 2, 0x00810030L), sender);
        collectorSched.runDue();
        assertEquals(BOOT_A, store.lastBoot());

        // What the unit's request_version returns once it is asked (the BES is on BOOT_B now).
        ManualScheduler recheckSched = new ManualScheduler();
        int[] requests = {0};
        BesBootRecheck recheck = new BesBootRecheck(() -> {
            requests[0]++;
            try {
                collector.onSystemVersion(syvr(true, BOOT_B, null, 0, null, WDT_HW, WDT_SW), sender);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            collectorSched.runDue();
            return true;
        }, recheckSched);
        mTail.setBootChangeListener((oldBid, newBid) -> recheck.onBootChange("bid " + newBid));
        mTail.setSupported(true);
        shadowOf(mTail.looper()).idle();

        // TRACE of the first boot, then silence on sr_syvr: the watchdog fires, the MTK stays up.
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, "1000/I/NONE  / 6 | a\n")));
        shadowOf(mTail.looper()).idle();
        recheckSched.advance(120_000);
        assertEquals(0, requests[0]);
        assertNull(store.find("ML395018B-reset-" + BOOT_B));
        assertEquals(BOOT_A, store.lastBoot());

        // The first poll after the reset sees the new bid; ASG re-reads sr_syvr by itself.
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_B, 5, 0, 40, "10/I/NONE  / 6 | boot\n")));
        shadowOf(mTail.looper()).idle();
        assertEquals("debounced, not immediate", 0, requests[0]);
        recheckSched.advance(BesBootRecheck.DEBOUNCE_MS);
        assertEquals(1, requests[0]);

        assertEquals(BOOT_B, store.lastBoot());
        JSONObject reset = store.find("ML395018B-reset-" + BOOT_B);
        assertNotNull(reset);
        assertEquals("bes_unexpected_reset", reset.getString("reason"));
        assertEquals(BOOT_A, reset.getString("bootId"));
        assertEquals(BOOT_B, reset.getString("observedBootId"));
        assertEquals(java.util.Collections.singletonList("ML395018B-reset-" + BOOT_B), stored);
        assertTrue(sender.sent.isEmpty());
    }
}
