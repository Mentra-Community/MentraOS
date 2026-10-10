package com.mentra.asg_client.io.bes.log;

import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.BOOT_A;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.BOOT_B;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.BOOT_C;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.T0;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.chunks;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.crcHex;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.dumpId;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.dumpText;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.header;
import static com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.syvr;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.FakeFreezer;
import com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.FakeScheduler;
import com.mentra.asg_client.io.bes.log.BesIncidentTestSupport.FakeSender;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(RobolectricTestRunner.class)
public class BesCrashDumpCollectorTest {
    private static final long SW_CRASH_REBOOT = 1L << 25;

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private File mRoot;

    @Before
    public void setUp() {
        mRoot = new File(folder.getRoot(), "bes_incident");
    }

    /** One simulated process: collector, store, fakes. A second Rig on the same root is a restart. */
    private final class Rig {
        final FakeScheduler sched = new FakeScheduler();
        final BesIncidentStore store;
        final BesLogTransferLock lock = new BesLogTransferLock(() -> sched.nowMs, 600_000);
        final FakeFreezer freezer = new FakeFreezer();
        final FakeSender sender = new FakeSender();
        final AtomicBoolean pullAllowed = new AtomicBoolean(true);
        final BesCrashDumpCollector collector;
        final List<String> stored = new ArrayList<>();
        final List<String> storedStateAtCallback = new ArrayList<>();

        Rig(long startMs) {
            sched.nowMs = startMs;
            store = new BesIncidentStore(mRoot, () -> sched.nowMs, () -> "ML395018B",
                    () -> "0123456789abcdef");
            store.recover();
            collector = new BesCrashDumpCollector(store, lock, freezer, sched, () -> sched.nowMs,
                    pullAllowed::get);
            collector.setStoredListener(key -> {
                stored.add(key);
                JSONObject record = store.find(key);
                storedStateAtCallback.add(record == null ? "missing" : record.optString("state"));
            });
        }

        void syvr(JSONObject json) {
            collector.onSystemVersion(json, sender);
            sched.runDue();
        }

        void packet(int cur, String body) {
            collector.onLogPacket(cur, body);
            sched.runDue();
        }

        /** header, data packets, optional trailer, end. */
        void deliver(String header, List<String> data, String trailer) {
            int cur = 0;
            packet(cur++, header);
            for (String body : data) {
                packet(cur++, body);
            }
            if (trailer != null) {
                packet(cur++, trailer);
            }
            packet(255, "end");
        }

        void deliverGood(String dumpId, byte[] dump) {
            deliver(header(dumpId, dump.length, crcHex(dump)), chunks(dump, 400), null);
        }

        List<JSONObject> incidents() {
            return store.all();
        }

        JSONObject only() {
            assertEquals(1, incidents().size());
            return incidents().get(0);
        }
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] dumpOf(String bootId) {
        return bytes(dumpText(bootId, 2000));
    }

    private static JSONObject syvrDump(String boot, String dumpId, long len, String dumpBoot,
            long hw, long sw) throws Exception {
        return syvr(true, boot, dumpId, len, dumpBoot, hw, sw);
    }

    // ------------------------------------------------------------ capability gate

