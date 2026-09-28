package com.mentra.asg_client.io.bes.log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Rolling on-disk store of BES TRACE lines delivered over mh_rlog, attached to bug reports.
 *
 * <p>Lines are written to segments of at most {@code segmentMaxBytes} or {@code segmentMaxAgeMs};
 * segments whose newest line is older than {@code retentionMs} are deleted, and the oldest
 * segments go first when the total passes {@code maxBytes}. Every append is flushed and synced
 * before {@link #saveCursor} records the BES position it covers, so an acknowledgement sent after
 * {@link #saveCursor} never names data that could still be lost to an ASG restart.
 *
 * <p>Each stored line is {@code wallMs \t generation \t positionHex \t text}.
 */
public final class BesTraceStore {
    /** One BES line (or an ASG marker) with the wall time its BES timestamp maps to. */
    public static final class Line {
        public final long wallMs;
        public final long generation;
        public final long position;
        public final String text;

        public Line(long wallMs, long generation, long position, String text) {
            this.wallMs = wallMs;
            this.generation = generation;
            this.position = position;
            this.text = text;
        }
    }

    /** Last BES position persisted, with its ring generation. */
    public static final class Cursor {
        public final long generation;
        public final long position;

        public Cursor(long generation, long position) {
            this.generation = generation;
            this.position = position;
        }
    }

    public interface Clock {
        long nowMs();
    }

    private static final String SEGMENT_PREFIX = "trace-";
    private static final String SEGMENT_SUFFIX = ".log";
    private static final String CURSOR_FILE = "cursor";

    private final File mDir;
    private final Clock mClock;
    private final long mRetentionMs;
    private final long mMaxBytes;
    private final long mSegmentMaxBytes;
    private final long mSegmentMaxAgeMs;

    private File mSegment;
    private long mSegmentStartMs;
    private int mSequence;

    public BesTraceStore(File dir, Clock clock, long retentionMs, long maxBytes,
                         long segmentMaxBytes, long segmentMaxAgeMs) {
        mDir = dir;
        mClock = clock;
        mRetentionMs = retentionMs;
        mMaxBytes = maxBytes;
        mSegmentMaxBytes = segmentMaxBytes;
        mSegmentMaxAgeMs = segmentMaxAgeMs;
        //noinspection ResultOfMethodCallIgnored
        mDir.mkdirs();
    }

    /** Append and sync; returns false when the disk write failed (nothing may be acknowledged). */
    public synchronized boolean append(List<Line> lines) {
        if (lines.isEmpty()) {
            return true;
        }
        long now = mClock.nowMs();
        StringBuilder text = new StringBuilder();
        for (Line line : lines) {
            text.append(line.wallMs).append('\t')
                    .append(line.generation).append('\t')
                    .append(Long.toHexString(line.position)).append('\t')
                    .append(line.text.replace('\n', ' ').replace('\r', ' '))
                    .append('\n');
        }
        byte[] bytes = text.toString().getBytes(StandardCharsets.UTF_8);
        File segment = currentSegment(now, bytes.length);
        try (FileOutputStream out = new FileOutputStream(segment, true)) {
            out.write(bytes);
            out.flush();
            out.getFD().sync();
        } catch (IOException e) {
            return false;
        }
        prune(now);
        return true;
    }

    public synchronized boolean saveCursor(Cursor cursor) {
        File tmp = new File(mDir, CURSOR_FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write((cursor.generation + " " + cursor.position + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        } catch (IOException e) {
            return false;
        }
        return tmp.renameTo(new File(mDir, CURSOR_FILE));
    }

    /** The persisted cursor, or null when none was saved yet. */
    public synchronized Cursor loadCursor() {
        File file = new File(mDir, CURSOR_FILE);
        if (!file.exists()) {
            return null;
        }
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String[] parts = reader.readLine().trim().split(" ");
            return new Cursor(Long.parseLong(parts[0]), Long.parseLong(parts[1]));
        } catch (Exception e) {
            return null;
        }
    }

    /** Lines no older than {@code windowMs}, oldest first. */
    public synchronized List<Line> readSince(long windowMs) {
        long oldest = mClock.nowMs() - windowMs;
        List<Line> out = new ArrayList<>();
        for (File segment : segments()) {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(new FileInputStream(segment), StandardCharsets.UTF_8))) {
                String row;
                while ((row = reader.readLine()) != null) {
                    Line line = parse(row);
                    if (line != null && line.wallMs >= oldest) {
                        out.add(line);
                    }
                }
            } catch (IOException ignored) {
                // A segment deleted by concurrent pruning simply contributes nothing.
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

    private File currentSegment(long now, int incoming) {
        boolean rotate = mSegment == null || !mSegment.exists()
                || mSegment.length() + incoming > mSegmentMaxBytes
                || now - mSegmentStartMs >= mSegmentMaxAgeMs;
        if (rotate) {
            mSegmentStartMs = now;
            mSegment = new File(mDir, String.format(java.util.Locale.US, "%s%013d-%04d%s",
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
