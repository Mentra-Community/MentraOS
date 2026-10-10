package com.mentra.asg_client.io.bes.log;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * Rolling on-disk store of BES TRACE lines delivered over mh_rlog, attached to bug reports.
 *
 * <p>Lines are written to segments of at most {@code segmentMaxBytes} or {@code segmentMaxAgeMs};
 * segments whose newest line is older than {@code retentionMs} are deleted, and the oldest
 * segments go first when the total passes {@code maxBytes}. Every append is flushed and synced
 * before {@link #saveCursor} records the BES position it covers, so an acknowledgement sent after
 * {@link #saveCursor} never names data that could still be lost to an ASG restart. Callers that
 * group several batches use {@link #appendUnsynced} and one {@link #sync} before the cursor save;
 * the ordering rule (sync, then cursor, then acknowledgement) is the same.
 *
 * <p>Each stored line is {@code wallMs \t generation \t positionHex \t text}. A line without a
 * trailing newline is an interrupted write and is never returned by any reader. A retry of a batch
 * that was stored but not acknowledged is not stored twice: positions are monotonic per BES boot
 * (bid) and generation, so a data line at or before the last stored position of the same boot is
 * dropped.
 */
public final class BesTraceStore {
    private static final String TAG = "BesTraceStore";

    /** One BES line (or an ASG marker) with the wall time its BES timestamp maps to. */
    public static final class Line {
        public final long wallMs;
        public final long generation;
        public final long position;
        public final String text;
        /** BES boot id the line came from; null for old firmware. Not stored on disk. */
        public final String bid;

        public Line(long wallMs, long generation, long position, String text) {
            this(wallMs, generation, position, text, null);
        }

        public Line(long wallMs, long generation, long position, String text, String bid) {
            this.wallMs = wallMs;
            this.generation = generation;
            this.position = position;
            this.text = text;
            this.bid = bid;
        }
    }

    /** Last BES position persisted, with its boot id (when the firmware has one) and generation. */
    public static final class Cursor {
        /** 16 lowercase hex chars, or null for firmware without boot ids. */
        public final String bid;
        public final long generation;
        public final long position;

        public Cursor(long generation, long position) {
            this(null, generation, position);
        }

        public Cursor(String bid, long generation, long position) {
            this.bid = bid;
            this.generation = generation;
            this.position = position;
        }
    }

    /** The result of {@link #freeze}. */
    public static final class Frozen {
        public final int lines;
        public final long bytes;
        /** Oldest wall time in the copy; 0 when empty. */
        public final long firstWallMs;
        /** Newest wall time in the copy; 0 when empty. */
        public final long lastWallMs;
        /** [ASG-BES-GAP] lines inside the copy. */
        public final int gaps;
        /** Older lines were dropped to fit maxBytes. */
        public final boolean truncated;

        public Frozen(int lines, long bytes, long firstWallMs, long lastWallMs, int gaps,
                      boolean truncated) {
            this.lines = lines;
            this.bytes = bytes;
            this.firstWallMs = firstWallMs;
            this.lastWallMs = lastWallMs;
            this.gaps = gaps;
            this.truncated = truncated;
        }
    }

    public interface Clock {
        long nowMs();
    }

    /** Makes written data durable. Injectable so tests can count and fail syncs. */
    public interface Syncer {
        void sync(FileOutputStream out) throws IOException;
    }

    /** Receives the periodic [ASG-BES-STORE] aggregate line. */
    public interface StatsSink {
        void log(String line);
    }

    static final String GAP_PREFIX = "[ASG-BES-GAP]";
    static final String REBOOT_PREFIX = "[ASG-BES-REBOOT]";
    static final String MARKER_PREFIX = "[ASG-BES-";
    static final String STORE_STATS_PREFIX = "[ASG-BES-STORE]";

    private static final String SEGMENT_PREFIX = "trace-";
    private static final String SEGMENT_SUFFIX = ".log";
    private static final String CURSOR_FILE = "cursor";
    private static final Pattern BID = Pattern.compile("[0-9a-f]{16}");
    private static final String UNKNOWN_BID = "?";

    private final File mDir;
    private final Clock mClock;
    private final long mRetentionMs;
    private final long mMaxBytes;
    private final long mSegmentMaxBytes;
    private final long mSegmentMaxAgeMs;
    private final Syncer mSyncer;
    private LongSupplier mNanoClock = System::nanoTime;
    private StatsSink mStatsSink = line -> Log.i(TAG, line);
    private long mStatsIntervalMs = 60_000;

    private File mSegment;
    private long mSegmentStartMs;
    private int mSequence;
    /** Segments with written but not yet synced data, oldest first. */
    private final Set<File> mUnsynced = new LinkedHashSet<>();

    private Dedup mDedup = new Dedup();
    private boolean mNeedsRecovery = true;
    private boolean mDuplicateGuard;

    private Aggregate mWindow = new Aggregate();
    private final Aggregate mTotal = new Aggregate();
    private long mWindowStartMs = -1;

    public BesTraceStore(File dir, Clock clock, long retentionMs, long maxBytes,
                         long segmentMaxBytes, long segmentMaxAgeMs) {
        this(dir, clock, retentionMs, maxBytes, segmentMaxBytes, segmentMaxAgeMs,
                out -> out.getFD().sync());
    }

    public BesTraceStore(File dir, Clock clock, long retentionMs, long maxBytes,
                         long segmentMaxBytes, long segmentMaxAgeMs, Syncer syncer) {
        mDir = dir;
        mClock = clock;
        mRetentionMs = retentionMs;
        mMaxBytes = maxBytes;
        mSegmentMaxBytes = segmentMaxBytes;
        mSegmentMaxAgeMs = segmentMaxAgeMs;
        mSyncer = syncer;
        //noinspection ResultOfMethodCallIgnored
        mDir.mkdirs();
    }

    // ---------------------------------------------------------------------------------------
    // Append / sync / cursor
    // ---------------------------------------------------------------------------------------

    /** Append and sync; returns false when the disk write failed (nothing may be acknowledged). */
    public synchronized boolean append(List<Line> lines) {
        boolean written = write(lines);
        return written && sync();
    }

    /**
     * Append without syncing. The caller must call {@link #sync} and {@link #saveCursor} before it
     * acknowledges anything these lines cover.
     */
    public synchronized boolean appendUnsynced(List<Line> lines) {
        return write(lines);
    }

    /** Makes everything appended so far durable; false when any sync failed. */
    public synchronized boolean sync() {
        boolean ok = true;
        for (File segment : new ArrayList<>(mUnsynced)) {
            if (!segment.exists()) {
                mUnsynced.remove(segment);
                continue;
            }
            long started = mNanoClock.getAsLong();
            try (FileOutputStream out = new FileOutputStream(segment, true)) {
                mSyncer.sync(out);
                mUnsynced.remove(segment);
                mWindow.recordLogSync(mNanoClock.getAsLong() - started);
            } catch (IOException e) {
                mWindow.failures++;
                ok = false;
            }
        }
        maybeEmitStats();
        return ok;
    }

    private boolean write(List<Line> lines) {
        if (lines.isEmpty()) {
            return true;
        }
        recoverIfNeeded();
        long now = mClock.nowMs();
        Dedup next = mDedup.copy();
        StringBuilder text = new StringBuilder();
        int kept = 0;
        for (Line line : lines) {
            if (mDuplicateGuard && !next.accept(line)) {
                mWindow.dupSkipped++;
                continue;
            }
            kept++;
            text.append(line.wallMs).append('\t')
                    .append(line.generation).append('\t')
                    .append(Long.toHexString(line.position)).append('\t')
                    .append(line.text.replace('\n', ' ').replace('\r', ' '))
                    .append('\n');
        }
        if (kept == 0) {
            return true;
        }
        byte[] bytes = text.toString().getBytes(StandardCharsets.UTF_8);
        File segment = currentSegment(now, bytes.length);
        long started = mNanoClock.getAsLong();
        try (FileOutputStream out = new FileOutputStream(segment, true)) {
            mUnsynced.add(segment);
            out.write(bytes);
            out.flush();
        } catch (IOException e) {
            // Part of the batch may be on disk: never append to this segment again (a torn last
            // line would swallow the next write) and rebuild the duplicate filter from disk.
            mSegment = null;
            mNeedsRecovery = true;
            mWindow.failures++;
            return false;
        }
        mDedup = next;
        mWindow.recordAppend(kept, bytes.length, mNanoClock.getAsLong() - started);
        prune(now);
        return true;
    }

    public synchronized boolean saveCursor(Cursor cursor) {
        long started = mNanoClock.getAsLong();
        File tmp = new File(mDir, CURSOR_FILE + ".tmp");
        String content = cursor.generation + " " + cursor.position
                + (cursor.bid != null ? " " + cursor.bid : "") + "\n";
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
            out.flush();
            mSyncer.sync(out);
        } catch (IOException e) {
            mWindow.failures++;
            return false;
        }
        boolean renamed = tmp.renameTo(new File(mDir, CURSOR_FILE));
        if (!renamed) {
            mWindow.failures++;
        }
        mWindow.recordCursor(mNanoClock.getAsLong() - started);
        maybeEmitStats();
        return renamed;
    }

    /**
     * The persisted cursor, or null when none was saved or the file is not trustworthy (torn).
     * Reads both the current {@code generation position [bid]} format and the older
     * {@code generation position}.
     */
    public synchronized Cursor loadCursor() {
        return loadCursorLocked();
    }

    private Cursor loadCursorLocked() {
        File file = new File(mDir, CURSOR_FILE);
        if (!file.exists()) {
            return null;
        }
        try {
            byte[] raw = readAll(file);
            if (raw.length == 0 || raw[raw.length - 1] != '\n') {
                return null; // Interrupted write.
            }
            String[] parts = new String(raw, StandardCharsets.UTF_8).trim().split(" ");
            if (parts.length != 2 && parts.length != 3) {
                return null;
            }
            long generation = Long.parseLong(parts[0]);
            long position = Long.parseLong(parts[1]);
            String bid = null;
            if (parts.length == 3) {
                if (!BID.matcher(parts[2]).matches()) {
                    return null;
                }
                bid = parts[2];
            }
            if (generation < 0 || position < 0) {
                return null;
            }
            return new Cursor(bid, generation, position);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------

    /** Lines no older than {@code windowMs}, oldest first. */
    public synchronized List<Line> readSince(long windowMs) {
        long oldest = mClock.nowMs() - windowMs;
        List<Line> out = new ArrayList<>();
        for (File segment : segments()) {
            for (String row : readRows(segment)) {
                Line line = parse(row);
                if (line != null && line.wallMs >= oldest) {
                    out.add(line);
                }
            }
        }
        return out;
    }

    /** The newest lines whose text fits in {@code maxBytes}, oldest first. */
    public synchronized List<Line> readNewest(long windowMs, int maxBytes) {
        List<Line> all = readSince(windowMs);
        ArrayDeque<Line> kept = new ArrayDeque<>();
        int used = 0;
        for (int i = all.size() - 1; i >= 0; i--) {
            int size = all.get(i).text.getBytes(StandardCharsets.UTF_8).length + 1;
            if (used + size > maxBytes) {
                break;
            }
            used += size;
            kept.addFirst(all.get(i));
        }
        return new ArrayList<>(kept);
    }

    /**
     * Copies stored lines with {@code wallMs} in [fromWallMs, toWallMs] into {@code destination}
     * (tmp file, fsync, atomic rename), keeping the newest lines when the copy would pass
     * {@code maxBytes}. Never removes or alters anything in the store, and is not affected by
     * appends or pruning that happen after the lines were read.
     *
     * <p>The copy uses the store's line format
     * ({@code wallMs \t generation \t positionHex \t text}).
     *
     * @throws UncheckedIOException when the copy could not be written; the destination is then
     *     unchanged
     */
    public Frozen freeze(File destination, long fromWallMs, long toWallMs, int maxBytes) {
        List<String> rows = new ArrayList<>();
        List<Long> walls = new ArrayList<>();
        synchronized (this) {
            for (File segment : segments()) {
                for (String row : readRows(segment)) {
                    Line line = parse(row);
                    if (line != null && line.wallMs >= fromWallMs && line.wallMs <= toWallMs) {
                        rows.add(row);
                        walls.add(line.wallMs);
                    }
                }
            }
        }

        int first = rows.size();
        long used = 0;
        for (int i = rows.size() - 1; i >= 0; i--) {
            long size = rows.get(i).getBytes(StandardCharsets.UTF_8).length + 1L;
            if (used + size > maxBytes) {
                break;
            }
            used += size;
            first = i;
        }
        boolean truncated = first > 0;

        long firstWall = 0;
        long lastWall = 0;
        int gaps = 0;
        StringBuilder text = new StringBuilder();
        for (int i = first; i < rows.size(); i++) {
            long wall = walls.get(i);
            firstWall = i == first ? wall : Math.min(firstWall, wall);
            lastWall = i == first ? wall : Math.max(lastWall, wall);
            String row = rows.get(i);
            if (isMarker(row.split("\t", 4)[3], GAP_PREFIX)) {
                gaps++;
            }
            text.append(row).append('\n');
        }
        byte[] bytes = text.toString().getBytes(StandardCharsets.UTF_8);

        File parent = destination.getAbsoluteFile().getParentFile();
        if (parent != null) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        File tmp = new File(parent, destination.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
            out.flush();
            mSyncer.sync(out);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new UncheckedIOException("freeze: cannot write " + tmp, e);
        }
        if (!tmp.renameTo(destination)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new UncheckedIOException("freeze: cannot rename to " + destination,
                    new IOException("rename failed"));
        }
        return new Frozen(rows.size() - first, bytes.length, firstWall, lastWall, gaps, truncated);
    }

    /** {@code glasses_firmware} artifact entries in the backend incident log shape. */
    public static JSONArray toEntries(List<Line> lines) {
        JSONArray entries = new JSONArray();
        for (Line line : lines) {
            try {
                JSONObject entry = new JSONObject();
                entry.put("timestamp", line.wallMs);
                entry.put("level", "debug");
                entry.put("message", line.text);
                entry.put("source", "BES");
                entries.put(entry);
            } catch (Exception ignored) {
                // Keep the rest of the artifact.
            }
        }
        return entries;
    }

    public synchronized long totalBytes() {
        long total = 0;
        for (File segment : segments()) {
            total += segment.length();
        }
        return total;
    }

    // ---------------------------------------------------------------------------------------
    // Persistence cost measurement
    // ---------------------------------------------------------------------------------------

    /**
     * Turns the retry duplicate filter on (BesTraceTail does) or off (the default, so callers that
     * append synthetic lines with repeating positions are unaffected).
     */
    public synchronized void setDuplicateGuard(boolean enabled) {
        mDuplicateGuard = enabled;
        mNeedsRecovery = true;
    }

    /** Counts one durable commit that covered {@code batches} advancing batches. */
    public synchronized void recordCommit(int batches) {
        mWindow.commits++;
        mWindow.commitBatches += batches;
    }

    /** Aggregates since the process started as one [ASG-BES-STORE] line; for the debug dump. */
    public synchronized String statsSummary() {
        Aggregate all = new Aggregate();
        all.add(mTotal);
        all.add(mWindow);
        long window = mWindowStartMs < 0 ? 0 : mClock.nowMs() - mWindowStartMs;
        return all.format(window + mTotalWindowMs, "total");
    }

    public synchronized void setStatsSink(StatsSink sink) {
        mStatsSink = sink != null ? sink : line -> { };
    }

    public synchronized void setStatsIntervalMs(long intervalMs) {
        mStatsIntervalMs = intervalMs;
    }

    synchronized void setNanoClockForTest(LongSupplier clock) {
        mNanoClock = clock;
    }

    private long mTotalWindowMs;

    private void maybeEmitStats() {
        long now = mClock.nowMs();
        if (mWindowStartMs < 0) {
            mWindowStartMs = now;
            return;
        }
        long elapsed = now - mWindowStartMs;
        if (elapsed < mStatsIntervalMs || mWindow.isEmpty()) {
            return;
        }
        mStatsSink.log(mWindow.format(elapsed, "window"));
        mTotal.add(mWindow);
        mTotalWindowMs += elapsed;
        mWindow = new Aggregate();
        mWindowStartMs = now;
    }

    /** Per-window persistence cost, never logged per batch. */
    private static final class Aggregate {
        long batches;
        long lines;
        long bytes;
        long appendNs;
        long appendMaxNs;
        long logSyncs;
        long logSyncNs;
        long logSyncMaxNs;
        long cursorSaves;
        long cursorNs;
        long cursorMaxNs;
        long commits;
        long commitBatches;
        long dupSkipped;
        long failures;

        boolean isEmpty() {
            return batches == 0 && commits == 0 && logSyncs == 0 && cursorSaves == 0
                    && failures == 0 && dupSkipped == 0;
        }

        void recordAppend(int appendedLines, int appendedBytes, long ns) {
            batches++;
            lines += appendedLines;
            bytes += appendedBytes;
            appendNs += ns;
            appendMaxNs = Math.max(appendMaxNs, ns);
        }

        void recordLogSync(long ns) {
            logSyncs++;
            logSyncNs += ns;
            logSyncMaxNs = Math.max(logSyncMaxNs, ns);
        }

        void recordCursor(long ns) {
            cursorSaves++;
            cursorNs += ns;
            cursorMaxNs = Math.max(cursorMaxNs, ns);
        }

        void add(Aggregate o) {
            batches += o.batches;
            lines += o.lines;
            bytes += o.bytes;
            appendNs += o.appendNs;
            appendMaxNs = Math.max(appendMaxNs, o.appendMaxNs);
            logSyncs += o.logSyncs;
            logSyncNs += o.logSyncNs;
            logSyncMaxNs = Math.max(logSyncMaxNs, o.logSyncMaxNs);
            cursorSaves += o.cursorSaves;
            cursorNs += o.cursorNs;
            cursorMaxNs = Math.max(cursorMaxNs, o.cursorMaxNs);
            commits += o.commits;
            commitBatches += o.commitBatches;
            dupSkipped += o.dupSkipped;
            failures += o.failures;
        }

        private static String ms(long totalNs, long count, long maxNs) {
            double avg = count == 0 ? 0 : totalNs / 1e6 / count;
            return String.format(Locale.US, "%.2f/%.2f", avg, maxNs / 1e6);
        }

        String format(long windowMs, String scope) {
            double persistPerBatch = batches == 0 ? 0
                    : (appendNs + logSyncNs + cursorNs) / 1e6 / batches;
            double batchesPerCommit = commits == 0 ? 0 : (double) commitBatches / commits;
            return String.format(Locale.US,
                    "%s scope=%s ms=%d batches=%d lines=%d bytes=%d append_ms(avg/max)=%s "
                            + "log_syncs=%d log_sync_ms(avg/max)=%s cursor_saves=%d "
                            + "cursor_ms(avg/max)=%s persist_ms_per_batch=%.2f commits=%d "
                            + "batches_per_commit=%.2f dup_skipped=%d fail=%d",
                    STORE_STATS_PREFIX, scope, windowMs, batches, lines, bytes,
                    ms(appendNs, batches, appendMaxNs), logSyncs,
                    ms(logSyncNs, logSyncs, logSyncMaxNs), cursorSaves,
                    ms(cursorNs, cursorSaves, cursorMaxNs), persistPerBatch, commits,
                    batchesPerCommit, dupSkipped, failures);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Duplicate filter
    // ---------------------------------------------------------------------------------------

    /**
     * Drops what a retry of an unacknowledged batch would store twice. Positions are monotonic
     * per (bid, generation); a REBOOT or GAP marker is matched by its exact key.
     */
    private static final class Dedup {
        boolean known;
        String bid;
        long generation;
        long lastDataPos = -1;
        String rebootKey;
        String gapKey;

        Dedup copy() {
            Dedup d = new Dedup();
            d.known = known;
            d.bid = bid;
            d.generation = generation;
            d.lastDataPos = lastDataPos;
            d.rebootKey = rebootKey;
            d.gapKey = gapKey;
            return d;
        }

        private boolean sameBoot(Line line) {
            if (!known || line.generation != generation) {
                return false;
            }
            if (UNKNOWN_BID.equals(bid)) {
                return line.bid == null;
            }
            return bid == null ? line.bid == null : bid.equals(line.bid);
        }

        /** True when the line must be stored; updates the state for stored lines. */
        boolean accept(Line line) {
            String key = line.position + "|" + line.text;
            if (isMarker(line.text, REBOOT_PREFIX)) {
                if (key.equals(rebootKey)) {
                    return false;
                }
                rebootKey = key;
                gapKey = null;
                return true;
            }
            if (isMarker(line.text, GAP_PREFIX)) {
                if ((sameBoot(line) && line.position <= lastDataPos) || key.equals(gapKey)) {
                    return false;
                }
                gapKey = key;
                return true;
            }
            if (line.text.startsWith(MARKER_PREFIX)) {
                return true; // Status and other ASG markers are not replays of BES bytes.
            }
            if (sameBoot(line) && line.position <= lastDataPos) {
                return false;
            }
            if (!sameBoot(line)) {
                known = true;
                bid = line.bid;
                generation = line.generation;
                gapKey = null;
            }
            lastDataPos = line.position;
            return true;
        }
    }

    private static boolean isMarker(String text, String prefix) {
        return text.startsWith(prefix);
    }

    /** Rebuilds the duplicate filter from what is on disk (start-up, or after a failed write). */
    private void recoverIfNeeded() {
        if (!mNeedsRecovery || !mDuplicateGuard) {
            return;
        }
        mNeedsRecovery = false;
        Dedup state = new Dedup();
        Cursor cursor = loadCursorLocked();
        File[] files = segments();

        String lastGapAfterData = null;
        Line lastData = null;
        Line reboot = null;
        boolean dataAfterReboot = false;
        scan:
        for (int s = files.length - 1; s >= 0; s--) {
            List<String> rows = readRows(files[s]);
            for (int i = rows.size() - 1; i >= 0; i--) {
                Line line = parse(rows.get(i));
                if (line == null) {
                    continue;
                }
                if (isMarker(line.text, REBOOT_PREFIX)) {
                    reboot = line;
                    dataAfterReboot = lastData != null;
                    break scan;
                }
                if (line.text.startsWith(MARKER_PREFIX)) {
                    if (lastData == null && lastGapAfterData == null
                            && isMarker(line.text, GAP_PREFIX)) {
                        lastGapAfterData = line.position + "|" + line.text;
                    }
                    continue;
                }
                if (lastData == null) {
                    lastData = line;
                }
            }
        }
        if (reboot != null) {
            state.rebootKey = reboot.position + "|" + reboot.text;
        }
        if (lastData != null) {
            state.known = true;
            state.generation = lastData.generation;
            state.lastDataPos = lastData.position;
            if (reboot != null && dataAfterReboot) {
                state.bid = newBidOf(reboot.text);
            } else if (cursor != null && cursor.generation == lastData.generation) {
                state.bid = cursor.bid;
            } else {
                state.bid = UNKNOWN_BID;
            }
        }
        state.gapKey = lastGapAfterData;
        mDedup = state;
    }

    private static String newBidOf(String rebootText) {
        int at = rebootText.indexOf("new_bid=");
        if (at < 0) {
            return null; // Legacy "generation a -> b" marker: old firmware.
        }
        String value = rebootText.substring(at + "new_bid=".length()).trim();
        int end = value.indexOf(' ');
        if (end >= 0) {
            value = value.substring(0, end);
        }
        return BID.matcher(value).matches() ? value : UNKNOWN_BID;
    }

    // ---------------------------------------------------------------------------------------
    // Segments
    // ---------------------------------------------------------------------------------------

    private File currentSegment(long now, int incoming) {
        boolean rotate = mSegment == null || !mSegment.exists()
                || mSegment.length() + incoming > mSegmentMaxBytes
                || now - mSegmentStartMs >= mSegmentMaxAgeMs;
        if (rotate) {
            mSegmentStartMs = now;
            mSegment = new File(mDir, String.format(Locale.US, "%s%013d-%04d%s",
                    SEGMENT_PREFIX, now, mSequence++ % 10000, SEGMENT_SUFFIX));
        }
        return mSegment;
    }

    private void prune(long now) {
        File[] files = segments();
        long total = 0;
        for (File segment : files) {
            total += segment.length();
        }
        for (File segment : files) {
            boolean current = segment.equals(mSegment);
            boolean expired = segment.lastModified() < now - mRetentionMs;
            if (!current && (expired || total > mMaxBytes)) {
                total -= segment.length();
                mUnsynced.remove(segment);
                //noinspection ResultOfMethodCallIgnored
                segment.delete();
            }
        }
    }

    private File[] segments() {
        File[] files = mDir.listFiles((dir, name) ->
                name.startsWith(SEGMENT_PREFIX) && name.endsWith(SEGMENT_SUFFIX));
        if (files == null) {
            return new File[0];
        }
        Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
        return files;
    }

    /** Complete (newline-terminated) rows of a segment; an interrupted last row is ignored. */
    private static List<String> readRows(File segment) {
        List<String> rows = new ArrayList<>();
        byte[] raw;
        try {
            raw = readAll(segment);
        } catch (IOException e) {
            return rows; // A segment deleted by concurrent pruning simply contributes nothing.
        }
        int start = 0;
        for (int i = 0; i < raw.length; i++) {
            if (raw[i] == '\n') {
                if (i > start) {
                    rows.add(new String(raw, start, i - start, StandardCharsets.UTF_8));
                }
                start = i + 1;
            }
        }
        return rows;
    }

    private static byte[] readAll(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(32, file.length()));
            byte[] buffer = new byte[16 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) {
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }

    private static Line parse(String row) {
        String[] parts = row.split("\t", 4);
        if (parts.length != 4) {
            return null;
        }
        try {
            return new Line(Long.parseLong(parts[0]), Long.parseLong(parts[1]),
                    Long.parseLong(parts[2], 16), parts[3]);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
