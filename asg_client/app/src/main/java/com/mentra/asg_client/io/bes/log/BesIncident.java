package com.mentra.asg_client.io.bes.log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Names, validators and parsers for the OS-1988 incident record (contract sections 1, 3, 4, 7). */
public final class BesIncident {
    private BesIncident() {}

    public static final String STATE_COLLECTING = "COLLECTING";
    public static final String STATE_STORED = "STORED";
    public static final String STATE_REPORTED = "REPORTED";
    public static final String STATE_UPLOADED = "UPLOADED";
    public static final String STATE_EVICTED = "EVICTED";

    public static final String KIND_DUMP = "dump";
    public static final String KIND_RESET = "reset";
    public static final String REASON_CRASH = "bes_crash";
    public static final String REASON_RESET = "bes_unexpected_reset";

    public static final String ATTR_MATCH = "match";
    public static final String ATTR_OLDER = "older";
    public static final String ATTR_UNKNOWN = "unknown";

    public static final String ARTIFACT_FULL = "glasses_firmware:full";
    public static final String ARTIFACT_RELAY = "glasses_firmware:relay";

    public static final String FILE_RECORD = "incident.json";
    public static final String FILE_DUMP = "dump.txt";
    public static final String FILE_DUMP_PARTIAL = "dump.partial";
    public static final String FILE_TRACE = "trace.txt";
    public static final String FILE_UPLOAD_FULL = "upload-full.json";
    public static final String FILE_UPLOAD_RELAY = "upload-relay.json";

    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9._:-]{1,128}$");
    private static final Pattern BOOT_ID = Pattern.compile("^[0-9a-f]{16}$");
    private static final Pattern DUMP_ID = Pattern.compile("^([0-9a-f]{8})-([0-9a-f]{8})$");
    private static final Pattern FIELD = Pattern.compile("(\\w+)=(\\S+)");
    private static final Pattern HEADER = Pattern.compile(
            "^\\[CRASH-DUMP\\] v=1 dump_id=(\\S+) len=(\\d+) crc=([0-9a-f]{8})$");
    private static final Pattern TRUNCATED = Pattern.compile(
            "^\\[CRASH-TRUNCATED\\] sent=(\\d+) total=(\\d+) crc=([0-9a-f]{8})$");

    private static final long MIN_VALID_UNIX_MS = 1_577_836_800_000L;
    private static final long MAX_VALID_UNIX_MS = 4_102_466_400_000L;
    private static final long MAX_CLOCK_AGE_MS = 6L * 60 * 60 * 1000;

    public static boolean isValidKey(String key) {
        return key != null && KEY.matcher(key).matches() && !key.equals(".") && !key.equals("..");
    }

    /** 16 lowercase hex chars, not all zero (contract section 1). */
    public static boolean isBootId(String value) {
        return value != null && BOOT_ID.matcher(value).matches() && !value.equals("0000000000000000");
    }

    public static boolean isDumpId(String value) {
        return value != null && DUMP_ID.matcher(value).matches();
    }

    /** The 8 hex CRC part of a valid dump id, else null. */
    public static String dumpIdCrc(String dumpId) {
        Matcher m = dumpId == null ? null : DUMP_ID.matcher(dumpId);
        return m != null && m.matches() ? m.group(2) : null;
    }

    /** Replaces every character outside the key alphabet with '_'. */
    public static String sanitizeKeyPart(String raw) {
        return raw == null ? "" : raw.replaceAll("[^A-Za-z0-9._:-]", "_");
    }

    /** Builds {@code <serial>-dump-<dumpId>} or {@code <serial>-reset-<bootId>} within 128 chars. */
    public static String key(String serial, String kind, String id) {
        String suffix = "-" + kind + "-" + id;
        String safeSerial = sanitizeKeyPart(serial);
        int room = 128 - suffix.length();
        if (safeSerial.length() > room) {
            safeSerial = safeSerial.substring(0, Math.max(0, room));
        }
        return safeSerial + suffix;
    }

    /** Parsed {@code [CRASH-DUMP]} header. */
    public static final class DumpHeader {
        public final String dumpId;
        public final long len;
        public final String crcHex;

        DumpHeader(String dumpId, long len, String crcHex) {
            this.dumpId = dumpId;
            this.len = len;
            this.crcHex = crcHex;
        }

        public boolean isNone() {
            return "none".equals(dumpId);
        }
    }

    /** Parses the exactly-one-line header body (a trailing line break is tolerated), else null. */
    public static DumpHeader parseHeader(String body) {
        if (body == null) {
            return null;
        }
        Matcher m = HEADER.matcher(stripLineEnd(body));
        if (!m.matches()) {
            return null;
        }
        try {
            return new DumpHeader(m.group(1), Long.parseLong(m.group(2)), m.group(3));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Parsed {@code [CRASH-TRUNCATED]} trailer. */
    public static final class Trailer {
        public final long sent;
        public final long total;
        public final String crcHex;

        Trailer(long sent, long total, String crcHex) {
            this.sent = sent;
            this.total = total;
            this.crcHex = crcHex;
        }
    }

    public static Trailer parseTrailer(String body) {
        if (body == null) {
            return null;
        }
        Matcher m = TRUNCATED.matcher(stripLineEnd(body));
        if (!m.matches()) {
            return null;
        }
        try {
            return new Trailer(Long.parseLong(m.group(1)), Long.parseLong(m.group(2)), m.group(3));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String stripLineEnd(String body) {
        int end = body.length();
        while (end > 0 && (body.charAt(end - 1) == '\n' || body.charAt(end - 1) == '\r')) {
            end--;
        }
        return body.substring(0, end);
    }

    /** What the incident record needs from the text of a validated dump (contract section 4). */
    public static final class DumpContext {
        public String bootId;       // null for a legacy (v=1) dump
        public Long resetHw;        // null when absent
        public Long resetSw;
        public long crashUnixMs;    // 0 when the BES had no valid clock anchor
        public boolean tailCaptured;
        public boolean tailTruncated;
        public boolean torn;
        public boolean logLost;
    }

    public static DumpContext parseDumpContext(String dumpText) {
        DumpContext ctx = new DumpContext();
        if (dumpText == null) {
            return ctx;
        }
        String contextLine = lineStartingWith(dumpText, "[CRASH-CONTEXT]");
        if (contextLine != null) {
            Matcher m = FIELD.matcher(contextLine);
            long unixMs = 0;
            long clock = 0;
            long ageMs = Long.MAX_VALUE;
            while (m.find()) {
                String name = m.group(1);
                String value = m.group(2);
                try {
                    switch (name) {
                        case "boot_id":
                            ctx.bootId = isBootId(value) ? value : null;
                            break;
                        case "reset_hw":
                            ctx.resetHw = parseHex(value);
                            break;
                        case "reset_sw":
                            ctx.resetSw = parseHex(value);
                            break;
                        case "unix_ms":
                            unixMs = Long.parseLong(value);
                            break;
                        case "clock":
                            clock = Long.parseLong(value);
                            break;
                        case "age_ms":
                            ageMs = Long.parseLong(value);
                            break;
                        default:
                            break;
                    }
                } catch (NumberFormatException ignored) {
                    // A malformed field is treated as absent.
                }
            }
            if ((clock == 1 || clock == 2) && unixMs >= MIN_VALID_UNIX_MS
                    && unixMs < MAX_VALID_UNIX_MS && ageMs <= MAX_CLOCK_AGE_MS) {
                ctx.crashUnixMs = unixMs;
            }
        }
        String tailLine = lineStartingWith(dumpText, "[CRASH-TAIL]");
        if (tailLine != null) {
            Matcher m = FIELD.matcher(tailLine);
            long captured = 0;
            while (m.find()) {
                String value = m.group(2);
                switch (m.group(1)) {
                    case "captured":
                        try {
                            captured = Long.parseLong(value);
                        } catch (NumberFormatException ignored) {
                            captured = 0;
                        }
                        break;
                    case "truncated":
                        ctx.tailTruncated = "1".equals(value);
                        break;
                    case "torn":
                        ctx.torn = "1".equals(value);
                        break;
                    default:
                        break;
                }
            }
            ctx.tailCaptured = captured > 0;
        }
        ctx.logLost = dumpText.contains("[LOG-LOST]");
        return ctx;
    }

    private static Long parseHex(String value) {
        String v = value.startsWith("0x") || value.startsWith("0X") ? value.substring(2) : value;
        return Long.parseLong(v, 16);
    }

    private static String lineStartingWith(String text, String prefix) {
        int idx = 0;
        while (idx <= text.length()) {
            int end = text.indexOf('\n', idx);
            if (end < 0) {
                end = text.length();
            }
            if (text.startsWith(prefix, idx)) {
                return text.substring(idx, end);
            }
            if (end >= text.length()) {
                break;
            }
            idx = end + 1;
        }
        return null;
    }

    /** Fresh artifacts object with both representations unbuilt. */
    public static JSONObject newArtifacts() {
        try {
            JSONObject artifacts = new JSONObject();
            artifacts.put(ARTIFACT_FULL, newArtifact());
            artifacts.put(ARTIFACT_RELAY, newArtifact());
            return artifacts;
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static JSONObject newArtifact() throws JSONException {
        JSONObject artifact = new JSONObject();
        artifact.put("sha256", JSONObject.NULL);
        artifact.put("bytes", 0);
        artifact.put("attempted", false);
        return artifact;
    }

    public static boolean isArtifactKey(String key) {
        return ARTIFACT_FULL.equals(key) || ARTIFACT_RELAY.equals(key);
    }
}
