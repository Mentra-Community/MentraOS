package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.bes.BesOtaManager;
import com.mentra.asg_client.io.bes.BesOtaSavedStateTestSupport;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesTraceTailTest {
    private final List<String> mSent = new ArrayList<>();
    /** Stored line count when each frame was sent, to prove acks follow the disk write. */
    private final List<Integer> mStoredAtSend = new ArrayList<>();
    private BesTraceTail mTail;

    @Before
    public void setUp() {
        mTail = BesTraceTail.get();
        mTail.resetForTest();
        Context context = ApplicationProvider.getApplicationContext();
        deleteRecursively(new java.io.File(context.getFilesDir(), "bes_trace"));
        mTail.attach(context);
        mTail.setSender(json -> {
            mSent.add(json);
            mStoredAtSend.add(mTail.store().readSince(Long.MAX_VALUE / 4).size());
            return true;
        });
    }

    static void deleteRecursively(java.io.File file) {
        java.io.File[] children = file.listFiles();
        if (children != null) {
            for (java.io.File child : children) deleteRecursively(child);
        }
        file.delete();
    }

    @After
    public void tearDown() {
        mTail.resetForTest();
    }

    private void idle() {
        shadowOf(mTail.looper()).idle();
    }

    private static byte[] frame(String name, JSONObject body) throws Exception {
        return new JSONObject().put("C", name).put("B", body).toString().getBytes(StandardCharsets.UTF_8);
    }

    private static JSONObject data(long g, long p, long e, String text) throws Exception {
        return new JSONObject().put("g", g)
                .put("p", String.format(Locale.US, "%016x", p))
                .put("e", String.format(Locale.US, "%016x", e))
                .put("c", String.format(Locale.US, "%016x", p))
                .put("l", String.format(Locale.US, "%016x", 0))
                .put("n", text.getBytes(StandardCharsets.UTF_8).length)
                .put("t", 1000).put("tp", 1000).put("d", text);
    }

    private String last(String name) {
        for (int i = mSent.size() - 1; i >= 0; i--) {
            if (mSent.get(i).contains("\"C\":\"" + name + "\"")) return mSent.get(i);
        }
        return null;
    }

    @Test
    public void nothingIsSentUntilTheBesAdvertisesSupport() {
        idle();
        assertTrue(mSent.isEmpty());
        mTail.setSupported(true);
        idle();
        assertTrue(last("mh_rlog").contains("\\\"g\\\":0"));
    }

    @Test
    public void persistsBeforeAcknowledgingAndResumesFromTheCursor() throws Exception {
        mTail.setSupported(true);
        idle();
        assertTrue(mTail.onUartPayload(frame("hm_rlog", data(5, 0, 40, " 1000/I/NONE  / 6 | [PWR] a\n"))));
        idle();
        int ackIndex = mSent.indexOf(last("mh_rlog_ack"));
        assertTrue("ack sent", ackIndex >= 0);
        assertEquals("the line was on disk before the ack", 1, (int) mStoredAtSend.get(ackIndex));
        String ack = last("mh_rlog_ack");
        assertTrue(ack, ack.contains("000000000000001c"));
        BesTraceStore.Cursor cursor = mTail.store().loadCursor();
        assertEquals(5, cursor.generation);
        assertEquals(0x1c, cursor.position);
    }

    @Test
    public void readyWindowHoldsALeaseUntilCaughtUp() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog_ready",
                new JSONObject().put("g", 5).put("pending", 30000).put("reason", "fill")));
        idle();
        assertTrue(mTail.windowActive());
        assertTrue(mTail.leaseHeld());
        // Far behind: the window stays open and the next read follows quickly.
        mTail.onUartPayload(frame("hm_rlog", data(5, 0, 30000, "a\n")));
        idle();
        assertTrue(mTail.windowActive());
        mTail.onUartPayload(frame("hm_rlog", data(5, 2, 2, "")));
        idle();
        assertFalse(mTail.windowActive());
        assertFalse(mTail.leaseHeld());
        // Nothing new still acknowledges inside a window (the BES counts it as delivery).
        assertTrue(last("mh_rlog_ack").contains("0000000000000002"));
    }

    @Test
    public void statusFromReadyIsStoredForBugReports() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog_ready",
                new JSONObject().put("g", 5).put("rxovf", 0).put("skip", 3)));
        idle();
        List<BesTraceStore.Line> lines = mTail.store().readSince(Long.MAX_VALUE / 4);
        assertTrue(lines.get(lines.size() - 1).text.startsWith("[ASG-BES-STATUS] "));
        assertTrue(lines.get(lines.size() - 1).text.contains("\"skip\":3"));
    }

    @Test
    public void otherPayloadsAreNotConsumed() {
        assertFalse(mTail.onUartPayload("{\"C\":\"sr_syvr\",\"B\":{}}".getBytes(StandardCharsets.UTF_8)));
        assertFalse(mTail.onUartPayload(null));
    }

    @Test
    public void unsupportedFirmwareNeverServesIncidents() {
        assertFalse(mTail.canServeIncidents());
        mTail.setSupported(true);
        assertTrue(mTail.canServeIncidents());
        mTail.setSupported(false);
        assertFalse(mTail.canServeIncidents());
    }

    // ---- boot ids -----------------------------------------------------------------------

    private static final String BID_A = "9f3a0c1b2d4e5f60";
    private static final String BID_B = "1a2b3c4d5e6f7081";
    private static final String LINE_A = " 1000/I/NONE  / 6 | [PWR] a\n"; // 28 bytes

    private static JSONObject bidData(String bid, long g, long p, long e, String text)
            throws Exception {
        return data(g, p, e, text).put("bid", bid);
    }

    private static String bidArg(String bid) {
        return "\\\"bid\\\":\\\"" + bid + "\\\"";
    }

    private int count(String name) {
        int n = 0;
        for (String json : mSent) {
            if (json.contains("\"C\":\"" + name + "\"")) n++;
        }
        return n;
    }

    private void advance(long ms) {
        shadowOf(mTail.looper()).idleFor(Duration.ofMillis(ms));
    }

    @Test
    public void bootIdIsPersistedAndSentOnReadsAndAcks() throws Exception {
        mTail.setSupported(true);
        idle();
        assertFalse("no bid before the BES named one", last("mh_rlog").contains("bid"));
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        assertTrue(last("mh_rlog_ack"), last("mh_rlog_ack").contains(bidArg(BID_A)));
        BesTraceStore.Cursor cursor = mTail.store().loadCursor();
        assertEquals(BID_A, cursor.bid);
        assertEquals(0x1c, cursor.position);
        advance(2000);
        assertTrue(last("mh_rlog"), last("mh_rlog").contains(bidArg(BID_A)));
    }

    @Test
    public void aNewBootIdWritesAMarkerAndMovesTheCursor() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_B, 5, 0, 40, LINE_A)));
        idle();
        List<String> texts = new ArrayList<>();
        for (BesTraceStore.Line line : mTail.store().readSince(Long.MAX_VALUE / 4)) {
            texts.add(line.text);
        }
        assertTrue(texts.toString(),
                texts.contains("[ASG-BES-REBOOT] old_bid=" + BID_A + " new_bid=" + BID_B));
        assertEquals("both boots' lines are kept", 2, texts.stream()
                .filter(t -> t.contains("[PWR] a")).count());
        assertEquals(BID_B, mTail.store().loadCursor().bid);
        assertTrue(last("mh_rlog_ack").contains(bidArg(BID_B)));
    }

    @Test
    public void oldFirmwareWithoutBidIsUnchanged() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", data(5, 0, 40, LINE_A)));
        idle();
        assertFalse(last("mh_rlog_ack").contains("bid"));
        assertNull(mTail.store().loadCursor().bid);
        mTail.onUartPayload(frame("hm_rlog", data(6, 0, 40, LINE_A)));
        idle();
        List<BesTraceStore.Line> lines = mTail.store().readSince(Long.MAX_VALUE / 4);
        assertTrue(lines.get(1).text.startsWith("[ASG-BES-REBOOT] generation 5 -> 6"));
    }

    @Test
    public void bootIdOnAnAckForAnotherBootTriggersAnImmediateRead() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        int reads = count("mh_rlog");
        mTail.onUartPayload(frame("hm_rlog_ack",
                new JSONObject().put("g", 6).put("ok", 0).put("bid", BID_B)));
        idle();
        assertEquals(reads + 1, count("mh_rlog"));
    }

    @Test
    public void bootChangeListenerFiresOnceForANewBootIdAndNotForTheFirstOne() throws Exception {
        List<String> changes = new ArrayList<>();
        mTail.setBootChangeListener((oldBid, newBid) -> changes.add(oldBid + ">" + newBid));
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        assertTrue("the first boot this store sees is not a change", changes.isEmpty());
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 40, 80, LINE_A)));
        idle();
        assertTrue("the same boot is not a change", changes.isEmpty());
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_B, 5, 0, 40, LINE_A)));
        idle();
        assertEquals(java.util.Collections.singletonList(BID_A + ">" + BID_B), changes);
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_B, 5, 40, 80, LINE_A)));
        idle();
        assertEquals(1, changes.size());
    }

    @Test
    public void bootChangeListenerAlsoHearsTheReadyFrameOfANewBootBeforeAnyRead() throws Exception {
        List<String> changes = new ArrayList<>();
        mTail.setBootChangeListener((oldBid, newBid) -> changes.add(oldBid + ">" + newBid));
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        mTail.onUartPayload(frame("hm_rlog_ready",
                new JSONObject().put("g", 6).put("bid", BID_B)));
        idle();
        assertEquals(java.util.Collections.singletonList(BID_A + ">" + BID_B), changes);
        // The read that then carries the [ASG-BES-REBOOT] marker does not announce it twice.
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_B, 6, 0, 40, LINE_A)));
        idle();
        assertEquals(1, changes.size());
    }

    // ---- duplicates and persistence order -----------------------------------------------

    private BesTraceStore injectedStore(AtomicInteger syncs, AtomicBoolean failSync) {
        File dir = new File(
                ((Context) ApplicationProvider.getApplicationContext()).getFilesDir(), "bes_trace_inj");
        deleteRecursively(dir);
        BesTraceStore store = new BesTraceStore(dir, System::currentTimeMillis, 30 * 60_000L,
                2 * 1024 * 1024, 256 * 1024, 5 * 60_000L, out -> {
                    if (failSync.get()) throw new IOException("injected");
                    syncs.incrementAndGet();
                    out.getFD().sync();
                });
        store.setStatsSink(l -> { });
        mTail.replaceStoreForTest(store);
        return store;
    }

    @Test
    public void aRetryAfterAFailedSyncStoresTheLinesOnceAndAcksAfterwards() throws Exception {
        AtomicInteger syncs = new AtomicInteger();
        AtomicBoolean fail = new AtomicBoolean(true);
        BesTraceStore store = injectedStore(syncs, fail);
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        assertEquals("never acknowledged before it is durable", 0, count("mh_rlog_ack"));
        assertNull(store.loadCursor());

        fail.set(false);
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        assertEquals(1, count("mh_rlog_ack"));
        assertEquals("stored once", 1, store.readSince(Long.MAX_VALUE / 4).size());
        assertEquals(0x1c, store.loadCursor().position);
    }

    // ---- subscription -------------------------------------------------------------------

    private static JSONObject caps(boolean uart, boolean sub) throws Exception {
        return new JSONObject().put("rlog_uart", uart ? 1 : 0).put("rlog_sub", sub ? 1 : 0);
    }

    @Test
    public void subscribesBeforeTheFirstReadWhenTheBesAdvertisesIt() throws Exception {
        mTail.onWireCaps(caps(true, true));
        idle();
        assertTrue(mTail.isSupported());
        assertEquals(1, count("mh_rlog_sub"));
        assertTrue(last("mh_rlog_sub").contains("\\\"on\\\":1"));
        int sub = -1, read = -1;
        for (int i = 0; i < mSent.size(); i++) {
            if (sub < 0 && mSent.get(i).contains("mh_rlog_sub")) sub = i;
            if (read < 0 && mSent.get(i).contains("\"mh_rlog\"")) read = i;
        }
        assertTrue("subscribe first", sub >= 0 && sub < read);
    }

    @Test
    public void subscribesAgainOnEverySrSyvrBecauseTheBesMayHaveClearedItsConsumerState() throws Exception {
        mTail.onWireCaps(caps(true, true));
        idle();
        assertEquals(1, count("mh_rlog_sub"));
        mTail.onWireCaps(caps(true, true)); // the BES announced itself again, with no link loss
        idle();
        assertEquals(2, count("mh_rlog_sub"));
        assertTrue(last("mh_rlog_sub").contains("\\\"on\\\":1"));
    }

    @Test
    public void staysUnsubscribedWithoutTheCapability() throws Exception {
        mTail.onWireCaps(caps(true, false));
        idle();
        mTail.setEnabled(false);
        idle();
        mTail.onWireCaps(caps(false, false));
        idle();
        assertEquals(0, count("mh_rlog_sub"));
        assertTrue(count("mh_rlog") > 0);
    }

    @Test
    public void unsubscribesWhenDisabledAndWhenTheLinkIsInvalidated() throws Exception {
        mTail.onWireCaps(caps(true, true));
        idle();
        mTail.setEnabled(false);
        idle();
        assertEquals(2, count("mh_rlog_sub"));
        assertTrue(last("mh_rlog_sub").contains("\\\"on\\\":0"));
        mTail.setEnabled(true);
        idle();
        assertEquals("subscribes again when enabled", 3, count("mh_rlog_sub"));
        assertTrue(last("mh_rlog_sub").contains("\\\"on\\\":1"));

        mTail.setSupported(false); // UART link invalidation
        idle();
        assertEquals(4, count("mh_rlog_sub"));
        assertTrue(last("mh_rlog_sub").contains("\\\"on\\\":0"));
        mTail.onWireCaps(caps(true, true)); // next sr_syvr
        idle();
        assertEquals(5, count("mh_rlog_sub"));
        assertTrue(last("mh_rlog_sub").contains("\\\"on\\\":1"));
    }

    @Test
    public void resendsUntilTheBesConfirmsAndStopsOnceItDoes() throws Exception {
        mTail.onWireCaps(caps(true, true));
        idle();
        advance(6000);
        assertTrue("unanswered subscribe is retried", count("mh_rlog_sub") >= 2);

        mSent.clear();
        mTail.onUartPayload(frame("hm_rlog_sub", new JSONObject().put("on", 1).put("bid", BID_A)));
        idle();
        advance(12_000);
        assertEquals("confirmed: no more subscribe frames", 0, count("mh_rlog_sub"));

        // A reboot clears the BES side; its hm_rlog_sub {on:0} makes us subscribe again.
        mTail.onUartPayload(frame("hm_rlog_sub", new JSONObject().put("on", 0).put("bid", BID_B)));
        idle();
        advance(1500);
        assertEquals(1, count("mh_rlog_sub"));
    }

    // ---- BES OTA pause ------------------------------------------------------------------

    @Test
    public void pausesForASavedNonFinalOtaStateNotJustTheStaticFlag() {
        Context context = ApplicationProvider.getApplicationContext();
        assertFalse(BesOtaManager.isBesOtaInProgress);
        BesOtaSavedStateTestSupport.reserve(context);
        BesOtaSavedStateTestSupport.markApplyPending(context); // waiting for the apply restart
        mTail.setSupported(true);
        idle();
        advance(3000);
        assertEquals("the UART belongs to the OTA", 0, count("mh_rlog"));

        BesOtaSavedStateTestSupport.fail(context);
        advance(1500);
        assertTrue("terminal state: reading resumes", count("mh_rlog") > 0);
    }

    @Test
    public void staticOtaFlagStillPauses() {
        BesOtaManager.isBesOtaInProgress = true;
        try {
            mTail.setSupported(true);
            idle();
            advance(2000);
            assertEquals(0, count("mh_rlog"));
        } finally {
            BesOtaManager.isBesOtaInProgress = false;
        }
        advance(1500);
        assertTrue(count("mh_rlog") > 0);
    }

    @Test
    public void otaCheckIsInjectable() {
        AtomicBoolean ota = new AtomicBoolean(true);
        mTail.setOtaStateCheck(ota::get);
        mTail.setSupported(true);
        idle();
        assertEquals(0, count("mh_rlog"));
        ota.set(false);
        advance(1500);
        assertTrue(count("mh_rlog") > 0);
    }

    // ---- transfer gate ------------------------------------------------------------------

    private static final class RecordingGate implements BesTraceTail.TransferGate {
        final List<String> events = new ArrayList<>();
        final List<Integer> sentAtRelease = new ArrayList<>();
        boolean allow = true;
        List<String> sent;

        @Override
        public boolean acquire(long timeoutMs) {
            events.add(allow ? "acquire" : "denied");
            return allow;
        }

        @Override
        public void release() {
            events.add("release");
            sentAtRelease.add(sent.size());
        }
    }

    @Test
    public void oneReadWindowRunsInsideTheGate() throws Exception {
        RecordingGate gate = new RecordingGate();
        gate.sent = mSent;
        mTail.setTransferGate(gate);
        mTail.setSupported(true);
        idle();
        assertEquals(1, count("mh_rlog"));
        assertEquals("held while the reply is outstanding", List.of("acquire"), gate.events);

        mTail.onUartPayload(frame("hm_rlog", data(5, 0, 40, LINE_A)));
        idle();
        assertEquals(List.of("acquire", "release"), gate.events);
        assertEquals("the ack went out before the gate was released", 1, count("mh_rlog_ack"));
        assertEquals(mSent.size(), (int) gate.sentAtRelease.get(0));
    }

    @Test
    public void aBusyGateDefersTheReadAndATimeoutDoesNotAcquireTwice() throws Exception {
        RecordingGate gate = new RecordingGate();
        gate.sent = mSent;
        gate.allow = false;
        mTail.setTransferGate(gate);
        mTail.setSupported(true);
        idle();
        assertEquals(0, count("mh_rlog"));
        gate.allow = true;
        advance(1000);
        assertEquals(1, count("mh_rlog"));
        advance(1200); // no reply: re-read inside the same held window
        assertTrue(count("mh_rlog") >= 2);
        assertEquals(1, gate.events.stream().filter("acquire"::equals).count());
        mTail.setEnabled(false);
        idle();
        assertEquals("released when the tail is disabled", "release",
                gate.events.get(gate.events.size() - 1));
    }

    // ---- group commit -------------------------------------------------------------------

    private final List<Integer> mSyncsAtSend = new ArrayList<>();

    private void trackSyncs(AtomicInteger syncs) {
        mSent.clear();
        mTail.setSender(json -> {
            mSent.add(json);
            mSyncsAtSend.add(syncs.get());
            return true;
        });
    }

    @Test
    public void groupCommitSharesOneSyncAndAcksOnlyAfterIt() throws Exception {
        AtomicInteger syncs = new AtomicInteger();
        BesTraceStore store = injectedStore(syncs, new AtomicBoolean());
        trackSyncs(syncs);
        mTail.setGroupCommit(3, 5000);
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 100000, "a\n")));
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 2, 100000, "b\n")));
        idle();
        assertEquals("no sync, no cursor, no ack for two batches", 0, syncs.get());
        assertEquals(0, count("mh_rlog_ack"));
        assertNull(store.loadCursor());
        assertEquals("the lines are already stored", 2, store.readSince(Long.MAX_VALUE / 4).size());
        advance(200);
        assertTrue("reads continue from the read-ahead position",
                last("mh_rlog").contains("0000000000000004"));

        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 4, 100000, "c\n")));
        idle();
        assertEquals(1, count("mh_rlog_ack"));
        int ackIndex = mSent.indexOf(last("mh_rlog_ack"));
        assertTrue("synced before the ack left", mSyncsAtSend.get(ackIndex) >= 1);
        assertTrue(last("mh_rlog_ack").contains("0000000000000006"));
        assertEquals(6, store.loadCursor().position);
        assertTrue(store.statsSummary(), store.statsSummary().contains("batches_per_commit=3.00"));
    }

    @Test
    public void groupCommitCommitsEarlyWhenCaughtUpAndOnTheDeadline() throws Exception {
        AtomicInteger syncs = new AtomicInteger();
        BesTraceStore store = injectedStore(syncs, new AtomicBoolean());
        trackSyncs(syncs);
        mTail.setGroupCommit(8, 250);
        mTail.setSupported(true);
        idle();
        // Nothing left on the BES after this read: no reason to wait.
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 2, "a\n")));
        idle();
        assertEquals(1, count("mh_rlog_ack"));
        assertEquals(2, store.loadCursor().position);

        mSent.clear();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 2, 100000, "b\n")));
        idle();
        assertEquals(0, count("mh_rlog_ack"));
        advance(900); // the deadline passes with no further reply
        assertEquals(1, count("mh_rlog_ack"));
        assertTrue(last("mh_rlog_ack").contains("0000000000000004"));
        assertEquals(4, store.loadCursor().position);
    }

    @Test
    public void aFailedGroupSyncAcknowledgesNothingAndReReadsFromTheDurableCursor() throws Exception {
        AtomicInteger syncs = new AtomicInteger();
        AtomicBoolean fail = new AtomicBoolean();
        BesTraceStore store = injectedStore(syncs, fail);
        trackSyncs(syncs);
        mTail.setGroupCommit(2, 5000);
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 100000, "a\n")));
        idle();
        fail.set(true);
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 2, 100000, "b\n")));
        idle();
        assertEquals(0, count("mh_rlog_ack"));
        assertNull(store.loadCursor());
        advance(1500);
        assertTrue("re-reads from where it was durable", last("mh_rlog").contains("0000000000000000"));

        fail.set(false);
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 100000, "a\n")));
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 2, 100000, "b\n")));
        idle();
        assertEquals(1, count("mh_rlog_ack"));
        assertEquals(4, store.loadCursor().position);
        assertEquals("the re-read lines were not stored twice", 2,
                store.readSince(Long.MAX_VALUE / 4).size());
    }

    @Test
    public void aLinkLossMakesPendingLinesDurableWithoutAcknowledging() throws Exception {
        AtomicInteger syncs = new AtomicInteger();
        BesTraceStore store = injectedStore(syncs, new AtomicBoolean());
        trackSyncs(syncs);
        mTail.setGroupCommit(8, 5000);
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 100000, "a\n")));
        idle();
        assertNull(store.loadCursor());
        mTail.setSupported(false);
        idle();
        assertEquals(0, count("mh_rlog_ack"));
        assertEquals(2, store.loadCursor().position);
        assertTrue(syncs.get() >= 1);
    }

    @Test
    public void dumpReportsThePersistenceAggregates() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog", bidData(BID_A, 5, 0, 40, LINE_A)));
        idle();
        String dump = mTail.dumpStoreStats();
        assertTrue(dump, dump.startsWith("[ASG-BES-STORE] scope=total"));
        assertTrue(dump, dump.contains("batches=1"));
        assertTrue(dump, dump.contains("cursor_saves=1"));
    }
}
