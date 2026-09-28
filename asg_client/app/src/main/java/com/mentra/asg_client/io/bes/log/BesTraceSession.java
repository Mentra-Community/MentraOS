package com.mentra.asg_client.io.bes.log;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Cursor and parsing for the BES {@code hm_rlog} reply. No Android dependencies.
 *
 * <p>Positions count bytes ever written to the BES TRACE ring. A read is side-effect free on the
 * BES, so the session only advances after the caller has persisted the lines, and only to the end
 * of the last complete line: a partial line is re-read next time instead of being split.
 *
 * <p>BES line prefixes use the uncalibrated TRACE clock; each reply carries both that clock
 * ({@code tp}) and calibrated milliseconds ({@code t}), so lines delivered in a batch after a
 * wake keep the time they were written rather than the time they arrived.
 */
public final class BesTraceSession {
    /** Observed TRACE-prefix clock / calibrated ms on bpone until a measurement replaces it. */
    static final double DEFAULT_PREFIX_RATE = 1.048576;
    private static final long MIN_RATE_SPAN_MS = 60_000;
    private static final int FULL_READ_BYTES = 300;
    private static final Pattern PREFIX = Pattern.compile("^\\s*(\\d{1,10})/");

    /** What one reply produced. */
    public static final class Reply {
        public final boolean valid;
        public final String error;
        public final long generation;
        public final long start;
        public final long end;
        public final long commit;
        public final long lost;
        /** Position to acknowledge once {@link #lines} are persisted. */
        public final long ackPosition;
        public final List<BesTraceStore.Line> lines;

        Reply(String error) {
            this.valid = false;
            this.error = error;
            this.generation = this.start = this.end = this.commit = this.lost = this.ackPosition = 0;
            this.lines = new ArrayList<>();
        }

        Reply(long generation, long start, long end, long commit, long lost, long ackPosition,
              List<BesTraceStore.Line> lines) {
            this.valid = true;
            this.error = null;
            this.generation = generation;
            this.start = start;
            this.end = end;
            this.commit = commit;
            this.lost = lost;
            this.ackPosition = ackPosition;
            this.lines = lines;
        }

        /** Bytes still waiting on the BES after this reply is acknowledged. */
        public long backlog() {
            return Math.max(0, end - ackPosition);
        }
    }

    private boolean mHaveCursor;
    private long mGeneration;
    private long mPosition;
    private long mRateT0 = -1;
    private long mRateTp0;
    private double mPrefixRate = DEFAULT_PREFIX_RATE;

    public BesTraceSession() {}

    public BesTraceSession(BesTraceStore.Cursor cursor) {
        if (cursor != null) {
            mHaveCursor = true;
            mGeneration = cursor.generation;
            mPosition = cursor.position;
        }
    }

    /** mh_rlog body. Generation 0 asks the BES to resume from its own commit. */
    public String requestBody() {
        return cursorBody(mHaveCursor ? mGeneration : 0, mPosition);
    }

    public static String cursorBody(long generation, long position) {
        return "{\"g\":" + generation + ",\"p\":\"" + String.format(Locale.US, "%016x", position) + "\"}";
    }

    public boolean hasCursor() {
        return mHaveCursor;
    }

    public long generation() {
        return mGeneration;
    }

    public long position() {
        return mPosition;
    }

    double prefixRate() {
        return mPrefixRate;
    }

    /** Parse an hm_rlog body received at {@code receivedWallMs}. Does not move the cursor. */
    public Reply parse(JSONObject body, long receivedWallMs) {
        if (body == null) {
            return new Reply("no_body");
        }
        if (body.has("error")) {
            return new Reply(body.optString("error", "error"));
        }
        long generation = body.optLong("g", 0);
        Long start = hex(body.optString("p", null));
        Long end = hex(body.optString("e", null));
        Long commit = hex(body.optString("c", null));
        Long lost = hex(body.optString("l", null));
        if (generation == 0 || start == null || end == null || commit == null || lost == null
                || start > end) {
            return new Reply("invalid_reply");
        }
        String data = body.optString("d", "");
        long rawCount = body.optLong("n", data.getBytes(StandardCharsets.UTF_8).length);
        long t = body.optLong("t", 0);
        long tp = body.optLong("tp", 0);
        updateRate(t, tp);

        List<BesTraceStore.Line> lines = new ArrayList<>();
        if (mHaveCursor && generation != mGeneration) {
            lines.add(new BesTraceStore.Line(receivedWallMs, generation, start, String.format(
                    Locale.US, "[ASG-BES-REBOOT] generation %d -> %d", mGeneration, generation)));
        }
        if (lost > 0) {
            lines.add(new BesTraceStore.Line(receivedWallMs, generation, start, String.format(
                    Locale.US, "[ASG-BES-GAP] lost=%d bytes before position %x", lost, start)));
        }

        byte[] raw = data.getBytes(StandardCharsets.UTF_8);
        int complete = lastNewline(raw) + 1;
        if (complete == 0 && raw.length >= FULL_READ_BYTES) {
            complete = raw.length; // One full read without a newline cannot be a TRACE line tail.
        }
        long consumed = complete == raw.length ? rawCount : complete;
        long previousWall = receivedWallMs;
        long position = start;
        int lineStart = 0;
        for (int i = 0; i < complete; i++) {
            if (raw[i] != '\n' && i != complete - 1) {
                continue;
            }
            int lineEnd = raw[i] == '\n' ? i : i + 1;
            String text = new String(raw, lineStart, lineEnd - lineStart, StandardCharsets.UTF_8)
                    .replace("\r", "");
            if (!text.trim().isEmpty()) {
                previousWall = wallTime(text, tp, receivedWallMs, previousWall);
                lines.add(new BesTraceStore.Line(previousWall, generation, position, text));
            }
            position = start + i + 1;
            lineStart = i + 1;
        }
        return new Reply(generation, start, end, commit, lost, start + consumed, lines);
    }

    /** Record that everything before {@code position} is persisted. */
    public void commit(long generation, long position) {
        mHaveCursor = true;
        mGeneration = generation;
        mPosition = position;
    }

    private void updateRate(long t, long tp) {
        if (t <= 0 || tp <= 0) {
            return;
        }
        if (mRateT0 < 0 || t < mRateT0 || tp < mRateTp0) {
            mRateT0 = t;
            mRateTp0 = tp;
            return;
        }
        long span = t - mRateT0;
        if (span >= MIN_RATE_SPAN_MS) {
            double rate = (double) (tp - mRateTp0) / span;
            if (rate > 0.8 && rate < 1.3) {
                mPrefixRate = rate;
            }
        }
    }

    private long wallTime(String text, long tp, long receivedWallMs, long fallback) {
        Matcher matcher = PREFIX.matcher(text);
        if (!matcher.find() || tp <= 0) {
            return fallback;
        }
        long prefix;
        try {
            prefix = Long.parseLong(matcher.group(1));
        } catch (NumberFormatException e) {
            return fallback;
        }
        long ageTraceMs = tp - prefix;
        if (ageTraceMs < 0 || ageTraceMs > 24L * 3600 * 1000) {
            return fallback;
        }
        return receivedWallMs - Math.round(ageTraceMs / mPrefixRate);
    }

    private static int lastNewline(byte[] raw) {
        for (int i = raw.length - 1; i >= 0; i--) {
            if (raw[i] == '\n') {
                return i;
            }
        }
        return -1;
    }

    private static Long hex(String text) {
        if (text == null || text.length() != 16) {
            return null;
        }
        try {
            return Long.parseUnsignedLong(text, 16);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
