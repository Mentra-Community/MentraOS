package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

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

    private static List<String> texts(List<BesTraceStore.Line> lines) {
        List<String> out = new ArrayList<>();
        for (BesTraceStore.Line line : lines) out.add(line.text);
        return out;
    }
}
