package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

@RunWith(RobolectricTestRunner.class)
public class BesTraceStoreTest {
    private static final long MIN = 60_000;

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private long mNow;
    private File mDir;

    @Before
    public void setUp() {
        mNow = 1_800_000_000_000L;
        mDir = new File(folder.getRoot(), "bes_trace");
    }

    private BesTraceStore store(long maxBytes, long segmentBytes) {
        return new BesTraceStore(mDir, () -> mNow, 30 * MIN, maxBytes, segmentBytes, 5 * MIN);
    }

    private static List<BesTraceStore.Line> lines(long wall, String... texts) {
        List<BesTraceStore.Line> out = new ArrayList<>();
        for (int i = 0; i < texts.length; i++) {
            out.add(new BesTraceStore.Line(wall, 3, 100 + i, texts[i]));
        }
        return out;
    }

    @Test
    public void roundTripsLinesAndCursor() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        assertNull(store.loadCursor());
        assertTrue(store.append(lines(mNow, "one", "two\twith tab")));
        assertTrue(store.saveCursor(new BesTraceStore.Cursor(3, 0x1234)));
        List<BesTraceStore.Line> read = store.readSince(30 * MIN);
        assertEquals(2, read.size());
        assertEquals("two\twith tab", read.get(1).text);
        assertEquals(101, read.get(1).position);
        BesTraceStore.Cursor cursor = store(2 * 1024 * 1024, 256 * 1024).loadCursor();
        assertEquals(3, cursor.generation);
        assertEquals(0x1234, cursor.position);
    }

    @Test
    public void rotatesByAgeAndSizeAndPrunesOldSegments() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.append(lines(mNow, "first"));
        File[] afterFirst = mDir.listFiles((d, n) -> n.endsWith(".log"));
        assertEquals(1, afterFirst.length);
        // The first segment was last written 31 minutes ago.
        assertTrue(afterFirst[0].setLastModified(mNow));
        mNow += 31 * MIN;
        store.append(lines(mNow, "later"));
        File[] segments = mDir.listFiles((d, n) -> n.endsWith(".log"));
        assertEquals(Arrays.toString(segments), 1, segments.length);
        assertEquals(Arrays.asList("later"), texts(store.readSince(30 * MIN)));
    }

    @Test
    public void totalSizeCapDropsOldestSegmentsFirst() {
        BesTraceStore store = store(3 * 1024, 1024);
        char[] fill = new char[400];
        Arrays.fill(fill, 'x');
        for (int i = 0; i < 20; i++) {
            store.append(lines(mNow, i + new String(fill)));
            mNow += 1000;
        }
        assertTrue(store.totalBytes() <= 3 * 1024 + 1024);
        List<String> kept = texts(store.readSince(30 * MIN));
        assertTrue(kept.get(kept.size() - 1).startsWith("19"));
        int oldestKept = Integer.parseInt(kept.get(0).replaceAll("x+$", ""));
        assertTrue("oldest segments were dropped, kept from " + oldestKept, oldestKept > 0);
    }

    @Test
    public void readSinceHonorsTheWindowAndNewestHonorsTheByteCap() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.append(lines(mNow - 40 * MIN, "too old"));
        store.append(lines(mNow - 10 * MIN, "a", "bb", "ccc"));
        assertEquals(Arrays.asList("a", "bb", "ccc"), texts(store.readSince(30 * MIN)));
        assertEquals(Arrays.asList("bb", "ccc"), texts(store.readNewest(30 * MIN, 7)));
    }

    @Test
    public void entriesUseStoredTimestamps() throws Exception {
        JSONArray entries = BesTraceStore.toEntries(lines(1234L, "x"));
        assertEquals(1234L, entries.getJSONObject(0).getLong("timestamp"));
        assertEquals("BES", entries.getJSONObject(0).getString("source"));
        assertEquals("x", entries.getJSONObject(0).getString("message"));
    }


    // ---- freeze -------------------------------------------------------------------------

    private static final String BID_A = "9f3a0c1b2d4e5f60";
    private static final String BID_B = "1a2b3c4d5e6f7081";

    private static BesTraceStore.Line data(long wall, long gen, String bid, long pos, String text) {
        return new BesTraceStore.Line(wall, gen, pos, text, bid);
    }

    private static List<String> fileRows(File file) throws IOException {
        String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        return text.isEmpty() ? new ArrayList<>() : new ArrayList<>(Arrays.asList(
                text.substring(0, text.length() - 1).split("\n", -1)));
    }

    @Test
    public void freezeCopiesTheRangeInStoreFormatAndLeavesTheStoreAlone() throws Exception {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.append(Arrays.asList(
                data(mNow - 5000, 3, null, 0, "before"),
                data(mNow - 3000, 3, null, 10, "one"),
                new BesTraceStore.Line(mNow - 2500, 3, 20,
                        "[ASG-BES-GAP] lost=5 bytes before position 14"),
                data(mNow - 2000, 3, null, 30, "two"),
                data(mNow - 100, 3, null, 40, "after")));
        long before = store.totalBytes();
        List<BesTraceStore.Line> storedBefore = store.readSince(30 * MIN);

        File dest = new File(folder.getRoot(), "incident/trace.txt");
        BesTraceStore.Frozen frozen = store.freeze(dest, mNow - 3000, mNow - 2000, 1024);

        assertEquals(3, frozen.lines);
        assertEquals(1, frozen.gaps);
        assertFalse(frozen.truncated);
        assertEquals(mNow - 3000, frozen.firstWallMs);
        assertEquals(mNow - 2000, frozen.lastWallMs);
        assertEquals(dest.length(), frozen.bytes);
        assertEquals(Arrays.asList(
                (mNow - 3000) + "\t3\ta\tone",
                (mNow - 2500) + "\t3\t14\t[ASG-BES-GAP] lost=5 bytes before position 14",
                (mNow - 2000) + "\t3\t1e\ttwo"), fileRows(dest));
        assertFalse(new File(dest.getPath() + ".tmp").exists());
        assertEquals("freeze never removes or rewrites anything", before, store.totalBytes());
        assertEquals(texts(storedBefore), texts(store.readSince(30 * MIN)));
    }

    @Test
    public void freezeOverBudgetKeepsTheNewestLines() throws Exception {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        List<BesTraceStore.Line> in = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            in.add(data(mNow - 1000 + i, 3, null, i * 10, "line-" + i));
        }
        store.append(in);
        File dest = new File(folder.getRoot(), "trace.txt");
        // Each row is "<13 digits>\t3\t<2 hex>\tline-N\n" = 13+1+1+1+2+1+6+1 = 26 bytes.
        BesTraceStore.Frozen frozen = store.freeze(dest, 0, Long.MAX_VALUE, 26 * 3 + 10);
        assertEquals(3, frozen.lines);
        assertTrue(frozen.truncated);
        assertTrue(frozen.bytes <= 26 * 3 + 10);
        List<String> rows = fileRows(dest);
        assertTrue(rows.get(0).endsWith("line-7"));
        assertTrue(rows.get(2).endsWith("line-9"));
        assertEquals(mNow - 1000 + 7, frozen.firstWallMs);
        assertEquals(mNow - 1000 + 9, frozen.lastWallMs);
    }

    @Test
    public void freezeOfNothingWritesAnEmptyFile() throws Exception {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.append(lines(mNow, "x"));
        File dest = new File(folder.getRoot(), "trace.txt");
        BesTraceStore.Frozen frozen = store.freeze(dest, mNow + 1, mNow + 2, 1024);
        assertEquals(0, frozen.lines);
        assertEquals(0, frozen.bytes);
        assertEquals(0, frozen.firstWallMs);
        assertEquals(0, frozen.lastWallMs);
        assertFalse(frozen.truncated);
        assertTrue(dest.exists());
        assertEquals(0, dest.length());
    }

    @Test
    public void freezeReplacesAtomicallyAndFailureLeavesTheOldCopy() throws Exception {
        AtomicBoolean fail = new AtomicBoolean();
        BesTraceStore store = new BesTraceStore(mDir, () -> mNow, 30 * MIN, 2 * 1024 * 1024,
                256 * 1024, 5 * MIN, out -> {
                    if (fail.get()) throw new IOException("injected");
                    out.getFD().sync();
                });
        store.append(lines(mNow, "x"));
        File dest = new File(folder.getRoot(), "trace.txt");
        store.freeze(dest, 0, Long.MAX_VALUE, 1024);
        byte[] first = Files.readAllBytes(dest.toPath());
        store.append(lines(mNow, "y"));
        fail.set(true);
        try {
            store.freeze(dest, 0, Long.MAX_VALUE, 1024);
            fail("a failed freeze must not look successful");
        } catch (UncheckedIOException expected) {
            // The previous copy is intact and no tmp file is left behind.
        }
        assertEquals(new String(first, StandardCharsets.UTF_8),
                new String(Files.readAllBytes(dest.toPath()), StandardCharsets.UTF_8));
        assertFalse(new File(dest.getPath() + ".tmp").exists());
    }

    @Test
    public void freezeRacingAppendAndPruningAlwaysProducesAConsistentCopy() throws Exception {
        AtomicLong clock = new AtomicLong(mNow);
        // 600-byte segments and a 3 KB cap: pruning deletes segments all the time.
        BesTraceStore store = new BesTraceStore(mDir, clock::get, 30 * MIN, 3 * 1024, 600, 5 * MIN);
        store.setDuplicateGuard(true);
        AtomicBoolean stop = new AtomicBoolean();
        AtomicInteger failures = new AtomicInteger();
        Thread appender = new Thread(() -> {
            long pos = 0;
            for (int i = 0; i < 1500 && !stop.get(); i++) {
                List<BesTraceStore.Line> batch = new ArrayList<>();
                for (int j = 0; j < 3; j++) {
                    batch.add(data(clock.get(), 3, BID_A, pos, "line " + pos));
                    pos += 20;
                }
                if (!store.append(batch)) failures.incrementAndGet();
                clock.addAndGet(5);
            }
        });
        appender.start();
        int freezes = 0;
        try {
            while (appender.isAlive()) {
                File dest = new File(folder.getRoot(), "race/trace-" + (freezes % 3) + ".txt");
                BesTraceStore.Frozen frozen = store.freeze(dest, 0, Long.MAX_VALUE, 1500);
                List<String> rows = fileRows(dest);
                assertEquals(frozen.lines, rows.size());
                assertEquals(dest.length(), frozen.bytes);
                assertTrue(frozen.bytes <= 1500);
                long last = -1;
                for (String row : rows) {
                    String[] parts = row.split("\t", 4);
                    assertEquals("whole rows only: " + row, 4, parts.length);
                    long pos = Long.parseLong(parts[2], 16);
                    assertEquals("line " + pos, parts[3]);
                    assertTrue("monotonic positions", pos > last);
                    last = pos;
                }
                freezes++;
            }
        } finally {
            stop.set(true);
            appender.join();
        }
        assertEquals(0, failures.get());
        assertTrue("raced at least a few freezes against the appender", freezes > 3);
    }

    // ---- recovery -----------------------------------------------------------------------

    private File newestSegment() {
        File[] files = mDir.listFiles((d, n) -> n.endsWith(".log"));
        Arrays.sort(files);
        return files[files.length - 1];
    }

    private static void appendRaw(File file, String text) throws IOException {
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    @Test
    public void aTornLastLineIsNeverReturnedAndDoesNotSwallowTheNextWrite() throws Exception {
        BesTraceStore first = store(2 * 1024 * 1024, 256 * 1024);
        first.append(lines(mNow, "complete one", "complete two"));
        // An interrupted append: the process died halfway through the next row.
        appendRaw(newestSegment(), mNow + "\t3\t66\ttruncated li");
        for (File f : mDir.listFiles((d, n) -> n.endsWith(".log"))) assertTrue(f.setLastModified(mNow));

        BesTraceStore second = store(2 * 1024 * 1024, 256 * 1024);
        assertEquals(Arrays.asList("complete one", "complete two"),
                texts(second.readSince(30 * MIN)));
        mNow += 1;
        assertTrue(second.append(lines(mNow, "after restart")));
        assertEquals(Arrays.asList("complete one", "complete two", "after restart"),
                texts(second.readSince(30 * MIN)));
        File dest = new File(folder.getRoot(), "t.txt");
        assertEquals(3, second.freeze(dest, 0, Long.MAX_VALUE, 4096).lines);
    }

    @Test
    public void cursorFileFormatsAreReadAndATornOneIsDistrusted() throws Exception {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        File cursor = new File(mDir, "cursor");

        Files.write(cursor.toPath(), "5 4660\n".getBytes(StandardCharsets.UTF_8));
        BesTraceStore.Cursor old = store.loadCursor();
        assertEquals(5, old.generation);
        assertEquals(4660, old.position);
        assertNull("the old format has no bid", old.bid);

        assertTrue(store.saveCursor(new BesTraceStore.Cursor(BID_A, 6, 99)));
        assertEquals("6 99 " + BID_A + "\n",
                new String(Files.readAllBytes(cursor.toPath()), StandardCharsets.UTF_8));
        BesTraceStore.Cursor current = store.loadCursor();
        assertEquals(BID_A, current.bid);
        assertEquals(6, current.generation);
        assertEquals(99, current.position);

        // Downgrade safety: a reader of the old format sees the same generation and position.
        String[] legacy = "6 99 9f3a0c1b2d4e5f60".split(" ");
        assertEquals(6, Long.parseLong(legacy[0]));
        assertEquals(99, Long.parseLong(legacy[1]));

        for (String torn : new String[] {"6 99", "6 99 9f3a0c", "6 99 " + BID_A, "6", "x y\n",
                "6 99 9F3A0C1B2D4E5F60\n", "6 -1\n", ""}) {
            Files.write(cursor.toPath(), torn.getBytes(StandardCharsets.UTF_8));
            assertNull("torn cursor: <" + torn + ">", store.loadCursor());
        }
    }

    @Test
    public void anInterruptedCursorCheckpointKeepsTheOldCursor() throws Exception {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        assertTrue(store.saveCursor(new BesTraceStore.Cursor(BID_A, 3, 100)));
        // The process died while writing the next checkpoint: a half-written tmp file remains.
        Files.write(new File(mDir, "cursor.tmp").toPath(), "3 2".getBytes(StandardCharsets.UTF_8));

        BesTraceStore restarted = store(2 * 1024 * 1024, 256 * 1024);
        BesTraceStore.Cursor cursor = restarted.loadCursor();
        assertEquals(100, cursor.position);
        assertEquals(BID_A, cursor.bid);
        assertTrue(restarted.saveCursor(new BesTraceStore.Cursor(BID_A, 3, 200)));
        assertEquals(200, restarted.loadCursor().position);
        assertFalse(new File(mDir, "cursor.tmp").exists());
    }

    @Test
    public void aCursorAheadOfTheLogDoesNotBlockOrDropNewLines() {
        BesTraceStore first = store(2 * 1024 * 1024, 256 * 1024);
        first.setDuplicateGuard(true);
        first.append(Collections.singletonList(data(mNow, 3, BID_A, 100, "old")));
        first.saveCursor(new BesTraceStore.Cursor(BID_A, 3, 9000));
        // The log lost its newest data (pruned or wiped) but the cursor survived.
        for (File f : mDir.listFiles((d, n) -> n.endsWith(".log"))) assertTrue(f.delete());

        BesTraceStore restarted = store(2 * 1024 * 1024, 256 * 1024);
        restarted.setDuplicateGuard(true);
        assertEquals(9000, restarted.loadCursor().position);
        assertTrue(restarted.append(Arrays.asList(data(mNow, 3, BID_A, 9000, "new"),
                data(mNow, 3, BID_A, 9010, "newer"))));
        assertEquals(Arrays.asList("new", "newer"), texts(restarted.readSince(30 * MIN)));
    }

    // ---- duplicates ---------------------------------------------------------------------

    @Test
    public void aRetriedBatchIsNotStoredTwice() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.setDuplicateGuard(true);
        List<BesTraceStore.Line> batch = Arrays.asList(
                data(mNow, 3, BID_A, 0, "a"), data(mNow, 3, BID_A, 10, "b"),
                data(mNow, 3, BID_A, 20, "c"));
        assertTrue(store.append(batch));
        assertTrue("the retry still reports success", store.append(batch));
        assertEquals(Arrays.asList("a", "b", "c"), texts(store.readSince(30 * MIN)));

        // A retry that continues past the stored lines stores only the new ones.
        assertTrue(store.append(Arrays.asList(
                data(mNow, 3, BID_A, 10, "b"), data(mNow, 3, BID_A, 20, "c"),
                data(mNow, 3, BID_A, 30, "d"))));
        assertEquals(Arrays.asList("a", "b", "c", "d"), texts(store.readSince(30 * MIN)));
    }

    @Test
    public void markersAreDeduplicatedByTheirExactKey() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.setDuplicateGuard(true);
        List<BesTraceStore.Line> batch = Arrays.asList(
                data(mNow, 4, BID_B, 500, "[ASG-BES-REBOOT] old_bid=" + BID_A + " new_bid=" + BID_B),
                data(mNow, 4, BID_B, 500, "[ASG-BES-GAP] lost=8 bytes before position 1f4"),
                data(mNow, 4, BID_B, 500, "first"));
        store.append(batch);
        store.append(batch);
        assertEquals(3, store.readSince(30 * MIN).size());

        // Status lines carry changing counters and are never treated as replays.
        BesTraceStore.Line status = data(mNow, 4, BID_B, 600, "[ASG-BES-STATUS] {\"skip\":1}");
        store.append(Collections.singletonList(status));
        store.append(Collections.singletonList(status));
        assertEquals(5, store.readSince(30 * MIN).size());
    }

    @Test
    public void positionsRestartAfterARebootWithoutDroppingLines() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.setDuplicateGuard(true);
        store.append(Arrays.asList(data(mNow, 3, BID_A, 90000, "old boot")));
        // New boot, positions start from zero again, with and without the REBOOT marker.
        store.append(Arrays.asList(
                data(mNow, 4, BID_B, 0, "[ASG-BES-REBOOT] old_bid=" + BID_A + " new_bid=" + BID_B),
                data(mNow, 4, BID_B, 0, "new boot")));
        store.append(Arrays.asList(data(mNow, 4, BID_A, 5, "same g other bid")));
        assertEquals(Arrays.asList("old boot",
                "[ASG-BES-REBOOT] old_bid=" + BID_A + " new_bid=" + BID_B, "new boot",
                "same g other bid"), texts(store.readSince(30 * MIN)));
    }

    @Test
    public void retriesAfterARestartAreRecognisedFromTheLog() {
        BesTraceStore first = store(2 * 1024 * 1024, 256 * 1024);
        first.setDuplicateGuard(true);
        List<BesTraceStore.Line> batch = Arrays.asList(
                data(mNow, 4, BID_B, 0, "[ASG-BES-REBOOT] old_bid=" + BID_A + " new_bid=" + BID_B),
                data(mNow, 4, BID_B, 0, "x"), data(mNow, 4, BID_B, 10, "y"));
        first.append(batch);
        first.saveCursor(new BesTraceStore.Cursor(BID_A, 3, 1000)); // The ack never happened.

        BesTraceStore second = store(2 * 1024 * 1024, 256 * 1024);
        second.setDuplicateGuard(true);
        second.append(batch);
        assertEquals(3, second.readSince(30 * MIN).size());
        second.append(Collections.singletonList(data(mNow, 4, BID_B, 20, "z")));
        assertEquals(4, second.readSince(30 * MIN).size());
    }

    @Test
    public void retriesAfterARestartWorkForOldFirmwareWithoutBid() {
        BesTraceStore first = store(2 * 1024 * 1024, 256 * 1024);
        first.setDuplicateGuard(true);
        first.append(Arrays.asList(data(mNow, 7, null, 0, "a"), data(mNow, 7, null, 10, "b")));
        first.saveCursor(new BesTraceStore.Cursor(7, 0));

        BesTraceStore second = store(2 * 1024 * 1024, 256 * 1024);
        second.setDuplicateGuard(true);
        second.append(Arrays.asList(data(mNow, 7, null, 0, "a"), data(mNow, 7, null, 10, "b"),
                data(mNow, 7, null, 20, "c")));
        assertEquals(Arrays.asList("a", "b", "c"), texts(second.readSince(30 * MIN)));
    }

    @Test
    public void withoutAKnownBootNothingIsDroppedForANewBid() {
        // Rows from before boot ids, no cursor: a reply that names a bid is never treated as a
        // replay, so a reboot is never mistaken for a retry.
        BesTraceStore first = store(2 * 1024 * 1024, 256 * 1024);
        first.setDuplicateGuard(true);
        first.append(Arrays.asList(data(mNow, 7, null, 5000, "old")));

        BesTraceStore second = store(2 * 1024 * 1024, 256 * 1024);
        second.setDuplicateGuard(true);
        second.append(Arrays.asList(data(mNow, 7, BID_A, 0, "fresh")));
        assertEquals(Arrays.asList("old", "fresh"), texts(second.readSince(30 * MIN)));
    }

    @Test
    public void theGuardIsOffByDefault() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.append(lines(mNow, "a"));
        store.append(lines(mNow, "a"));
        assertEquals(2, store.readSince(30 * MIN).size());
    }

    // ---- sync control and measurement -------------------------------------------------

    @Test
    public void appendUnsyncedDefersTheSyncUntilSyncIsCalled() {
        AtomicInteger syncs = new AtomicInteger();
        AtomicBoolean failNext = new AtomicBoolean();
        BesTraceStore store = new BesTraceStore(mDir, () -> mNow, 30 * MIN, 2 * 1024 * 1024,
                256 * 1024, 5 * MIN, out -> {
                    if (failNext.get()) throw new IOException("injected");
                    syncs.incrementAndGet();
                    out.getFD().sync();
                });
        assertTrue(store.appendUnsynced(lines(mNow, "a")));
        assertTrue(store.appendUnsynced(lines(mNow, "b")));
        assertEquals("no sync yet", 0, syncs.get());
        assertEquals("the lines are readable already", 2, store.readSince(30 * MIN).size());

        failNext.set(true);
        assertFalse("a failed sync is reported", store.sync());
        failNext.set(false);
        assertTrue("and retried until it works", store.sync());
        assertEquals(1, syncs.get());
        assertTrue("nothing left to sync", store.sync());
        assertEquals(1, syncs.get());

        assertTrue(store.append(lines(mNow, "c")));
        assertEquals("append() is write + sync", 2, syncs.get());
        failNext.set(true);
        assertFalse(store.append(lines(mNow, "d")));
        assertFalse("the data is not acknowledged-safe until a sync succeeds", store.sync());
    }

    @Test
    public void persistenceAggregatesAreLoggedAtMostOncePerInterval() {
        List<String> logged = new ArrayList<>();
        AtomicLong nanos = new AtomicLong();
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.setStatsSink(logged::add);
        store.setStatsIntervalMs(MIN);
        store.setNanoClockForTest(() -> nanos.addAndGet(2_000_000)); // every reading is 2 ms apart
        for (int i = 0; i < 30; i++) {
            store.append(lines(mNow, "a" + i));
            store.saveCursor(new BesTraceStore.Cursor(3, i));
            store.recordCommit(1);
            mNow += 1000; // 30 batches in 30 s
        }
        assertTrue("nothing is logged per batch: " + logged, logged.isEmpty());
        for (int i = 0; i < 40; i++) {
            store.append(lines(mNow, "b" + i));
            store.saveCursor(new BesTraceStore.Cursor(3, i));
            store.recordCommit(1);
            mNow += 1000;
        }
        assertEquals("70 s of traffic is one line, not 70: " + logged, 1, logged.size());
        String line = logged.get(0);
        assertTrue(line, line.startsWith("[ASG-BES-STORE] scope=window"));
        assertTrue(line, line.contains("batches=") && line.contains("log_sync_ms(avg/max)="));
        assertTrue(line, line.contains("cursor_saves=") && line.contains("persist_ms_per_batch="));
        assertTrue(line, line.contains("batches_per_commit=1.00"));

        String total = store.statsSummary();
        assertTrue(total, total.contains("scope=total"));
        assertTrue(total, total.contains("batches=70"));
        assertTrue(total, total.contains("commits=70"));
    }

    @Test
    public void groupedCommitsReportBatchesPerCommit() {
        BesTraceStore store = store(2 * 1024 * 1024, 256 * 1024);
        store.setStatsSink(l -> { });
        for (int i = 0; i < 8; i++) {
            store.appendUnsynced(lines(mNow, "g" + i));
        }
        store.sync();
        store.saveCursor(new BesTraceStore.Cursor(3, 1));
        store.recordCommit(8);
        String summary = store.statsSummary();
        assertTrue(summary, summary.contains("log_syncs=1"));
        assertTrue(summary, summary.contains("batches=8"));
        assertTrue(summary, summary.contains("batches_per_commit=8.00"));
        assertNotNull(summary);
    }

    private static List<String> texts(List<BesTraceStore.Line> lines) {
        List<String> out = new ArrayList<>();
        for (BesTraceStore.Line line : lines) out.add(line.text);
        return out;
    }
}
