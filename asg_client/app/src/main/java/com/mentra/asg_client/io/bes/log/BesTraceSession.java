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
    private static final Pattern BID = Pattern.compile("[0-9a-f]{16}");

    /** What one reply produced. */
    public static final class Reply {
        public final boolean valid;
        public final String error;
        /** BES boot id of the reply, or null for firmware that does not send one. */
        public final String bid;
        public final long generation;
        public final long start;
        public final long end;
        public final long commit;
        public final long lost;
        /** Position to acknowledge once {@link #lines} are persisted. */
        public final long ackPosition;
        public final List<BesTraceStore.Line> lines;
        /** Wall time of the newest line (markers included) in {@link #lines}; 0 when none. */
        public final long lastWallMs;

        Reply(String error) {
            this.valid = false;
            this.error = error;
            this.bid = null;
            this.generation = this.start = this.end = this.commit = this.lost = this.ackPosition = 0;
            this.lines = new ArrayList<>();
            this.lastWallMs = 0;
        }

        Reply(String bid, long generation, long start, long end, long commit, long lost,
              long ackPosition, List<BesTraceStore.Line> lines, long lastWallMs) {
            this.valid = true;
            this.error = null;
            this.bid = bid;
            this.generation = generation;
            this.start = start;
            this.end = end;
            this.commit = commit;
            this.lost = lost;
            this.ackPosition = ackPosition;
            this.lines = lines;
            this.lastWallMs = lastWallMs;
        }

        /** Bytes still waiting on the BES after this reply is acknowledged. */
        public long backlog() {
            return Math.max(0, end - ackPosition);
        }
    }

    /**
     * Newest wall time written to the store (never rolled back: the lines are on disk even when
     * the cursor is not). New lines are never stamped earlier, so stored order is time order.
     */
    private long mFloorWallMs;
    /** The read cursor: where the next mh_rlog asks from. */
    private boolean mHaveCursor;
    private String mBid;
    private long mGeneration;
    private long mPosition;
    /** The durable cursor: what is synced and saved, and so what may be acknowledged. */
    private boolean mDurableHave;
    private String mDurableBid;
    private long mDurableGeneration;
    private long mDurablePosition;
    private long mRateT0 = -1;
    private long mRateTp0;
    private double mPrefixRate = DEFAULT_PREFIX_RATE;

    public BesTraceSession() {}

    public BesTraceSession(BesTraceStore.Cursor cursor) {
        if (cursor != null) {
            mHaveCursor = true;
            mBid = cursor.bid;
            mGeneration = cursor.generation;
            mPosition = cursor.position;
            markDurable();
        }
    }

    /**
     * mh_rlog body. Generation 0 asks the BES to resume from its own commit. The boot id is sent
     * when known: a BES that has rebooted since replies from its oldest retained byte.
     */
    public String requestBody() {
        return cursorBody(mBid, mHaveCursor ? mGeneration : 0, mPosition);
    }

    public static String cursorBody(long generation, long position) {
        return cursorBody(null, generation, position);
    }

    /** mh_rlog / mh_rlog_ack body; {@code bid} is omitted for firmware that has none. */
    public static String cursorBody(String bid, long generation, long position) {
        return "{\"g\":" + generation + ",\"p\":\"" + String.format(Locale.US, "%016x", position)
                + "\"" + (bid != null ? ",\"bid\":\"" + bid + "\"" : "") + "}";
    }

    /** The boot id in an hm_rlog / hm_rlog_ack / hm_rlog_ready / hm_rlog_sub body, or null. */
    public static String parseBid(JSONObject body) {
        if (body == null) {
            return null;
        }
        String bid = body.optString("bid", null);
        return bid != null && BID.matcher(bid).matches() && !bid.equals("0000000000000000")
                ? bid : null;
    }

    /** The BES boot the read cursor belongs to, or null (old firmware, or no reply seen yet). */
    public String bid() {
        return mBid;
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
        String bid = parseBid(body);
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

        String reboot = null;
        if (mHaveCursor) {
            if (bid != null && mBid != null) {
                if (!bid.equals(mBid)) {
                    reboot = String.format(Locale.US, "[ASG-BES-REBOOT] old_bid=%s new_bid=%s",
                            mBid, bid);
                }
            } else if (bid != null) {
                // Cursor from before the firmware had boot ids: a changed generation still is a boot.
                if (generation != mGeneration) {
                    reboot = String.format(Locale.US, "[ASG-BES-REBOOT] old_bid=none new_bid=%s", bid);
                }
            } else if (generation != mGeneration) {
                reboot = String.format(Locale.US, "[ASG-BES-REBOOT] generation %d -> %d",
                        mGeneration, generation);
            }
        }

        // Split the delivered bytes into lines first: the time of a line without a usable BES
        // prefix (the fragment after a gap, a continuation) comes from its neighbours, and a
        // marker takes the time of the data it describes.
        byte[] raw = data.getBytes(StandardCharsets.UTF_8);
        int complete = lastNewline(raw) + 1;
        if (complete == 0 && raw.length >= FULL_READ_BYTES) {
            complete = raw.length; // One full read without a newline cannot be a TRACE line tail.
        }
        long consumed = complete == raw.length ? rawCount : complete;
        List<String> texts = new ArrayList<>();
        List<Long> positions = new ArrayList<>();
        List<Long> stamps = new ArrayList<>(); // -1 = no usable prefix
        long position = start;
        int lineStart = 0;
        long firstStamp = -1;
        for (int i = 0; i < complete; i++) {
            if (raw[i] != '\n' && i != complete - 1) {
                continue;
            }
            int lineEnd = raw[i] == '\n' ? i : i + 1;
            String text = new String(raw, lineStart, lineEnd - lineStart, StandardCharsets.UTF_8)
                    .replace("\r", "");
            if (!text.trim().isEmpty()) {
                long stamp = wallTime(text, tp, receivedWallMs);
                if (stamp >= 0 && firstStamp < 0) {
                    firstStamp = stamp;
                }
                texts.add(text);
                positions.add(position);
                stamps.add(stamp);
            }
            position = start + i + 1;
            lineStart = i + 1;
        }

        long floor = effectiveFloor(receivedWallMs);
        boolean continuous = lost == 0 && reboot == null;
        long running;
        if (continuous && floor > 0) {
            running = floor; // The first bytes continue the line stored before.
        } else if (firstStamp >= 0) {
            running = firstStamp; // After a gap or a reboot: the data that follows sets the time.
        } else {
            running = floor > 0 ? floor : receivedWallMs;
        }
        running = Math.max(running, floor);

        List<BesTraceStore.Line> lines = new ArrayList<>();
        List<BesTraceStore.Line> dataLines = new ArrayList<>();
        for (int i = 0; i < texts.size(); i++) {
            long stamp = stamps.get(i);
            running = Math.max(running, stamp >= 0 ? stamp : running);
            dataLines.add(new BesTraceStore.Line(running, generation, positions.get(i), texts.get(i), bid));
        }
        // A marker is never later than the first line after it and never earlier than the last
        // line stored before it. With no line after it, it sits at the last stored time.
        long markerWall = !dataLines.isEmpty() ? dataLines.get(0).wallMs
                : floor > 0 ? floor : receivedWallMs;
        if (reboot != null) {
            lines.add(new BesTraceStore.Line(markerWall, generation, start, reboot, bid));
        }
        if (lost > 0) {
            lines.add(new BesTraceStore.Line(markerWall, generation, start, String.format(
                    Locale.US, "[ASG-BES-GAP] lost=%d bytes before position %x", lost, start), bid));
        }
        lines.addAll(dataLines);
        long lastWall = lines.isEmpty() ? 0 : lines.get(lines.size() - 1).wallMs;
        return new Reply(bid, generation, start, end, commit, lost, start + consumed, lines,
                lastWall);
    }

    /** Record that everything before {@code position} is persisted (old firmware, no boot id). */
    public void commit(long generation, long position) {
        commit(null, generation, position);
    }

    /** Record that everything before {@code position} of boot {@code bid} is persisted. */
    public void commit(String bid, long generation, long position) {
        advance(bid, generation, position);
        markDurable();
    }

    /**
     * Move the read cursor past lines that were appended but not yet synced. The next request
     * continues from here; nothing may be acknowledged until {@link #markDurable}.
     */
    public void advance(String bid, long generation, long position) {
        mHaveCursor = true;
        mBid = bid;
        mGeneration = generation;
        mPosition = position;
    }

    /** The read cursor is synced and saved: it may be acknowledged. */
    public void markDurable() {
        mDurableHave = mHaveCursor;
        mDurableBid = mBid;
        mDurableGeneration = mGeneration;
        mDurablePosition = mPosition;
    }

    /** Persisting failed: the next request re-reads from the last durable cursor. */
    public void rollbackToDurable() {
        mHaveCursor = mDurableHave;
        mBid = mDurableBid;
        mGeneration = mDurableGeneration;
        mPosition = mDurablePosition;
    }

    /** True when the read cursor is ahead of the durable cursor. */
    public boolean hasUndurableAdvance() {
        return mHaveCursor && (!mDurableHave || mPosition != mDurablePosition
                || mGeneration != mDurableGeneration
                || (mBid == null ? mDurableBid != null : !mBid.equals(mDurableBid)));
    }

    /** The durable cursor for saving and acknowledging (read cursor when nothing is pending). */
    public BesTraceStore.Cursor durableCursor() {
        return new BesTraceStore.Cursor(mDurableBid, mDurableGeneration, mDurablePosition);
    }

    /** The read cursor, the one that becomes durable at the next commit. */
    public BesTraceStore.Cursor readCursor() {
        return new BesTraceStore.Cursor(mBid, mGeneration, mPosition);
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

    /** Wall time from the line's BES prefix, or -1 when it has no usable one. */
    private long wallTime(String text, long tp, long receivedWallMs) {
        Matcher matcher = PREFIX.matcher(text);
        if (!matcher.find() || tp <= 0) {
            return -1;
        }
        long prefix;
        try {
            prefix = Long.parseLong(matcher.group(1));
        } catch (NumberFormatException e) {
            return -1;
        }
        long ageTraceMs = tp - prefix;
        if (ageTraceMs < 0 || ageTraceMs > 24L * 3600 * 1000) {
            return -1;
        }
        return receivedWallMs - Math.round(ageTraceMs / mPrefixRate);
    }

    /** A wall clock that went back by more than this resets the ordering floor. */
    static final long CLOCK_STEP_BACK_MS = 60_000;

    private long effectiveFloor(long receivedWallMs) {
        return mFloorWallMs > receivedWallMs + CLOCK_STEP_BACK_MS ? 0 : mFloorWallMs;
    }

    /**
     * The lines of a reply were written to the store: later lines are never stamped earlier than
     * {@code lastWallMs}. Call after a successful append, whether or not the cursor then moves.
     */
    public void noteStored(long lastWallMs) {
        if (lastWallMs <= 0) {
            return;
        }
        mFloorWallMs = mFloorWallMs > lastWallMs + CLOCK_STEP_BACK_MS
                ? lastWallMs : Math.max(mFloorWallMs, lastWallMs);
    }

    /** Start-up: the newest wall time already in the store. */
    public void seedFloor(long newestStoredWallMs) {
        mFloorWallMs = Math.max(mFloorWallMs, newestStoredWallMs);
    }

    /**
     * The wall time for an ASG line that must sort with the stored lines (the status line of a
     * hm_rlog_ready): the newest stored time, or {@code receivedWallMs} when none is known.
     */
    public long sortableWall(long receivedWallMs) {
        long floor = effectiveFloor(receivedWallMs);
        return floor > 0 ? floor : receivedWallMs;
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