    @Test
    public void doesNothingWithoutCrashPull() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        rig.collector.setResetClassifier((hw, sw) -> true);
        rig.syvr(syvr(false, BOOT_B, dumpId(42, dump), dump.length, BOOT_A, 0, SW_CRASH_REBOOT));
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0).put("wire_caps", new JSONObject()));
        assertTrue(rig.sender.sent.isEmpty());
        assertTrue(rig.incidents().isEmpty());
        assertNull(rig.store.lastBoot());
        assertTrue(rig.freezer.windows.isEmpty());
        assertNull(rig.lock.current());
        assertFalse(mRoot.exists() && mRoot.list().length > 0);
    }

    @Test
    public void crashPullWithoutCrashObjectChangesNothing() throws Exception {
        Rig rig = new Rig(T0);
        JSONObject json = syvr(true, BOOT_A, null, 0, null, 0, 0);
        json.remove("crash");
        rig.syvr(json);
        assertTrue(rig.sender.sent.isEmpty());
        assertNull(rig.store.lastBoot());
    }

    @Test
    public void crashObjectInsideTheBBodyIsRecognizedToo() throws Exception {
        Rig rig = new Rig(T0);
        JSONObject inner = syvr(true, BOOT_A, null, 0, null, 0, 0);
        JSONObject json = new JSONObject().put("C", "sr_syvr").put("B", inner.toString());
        rig.syvr(json);
        assertEquals(BOOT_A, rig.store.lastBoot());
    }

    // ------------------------------------------------------- collection + bundle

    @Test
    public void newDumpIsFrozenPulledValidatedAndStoredBeforeTheListenerFires() throws Exception {
        Rig rig = new Rig(T0);
        List<Integer> sentAtFreeze = new ArrayList<>();
        rig.freezer.onFreeze = () -> sentAtFreeze.add(rig.sender.sent.size());
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0)); // ASG observes boot A
        assertEquals(BOOT_A, rig.store.lastBoot());
        assertTrue(rig.sender.sent.isEmpty());

        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.sched.advance(5_000);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));

        // TRACE frozen at detection, before the pull starts.
        assertEquals(1, rig.freezer.windows.size());
        assertEquals(java.util.Collections.singletonList(0), sentAtFreeze);
        assertEquals(T0 + 5_000 - AsgConstants.BES_TRACE_STORE_RETENTION_MS,
                rig.freezer.windows.get(0)[0]);
        assertEquals(T0 + 5_000, rig.freezer.windows.get(0)[1]);
        assertEquals(AsgConstants.BES_INCIDENT_TRACE_MAX_BYTES, (int) rig.freezer.maxBytes.get(0));

        String key = "ML395018B-dump-" + id;
        assertEquals(1, rig.sender.sent.size());
        JSONObject command = new JSONObject(rig.sender.sent.get(0));
        assertEquals("cs_log", command.getString("C"));
        assertEquals(1, command.getInt("V"));
        assertEquals(0, command.getJSONObject("B").getInt("action"));
        assertEquals(id, command.getJSONObject("B").getString("dump_id"));
        assertEquals(BesLogTransferLock.Owner.CRASH_CS_LOG, rig.lock.current());
        assertEquals("COLLECTING", rig.store.find(key).getString("state"));
        assertTrue(rig.stored.isEmpty());

        rig.deliverGood(id, dump);

        assertEquals(java.util.Collections.singletonList(key), rig.stored);
        assertEquals(java.util.Collections.singletonList("STORED"), rig.storedStateAtCallback);
        JSONObject record = rig.store.find(key);
        assertEquals(1, record.getInt("v"));
        assertEquals("dump", record.getString("kind"));
        assertEquals("bes_crash", record.getString("reason"));
        assertEquals("STORED", record.getString("state"));
        assertEquals("match", record.getString("attribution"));
        assertEquals(BOOT_A, record.getString("bootId"));
        assertEquals(BOOT_B, record.getString("observedBootId"));
        assertEquals(id, record.getString("dumpId"));
        assertEquals(dump.length, record.getLong("dumpLen"));
        assertEquals(0x1f, record.getLong("resetHw"));
        assertEquals(0x02000000L, record.getLong("resetSw"));
        assertEquals(1_790_000_000_000L, record.getLong("crashUnixMs"));
        JSONObject flags = record.getJSONObject("flags");
        assertFalse(flags.getBoolean("truncated"));
        assertFalse(flags.getBoolean("torn"));
        assertTrue(flags.getBoolean("tailCaptured"));
        assertFalse(flags.getBoolean("dumpGap"));
        assertEquals(rig.freezer.firstWallMs, record.getLong("coveredFromMs"));
        assertEquals(rig.freezer.lastWallMs, record.getLong("coveredToMs"));
        assertEquals(2, record.getInt("traceGaps"));
        assertEquals(T0 + 5_000, record.getLong("createdMs"));
        assertEquals(1, record.getInt("collectAttempts"));
        assertTrue(record.isNull("reportId"));
        assertFalse(record.getBoolean("uploaded"));
        assertFalse(record.getJSONObject("artifacts").getJSONObject("glasses_firmware:full")
                .getBoolean("attempted"));

        File dir = rig.store.bundleDir(key);
        assertArrayEquals(dump, BesIncidentStore.readBytes(new File(dir, "dump.txt")));
        assertFalse(new File(dir, "dump.partial").exists());
        assertTrue(new File(dir, "trace.txt").isFile());
        assertEquals(dir, rig.store.traceFile(key).getParentFile());
        assertNull(rig.lock.current());
        assertTrue(rig.store.isDumpCollected(id));
        assertEquals(BOOT_B, rig.store.lastBoot());
    }

    @Test
    public void incidentJsonIsOnDiskBeforeTheStoredListenerRuns() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        List<String> onDisk = new ArrayList<>();
        rig.collector.setStoredListener(key -> {
            File file = new File(rig.store.bundleDir(key), "incident.json");
            try {
                onDisk.add(new JSONObject(BesIncidentStore.readText(file)).optString("state"));
            } catch (Exception e) {
                onDisk.add("unreadable");
            }
        });
        rig.syvr(syvrDump(BOOT_B, id, dump.length, null, 0, 0));
        rig.deliverGood(id, dump);
        assertEquals(java.util.Collections.singletonList("STORED"), onDisk);
    }

    @Test
    public void controlCharactersAndTailFlagsLandInTheRecord() throws Exception {
        Rig rig = new Rig(T0);
        String text = "[CRASH-CONTEXT] v=2 seq=7 boot_id=" + BOOT_A + " uptime_ms=10 unix_ms=0"
                + " clock=0 age_ms=0 boot_anchor_ms=0 reset_hw=0x0 reset_sw=0x00000000\n"
                + "[CRASH-TAIL] captured=40 requested=900 truncated=1 torn=1\nabc\n"
                + "[LOG-LOST] bytes=12 since_ms=1\n[CRASH-TAIL-END]\n";
        byte[] dump = bytes(text);
        String id = dumpId(7, dump);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.deliverGood(id, dump);
        JSONObject flags = rig.only().getJSONObject("flags");
        assertTrue(flags.getBoolean("torn"));
        assertTrue(flags.getBoolean("tailCaptured"));
        assertTrue(flags.getBoolean("dumpGap"));
        assertEquals(0, rig.only().getLong("crashUnixMs")); // unknown clock stays unknown
    }

    // ------------------------------------------------------------ attribution

    @Test
    public void knownMismatchGivesAnOlderIncidentAndASeparateNoDumpIncident() throws Exception {
        Rig rig = new Rig(T0);
        rig.collector.setResetClassifier((hw, sw) -> true);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        byte[] dump = dumpOf(BOOT_C); // crashed boot C, but ASG saw A before this boot B
        String id = dumpId(9, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_C, 0x40, 0));

        String resetKey = "ML395018B-reset-" + BOOT_B;
        JSONObject reset = rig.store.find(resetKey);
        assertNotNull(reset);
        assertEquals("reset", reset.getString("kind"));
        assertEquals("bes_unexpected_reset", reset.getString("reason"));
        assertEquals("STORED", reset.getString("state"));
        assertEquals(BOOT_A, reset.getString("bootId"));
        assertEquals(BOOT_B, reset.getString("observedBootId"));
        assertEquals(0x40, reset.getLong("resetHw"));
        assertTrue(reset.isNull("dumpId"));
        assertEquals(java.util.Collections.singletonList(resetKey), rig.stored);

        rig.deliverGood(id, dump);
        JSONObject dumpIncident = rig.store.find("ML395018B-dump-" + id);
        assertEquals("older", dumpIncident.getString("attribution"));
        assertEquals(BOOT_C, dumpIncident.getString("bootId"));
        assertEquals(2, rig.incidents().size());
        assertEquals(2, rig.stored.size());
    }

    @Test
    public void unknownAttributionWithoutAPreviousBootGivesExactlyOneIncident() throws Exception {
        Rig rig = new Rig(T0);
        rig.collector.setResetClassifier((hw, sw) -> true);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(5, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, SW_CRASH_REBOOT)); // no last_boot
        rig.deliverGood(id, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, SW_CRASH_REBOOT));
        JSONObject record = rig.only();
        assertEquals("dump", record.getString("kind"));
        assertEquals("unknown", record.getString("attribution"));
    }

    @Test
    public void legacyDumpWithoutBootIdIsUnknownAndSuppressesTheNoDumpIncident() throws Exception {
        Rig rig = new Rig(T0);
        rig.collector.setResetClassifier((hw, sw) -> true);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        byte[] dump = bytes("[ASSERT] old\n[CRASH-CONTEXT] v=1 seq=3 uptime_ms=5 unix_ms=0 clock=0"
                + " age_ms=0 boot_anchor_ms=0 reset_hw=0x0 reset_sw=0x00000000\nlegacy\n");
        String id = dumpId(3, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, null, 0, SW_CRASH_REBOOT));
        rig.deliverGood(id, dump);
        JSONObject record = rig.only();
        assertEquals("dump", record.getString("kind"));
        assertEquals("unknown", record.getString("attribution"));
        assertTrue(record.isNull("bootId"));
    }

    @Test
    public void matchingDumpAlsoExplainsTheResetSoNoSecondIncidentIsMade() throws Exception {
        Rig rig = new Rig(T0);
        rig.collector.setResetClassifier((hw, sw) -> true);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(6, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, SW_CRASH_REBOOT));
        rig.deliverGood(id, dump);
        assertEquals(1, rig.incidents().size());
        assertEquals("match", rig.only().getString("attribution"));
    }

    // ------------------------------------------------------ no-dump (reset) incidents

    @Test
    public void noDumpIncidentOnlyForUnexpectedResetClasses() throws Exception {
        Rig rig = new Rig(T0);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        // Requested reboot / power-on / all-zero / unknown codes: expected, no incident.
        rig.syvr(syvr(true, BOOT_B, null, 0, null, 0x1, 1L << 16));
        rig.syvr(syvr(true, BOOT_C, null, 0, null, 0, 0));
        assertTrue(rig.incidents().isEmpty());
        assertTrue(rig.stored.isEmpty());

        // The default classifier recognizes only the firmware's crash-reboot bit.
        String boot = "00000000000000d4";
        rig.syvr(syvr(true, boot, null, 0, null, 0, SW_CRASH_REBOOT));
        JSONObject reset = rig.only();
        assertEquals("ML395018B-reset-" + boot, reset.getString("incidentKey"));
        assertEquals(BOOT_C, reset.getString("bootId"));
        assertEquals(boot, reset.getString("observedBootId"));
        assertEquals(SW_CRASH_REBOOT, reset.getLong("resetSw"));
        assertEquals(java.util.Collections.singletonList("ML395018B-reset-" + boot), rig.stored);
        assertTrue(rig.store.traceFile(reset.getString("incidentKey")).isFile());
        assertEquals(rig.freezer.lastWallMs, reset.getLong("coveredToMs"));
    }

    @Test
    public void classifierIsReplaceable() throws Exception {
        Rig rig = new Rig(T0);
        rig.collector.setResetClassifier((hw, sw) -> hw == 0x80);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvr(true, BOOT_B, null, 0, null, 0x7f, SW_CRASH_REBOOT));
        assertTrue(rig.incidents().isEmpty());
        rig.syvr(syvr(true, BOOT_C, null, 0, null, 0x80, 0));
        assertEquals(1, rig.incidents().size());
    }

    @Test
    public void noDumpIncidentIsRaisedOnlyOncePerBootId() throws Exception {
        ResetClassifier onlySw1 = (hw, sw) -> sw == 1;
        Rig rig = new Rig(T0);
        rig.collector.setResetClassifier(onlySw1);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        JSONObject again = syvr(true, BOOT_B, null, 0, null, 0, 1);
        rig.syvr(again);
        rig.syvr(again); // a repeated sr_syvr of the same boot
        assertEquals(1, rig.incidents().size());
        // last_boot lost (cleared by an interrupted write): still once for this boot_id.
        assertTrue(new File(mRoot, "last_boot").delete());
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(again);
        assertEquals(1, rig.incidents().size());
        assertEquals(1, rig.stored.size());
        // A restart does not repeat it either.
        Rig restarted = new Rig(T0 + 60_000);
        restarted.collector.setResetClassifier(onlySw1);
        restarted.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        restarted.syvr(again);
        assertEquals(1, restarted.incidents().size());
        assertTrue(restarted.stored.isEmpty());
    }

    // ---------------------------------------------------------------- dedup

    @Test
    public void dumpIsNotCollectedTwiceAcrossAProcessRestart() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.deliverGood(id, dump);
        assertEquals(1, rig.stored.size());

        Rig restarted = new Rig(T0 + 600_000);
        restarted.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        restarted.syvr(syvrDump(BOOT_C, id, dump.length, BOOT_A, 0, 0)); // BES rebooted, dump stays
        assertTrue(restarted.sender.sent.isEmpty());
        assertTrue(restarted.stored.isEmpty());
        assertEquals(1, restarted.incidents().size());
        assertTrue(restarted.freezer.windows.isEmpty());
    }

    @Test
    public void dumpEvictedForBudgetIsNotCollectedAgain() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.deliverGood(id, dump);
        rig.store.evict("ML395018B-dump-" + id, "budget", true);
        rig.sender.sent.clear();
        rig.syvr(syvrDump(BOOT_C, id, dump.length, BOOT_A, 0, 0));
        assertTrue(rig.sender.sent.isEmpty());
        assertTrue(rig.incidents().isEmpty());
    }

    // ------------------------------------------------------ failed / resumed pulls

    @Test
    public void interruptedRetrievalIsNotMarkedCollectedAndIsRetriedWithBackoff() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        List<String> parts = chunks(dump, 400);
        rig.packet(0, header(id, dump.length, crcHex(dump)));
        rig.packet(1, parts.get(0));
        rig.packet(2, parts.get(1));
        assertTrue(rig.store.dumpPartialFile(key).isFile());

        // The BES goes quiet: the idle timeout fails the attempt and frees the channel.
        rig.sched.advance(AsgConstants.BES_INCIDENT_COLLECT_IDLE_TIMEOUT_MS + 1);
        assertNull(rig.lock.current());
        assertFalse(rig.store.dumpPartialFile(key).exists());
        assertFalse(rig.store.dumpFile(key).exists());
        assertFalse(rig.store.isDumpCollected(id));
        assertEquals("COLLECTING", rig.store.find(key).getString("state"));
        assertEquals(1, rig.store.find(key).getInt("collectAttempts"));
        assertEquals(1, rig.sender.sent.size());
        assertTrue(rig.stored.isEmpty());

        // Retried after the backoff, and a good transfer then completes it.
        // (the failure was 1 ms ago, so the retry is due in BASE - 1 ms)
        rig.sched.advance(AsgConstants.BES_INCIDENT_COLLECT_BACKOFF_BASE_MS - 2);
        assertEquals(1, rig.sender.sent.size());
        rig.sched.advance(2);
        assertEquals(2, rig.sender.sent.size());
        rig.deliverGood(id, dump);
        assertEquals("STORED", rig.store.find(key).getString("state"));
        assertEquals(2, rig.store.find(key).getInt("collectAttempts"));
        assertTrue(rig.store.isDumpCollected(id));
    }

    @Test
    public void startupResumesEveryCollectingIncidentAndDiscardsStalePartials() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.packet(0, header(id, dump.length, crcHex(dump)));
        rig.packet(1, chunks(dump, 400).get(0));
        // The process dies here: COLLECTING record and a stale dump.partial remain.
        assertTrue(rig.store.dumpPartialFile(key).isFile());

        Rig restarted = new Rig(T0 + 30_000);
        assertEquals("COLLECTING", restarted.store.find(key).getString("state"));
        restarted.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        assertEquals(1, restarted.sender.sent.size());
        assertEquals(id, restarted.sender.lastDumpId());
        assertEquals(0, restarted.store.dumpPartialFile(key).length()); // restarted from scratch
        assertTrue(restarted.stored.isEmpty());
        restarted.deliverGood(id, dump);
        assertEquals("STORED", restarted.store.find(key).getString("state"));
        assertEquals(1, restarted.incidents().size());
        assertEquals(2, restarted.store.find(key).getInt("collectAttempts"));
        assertEquals(1, restarted.stored.size());
    }

    @Test
    public void startupResumesSeveralCollectingIncidentsOneAfterTheOther() throws Exception {
        Rig rig = new Rig(T0);
        byte[] first = dumpOf(BOOT_A);
        String firstId = dumpId(1, first);
        rig.syvr(syvrDump(BOOT_B, firstId, first.length, BOOT_A, 0, 0));
        // Seed a second COLLECTING bundle the way an earlier run would have left it.
        byte[] second = dumpOf(BOOT_C);
        String secondId = dumpId(2, second);
        String secondKey = "ML395018B-dump-" + secondId;
        JSONObject record = new JSONObject(BesIncidentStore.readText(
                new File(rig.store.bundleDir("ML395018B-dump-" + firstId), "incident.json")));
        record.put("incidentKey", secondKey).put("dumpId", secondId)
                .put("dumpLen", second.length).put("createdMs", T0 + 1);
        assertTrue(rig.store.prepareBundleDir(secondKey));
        assertTrue(rig.store.create(record));

        // The BES holds only the newer dump now: the first can never complete; it is dropped
        // without being marked collected, and the surviving one resumes.
        Rig restarted = new Rig(T0 + 60_000);
        restarted.syvr(syvrDump(BOOT_B, secondId, second.length, BOOT_C, 0, 0));
        assertNull(restarted.store.find("ML395018B-dump-" + firstId));
        assertFalse(restarted.store.isDumpCollected(firstId));
        assertEquals(1, restarted.sender.sent.size());
        assertEquals(secondId, restarted.sender.lastDumpId());
        restarted.deliverGood(secondId, second);
        assertEquals("STORED", restarted.store.find(secondKey).getString("state"));
        assertEquals(1, restarted.store.evictionSummary().getInt("count"));
        assertEquals("dump_replaced", restarted.store.evictionSummary().getJSONArray("recent")
                .getJSONObject(0).getString("reason"));
    }

    @Test
    public void collectingIncidentIsDroppedWhenTheBesNoLongerHoldsItsDump() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.sched.advance(AsgConstants.BES_INCIDENT_COLLECT_FIRST_PACKET_TIMEOUT_MS + 1);
        assertEquals(1, rig.incidents().size());
        rig.syvr(syvr(true, BOOT_C, null, 0, null, 0, 0)); // BES now reports no dump at all
        assertTrue(rig.incidents().isEmpty());
        assertFalse(rig.store.isDumpCollected(id));
        assertEquals(1, rig.store.evictionSummary().getInt("count"));
    }

    private void expectRejected(byte[] dump, String header, List<String> data, String trailer)
            throws Exception {
        BesIncidentStore.deleteRecursive(mRoot); // each variant starts from a clean device
        Rig rig = new Rig(T0);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.deliver(header, data, trailer);
        JSONObject record = rig.store.find(key);
        assertEquals("COLLECTING", record.getString("state"));
        assertFalse(rig.store.dumpFile(key).exists());
        assertFalse(rig.store.dumpPartialFile(key).exists());
        assertFalse(rig.store.isDumpCollected(id));
        assertTrue(rig.stored.isEmpty());
        assertNull(rig.lock.current());
        assertEquals(1, record.getInt("collectAttempts"));
    }

    @Test
    public void neverStoredUnlessIdentityLengthAndChecksumAllMatch() throws Exception {
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String crc = crcHex(dump);
        List<String> good = chunks(dump, 400);

        // Header names the right dump_id but a crc that is not the one inside dump_id.
        expectRejected(dump, header(id, dump.length, "deadbeef"), good, null);
        // Header length differs from the discovered dump_len.
        expectRejected(dump, header(id, dump.length + 1, crc), good, null);
        // A payload byte flipped in transit.
        List<String> flipped = new ArrayList<>(good);
        flipped.set(1, flipped.get(1).replace('t', 'T'));
        expectRejected(dump, header(id, dump.length, crc), flipped, null);
        // Short and long streams.
        expectRejected(dump, header(id, dump.length, crc), good.subList(0, good.size() - 1), null);
        List<String> longer = new ArrayList<>(good);
        longer.add("extra\n");
        expectRejected(dump, header(id, dump.length, crc), longer, null);
        // No header packet.
        expectRejected(dump, "not a header", good, null);
    }

    @Test
    public void packetContinuityIsChecked() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        List<String> parts = chunks(dump, 400);
        rig.packet(0, header(id, dump.length, crcHex(dump)));
        rig.packet(1, parts.get(0));
        rig.packet(3, parts.get(2)); // packet 2 lost
        rig.packet(4, parts.get(3));
        // The channel stays owned until the BES's end packet so the tail cannot leak elsewhere.
        assertEquals(BesLogTransferLock.Owner.CRASH_CS_LOG, rig.lock.current());
        for (int cur = 5; cur < parts.size() + 1; cur++) {
            rig.packet(cur, parts.get(cur - 1));
        }
        rig.packet(255, "end");
        assertNull(rig.lock.current());
        assertEquals("COLLECTING", rig.store.find(key).getString("state"));
        assertFalse(rig.store.dumpFile(key).exists());
    }

    @Test
    public void dumpIdChangingMidPullDiscardsThePartialAndCollectsTheNewDump() throws Exception {
        Rig rig = new Rig(T0);
        byte[] requested = dumpOf(BOOT_A);
        String requestedId = dumpId(42, requested);
        String requestedKey = "ML395018B-dump-" + requestedId;
        byte[] replacement = dumpOf(BOOT_B);
        String replacementId = dumpId(43, replacement);
        String replacementKey = "ML395018B-dump-" + replacementId;
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, requestedId, requested.length, BOOT_A, 0, 0));
        assertEquals(requestedId, rig.sender.lastDumpId());

        // A newer crash replaced the dump on the BES: the header names it.
        rig.packet(0, header(replacementId, replacement.length, crcHex(replacement)));
        List<String> parts = chunks(replacement, 400);
        for (int i = 0; i < parts.size(); i++) {
            rig.packet(i + 1, parts.get(i));
        }
        assertFalse(rig.store.dumpFile(requestedKey).exists());
        rig.packet(255, "end");

        // The requested one is gone and was never marked collected; the new one is pulled.
        assertNull(rig.store.find(requestedKey));
        assertFalse(rig.store.isDumpCollected(requestedId));
        assertTrue(rig.stored.isEmpty());
        assertNotNull(rig.store.find(replacementKey));
        assertEquals(2, rig.sender.sent.size());
        assertEquals(replacementId, rig.sender.lastDumpId());
        rig.deliverGood(replacementId, replacement);
        assertEquals("STORED", rig.store.find(replacementKey).getString("state"));
        assertEquals(java.util.Collections.singletonList(replacementKey), rig.stored);
        assertTrue(rig.store.isDumpCollected(replacementId));
        assertFalse(rig.store.isDumpCollected(requestedId));
        // Its attribution comes from the dump's own boot id against the boot ASG saw (A).
        assertEquals("older", rig.store.find(replacementKey).getString("attribution"));
    }

    @Test
    public void bothNewAndAlreadyCollectedReplacementDumpAreHandled() throws Exception {
        // The named replacement was already collected: nothing new is opened.
        Rig rig = new Rig(T0);
        byte[] requested = dumpOf(BOOT_A);
        String requestedId = dumpId(42, requested);
        byte[] replacement = dumpOf(BOOT_B);
        String replacementId = dumpId(43, replacement);
        rig.store.markDumpCollected(replacementId);
        rig.syvr(syvrDump(BOOT_B, requestedId, requested.length, BOOT_A, 0, 0));
        rig.deliver(header(replacementId, replacement.length, crcHex(replacement)),
                chunks(replacement, 400), null);
        assertTrue(rig.incidents().isEmpty());
        assertEquals(1, rig.sender.sent.size());
        assertNull(rig.lock.current());
    }

    @Test
    public void headerWithNoDumpFailsTheAttempt() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.packet(0, "[CRASH-DUMP] v=1 dump_id=none len=0 crc=00000000");
        rig.packet(255, "end");
        assertEquals("COLLECTING", rig.store.find(key).getString("state"));
        assertNull(rig.lock.current());
        assertFalse(rig.store.isDumpCollected(id));
    }

    // -------------------------------------------------------------- truncation

    private static final class Truncated {
        final byte[] full;
        final byte[] prefix;
        final String id;

        Truncated() {
            full = bytes(dumpText(BOOT_A, 4000));
            prefix = java.util.Arrays.copyOf(full, 2400);
            id = dumpId(42, full);
        }

        String trailer(long sent, long total, String crc) {
            return "[CRASH-TRUNCATED] sent=" + sent + " total=" + total + " crc=" + crc;
        }
    }

    @Test
    public void truncatedDumpWithMatchingPrefixChecksumIsStoredAndFlagged() throws Exception {
        Truncated t = new Truncated();
        Rig rig = new Rig(T0);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, t.id, t.full.length, BOOT_A, 0, 0));
        rig.deliver(header(t.id, t.full.length, crcHex(t.full)), chunks(t.prefix, 400),
                t.trailer(t.prefix.length, t.full.length, crcHex(t.prefix)));
        JSONObject record = rig.only();
        assertEquals("STORED", record.getString("state"));
        assertTrue(record.getJSONObject("flags").getBoolean("truncated"));
        assertEquals(t.full.length, record.getLong("dumpLen"));
        assertArrayEquals(t.prefix, BesIncidentStore.readBytes(
                rig.store.dumpFile(record.getString("incidentKey"))));
    }

    @Test
    public void truncatedDumpThatDoesNotMatchTheTrailerIsNotStored() throws Exception {
        Truncated t = new Truncated();
        String[][] bad = {
            {"prefix crc", "0", String.valueOf(t.full.length), "deadbeef"},
            {"sent", "1", String.valueOf(t.full.length), null},
            {"total", "0", String.valueOf(t.full.length + 5), null},
        };
        for (String[] variant : bad) {
            BesIncidentStore.deleteRecursive(mRoot);
            Rig rig = new Rig(T0);
            rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
            rig.syvr(syvrDump(BOOT_B, t.id, t.full.length, BOOT_A, 0, 0));
            long sent = t.prefix.length + Long.parseLong(variant[1]);
            String crc = variant[3] != null ? variant[3] : crcHex(t.prefix);
            rig.deliver(header(t.id, t.full.length, crcHex(t.full)), chunks(t.prefix, 400),
                    t.trailer(sent, Long.parseLong(variant[2]), crc));
            String key = "ML395018B-dump-" + t.id;
            assertEquals(variant[0], "COLLECTING", rig.store.find(key).getString("state"));
            assertFalse(variant[0], rig.store.dumpFile(key).exists());
            assertTrue(variant[0], rig.stored.isEmpty());
        }
    }

    // ------------------------------------------------------------ retry limits

    @Test
    public void attemptsAreBoundedAndTheIncidentIsDroppedWithoutBeingCollectedAgain()
            throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        long previousDelay = 0;
        for (int attempt = 1; attempt <= AsgConstants.BES_INCIDENT_COLLECT_MAX_ATTEMPTS; attempt++) {
            assertEquals(attempt, rig.sender.sent.size());
            rig.packet(0, "[CRASH-DUMP] v=1 dump_id=none len=0 crc=00000000");
            rig.packet(255, "end");
            if (attempt < AsgConstants.BES_INCIDENT_COLLECT_MAX_ATTEMPTS) {
                assertEquals("COLLECTING", rig.store.find(key).getString("state"));
                long expectedDelay = Math.min(AsgConstants.BES_INCIDENT_COLLECT_BACKOFF_MAX_MS,
                        AsgConstants.BES_INCIDENT_COLLECT_BACKOFF_BASE_MS << (attempt - 1));
                assertTrue(expectedDelay > previousDelay || expectedDelay == previousDelay);
                previousDelay = expectedDelay;
                rig.sched.advance(expectedDelay - 1);
                assertEquals(attempt, rig.sender.sent.size());
                rig.sched.advance(1);
            }
        }
        assertNull(rig.store.find(key));
        JSONObject evictions = rig.store.evictionSummary();
        assertEquals(1, evictions.getInt("count"));
        assertEquals("collect_failed", evictions.getJSONArray("recent").getJSONObject(0)
                .getString("reason"));
        // The BES still holds the dump, but it is not collected again.
        int sentBefore = rig.sender.sent.size();
        rig.syvr(syvrDump(BOOT_C, id, dump.length, BOOT_A, 0, 0));
        rig.sched.advance(10 * 60_000);
        assertEquals(sentBefore, rig.sender.sent.size());
        assertTrue(rig.incidents().isEmpty());
    }

    @Test
    public void attemptsPersistAcrossRestartsSoCrashLoopsStayBounded() throws Exception {
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        Rig rig = new Rig(T0);
        rig.syvr(syvr(true, BOOT_A, null, 0, null, 0, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        for (int run = 2; run <= AsgConstants.BES_INCIDENT_COLLECT_MAX_ATTEMPTS + 1; run++) {
            // Each process starts the pull and dies mid-transfer.
            rig = new Rig(T0 + run * 1_000_000L);
            rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        }
        assertNull(rig.store.find(key));
        assertEquals(1, rig.store.evictionSummary().getInt("count"));
    }

    @Test
    public void failedSendCountsAsAnAttemptAndIsRetried() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.sender.accept = false;
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        assertEquals(1, rig.sender.sent.size());
        assertNull(rig.lock.current());
        assertEquals(1, rig.store.find(key).getInt("collectAttempts"));
        rig.sender.accept = true;
        rig.sched.advance(AsgConstants.BES_INCIDENT_COLLECT_BACKOFF_BASE_MS);
        assertEquals(2, rig.sender.sent.size());
        rig.deliverGood(id, dump);
        assertEquals("STORED", rig.store.find(key).getString("state"));
    }

    // ------------------------------------------------------------- transfer lock

    @Test
    public void pullWaitsWhileAnotherTransferOwnsTheChannelWithoutCountingAnAttempt()
            throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        assertTrue(rig.lock.acquire(BesLogTransferLock.Owner.USER_MH_LOGS, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.sched.advance(10_000);
        assertTrue(rig.sender.sent.isEmpty());
        assertEquals(0, rig.store.find(key).getInt("collectAttempts"));
        rig.lock.release(BesLogTransferLock.Owner.USER_MH_LOGS);
        rig.sched.advance(AsgConstants.BES_INCIDENT_LOCK_RETRY_MS);
        assertEquals(1, rig.sender.sent.size());
        assertEquals(BesLogTransferLock.Owner.CRASH_CS_LOG, rig.lock.current());
        rig.deliverGood(id, dump);
        assertEquals("STORED", rig.store.find(key).getString("state"));
    }

    @Test
    public void channelThatStaysBusyEventuallyCountsAnAttempt() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        assertTrue(rig.lock.acquire(BesLogTransferLock.Owner.TRACE_TAIL, 0));
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        long budget = (AsgConstants.BES_INCIDENT_LOCK_MAX_DEFERRALS + 1)
                * AsgConstants.BES_INCIDENT_LOCK_RETRY_MS;
        rig.sched.advance(budget);
        assertTrue(rig.sender.sent.isEmpty());
        assertEquals(1, rig.store.find(key).getInt("collectAttempts"));
    }

    @Test
    public void manualReportStartedDuringACrashPullWaitsAndIsNotDropped() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        assertEquals(BesLogTransferLock.Owner.CRASH_CS_LOG, rig.lock.current());

        CountDownLatch queued = new CountDownLatch(1);
        CountDownLatch finished = new CountDownLatch(1);
        boolean[] got = new boolean[1];
        Thread report = new Thread(() -> {
            try {
                queued.countDown();
                got[0] = rig.lock.acquire(BesLogTransferLock.Owner.USER_MH_LOGS,
                        AsgConstants.BES_LOG_USER_LOCK_WAIT_MS);
            } catch (InterruptedException ignored) {
                // got[0] stays false
            }
            finished.countDown();
        });
        report.start();
        assertTrue(queued.await(2, TimeUnit.SECONDS));
        Thread.sleep(150);
        assertFalse(got[0]);
        rig.deliverGood(id, dump); // the pull ends and releases the channel
        assertTrue(finished.await(3, TimeUnit.SECONDS));
        assertTrue(got[0]);
        assertEquals(BesLogTransferLock.Owner.USER_MH_LOGS, rig.lock.current());
        assertEquals(1, rig.stored.size());
    }

    @Test
    public void pullIsDeferredWhileABesOtaOwnsTheUart() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.pullAllowed.set(false);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.sched.advance(6_000);
        assertTrue(rig.sender.sent.isEmpty());
        rig.pullAllowed.set(true);
        rig.sched.advance(AsgConstants.BES_INCIDENT_LOCK_RETRY_MS);
        assertEquals(1, rig.sender.sent.size());
    }

    @Test
    public void logPacketsWithoutATransferAreIgnored() throws Exception {
        Rig rig = new Rig(T0);
        rig.packet(0, header("none", 0, "00000000"));
        rig.packet(255, "end");
        assertTrue(rig.incidents().isEmpty());
        assertNull(rig.lock.current());
    }

    // ---------------------------------------------------------------- freeze

    @Test
    public void unavailableTraceStoreStillProducesAnIncidentWithAnEmptyWindow() throws Exception {
        Rig rig = new Rig(T0);
        rig.freezer.unavailable = true;
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.deliverGood(id, dump);
        JSONObject record = rig.only();
        assertEquals("STORED", record.getString("state"));
        assertEquals(0, record.getLong("coveredFromMs"));
        assertEquals(0, record.getLong("coveredToMs"));
        assertFalse(rig.store.traceFile(record.getString("incidentKey")).exists());
    }

    @Test
    public void frozenTraceLivesInTheBundleAndSurvivesLaterBudgetPressureOnOtherBundles()
            throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        String key = "ML395018B-dump-" + id;
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        rig.deliverGood(id, dump);
        String frozen = BesIncidentStore.readText(rig.store.traceFile(key));
        assertEquals(rig.freezer.content, frozen);
        // The rolling store pruning its own files cannot reach this copy: it is under
        // bes_incident/<key>/, and the incident budget only trims it under real pressure.
        rig.store.enforceBudget(key);
        assertEquals(frozen, BesIncidentStore.readText(rig.store.traceFile(key)));
        assertEquals("bes_incident", mRoot.getName());
        assertEquals(mRoot, rig.store.bundleDir(key).getParentFile());
    }

    @Test
    public void debugSnapshotListsIncidentsAndCollectorState() throws Exception {
        Rig rig = new Rig(T0);
        byte[] dump = dumpOf(BOOT_A);
        String id = dumpId(42, dump);
        rig.syvr(syvrDump(BOOT_B, id, dump.length, BOOT_A, 0, 0));
        JSONObject snapshot = rig.collector.debugSnapshot();
        assertTrue(snapshot.getBoolean("crashPull"));
        assertEquals(id, snapshot.getString("advertisedDumpId"));
        assertEquals("CRASH_CS_LOG", snapshot.getString("lockOwner"));
        assertEquals(1, snapshot.getJSONArray("incidents").length());
        assertEquals(0, snapshot.getJSONObject("evictions").getInt("count"));
    }
}
