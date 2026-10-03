package com.mentra.asg_client.io.bes.log;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.Locale;

/**
 * Bounded in-process ring of BES liveness events that is uploaded alongside the logcat tail.
 *
 * <p>The glasses artifact is only {@code logcat -d -t 600}, and a BES reboot is immediately
 * followed by a BLE re-handshake plus stream teardown that emit thousands of lines. Anything logged
 * about the crash is therefore evicted from that window well before the wearer opens the feedback
 * screen — which is exactly why the first two field reports contained no crash evidence. Keeping
 * these events out of band is what makes them survive to the report.
 */
public final class BesLivenessLog {

    /** Grep marker. Never build this by concatenation — a single grep must be exhaustive. */
    public static final String MARKER = "BES_LIVENESS";

    private static final String TAG = "BesLiveness";
    private static final String SOURCE = "BesLiveness";
    private static final int MAX_ENTRIES = 512;
    private static final int MAX_FIELD_CHARS = 400;

    private static final ArrayDeque<Entry> ENTRIES = new ArrayDeque<>(MAX_ENTRIES);

    private BesLivenessLog() {}

    /** Records a routine observation (uptime, resumed traffic, captured trace lines). */
    public static void info(String event, JSONObject fields) {
        add("info", event, fields);
    }

    /** Records a suspected fault (UART silence, reboot, lost stream controller). */
    public static void warn(String event, JSONObject fields) {
        add("warn", event, fields);
    }

    /**
     * Snapshot of the ring in the {@code {timestamp, level, message, source}} shape the incident
     * logs artifact uses, oldest first.
     */
    public static JSONArray recentEntries() {
        JSONArray out = new JSONArray();
        synchronized (ENTRIES) {
            for (Iterator<Entry> it = ENTRIES.iterator(); it.hasNext(); ) {
                Entry entry = it.next();
                try {
                    JSONObject json = new JSONObject();
                    json.put("timestamp", entry.wallMs);
                    json.put("level", entry.level);
                    json.put("message", entry.message);
                    json.put("source", SOURCE);
                    out.put(json);
                } catch (Exception ignored) {
                    // Keep report assembly non-fatal.
                }
            }
        }
        return out;
    }

    /** Visible for tests. */
    public static void clear() {
        synchronized (ENTRIES) {
            ENTRIES.clear();
        }
    }

    /** Visible for tests. */
    public static int size() {
        synchronized (ENTRIES) {
            return ENTRIES.size();
        }
    }

    private static void add(String level, String event, JSONObject fields) {
        String message = format(event, fields);
        long wallMs = System.currentTimeMillis();

        synchronized (ENTRIES) {
            while (ENTRIES.size() >= MAX_ENTRIES) {
                ENTRIES.pollFirst();
            }
            ENTRIES.addLast(new Entry(wallMs, level, message));
        }

        if ("warn".equals(level)) {
            Log.w(TAG, message);
        } else {
            Log.i(TAG, message);
        }
    }

    private static String format(String event, JSONObject fields) {
        StringBuilder builder = new StringBuilder(MARKER);
        builder.append(" event=").append(event != null ? event : "unknown");
        if (fields != null) {
            for (Iterator<String> keys = fields.keys(); keys.hasNext(); ) {
                String key = keys.next();
                builder.append(' ').append(key).append('=').append(value(fields.opt(key)));
            }
        }
        return builder.toString();
    }

    private static String value(Object raw) {
        String text = raw == null ? "null" : String.valueOf(raw);
        text = text.replace('\n', ' ').replace('\r', ' ');
        if (text.length() > MAX_FIELD_CHARS) {
            text = text.substring(0, MAX_FIELD_CHARS) + "…";
        }
        return text;
    }

    private static final class Entry {
        final long wallMs;
        final String level;
        final String message;

        Entry(long wallMs, String level, String message) {
            this.wallMs = wallMs;
            this.level = level;
            this.message = message;
        }

        @Override
        public String toString() {
            return String.format(Locale.US, "%d %s %s", wallMs, level, message);
        }
    }
}
