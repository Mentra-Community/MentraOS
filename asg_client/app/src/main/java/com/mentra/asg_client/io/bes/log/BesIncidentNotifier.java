package com.mentra.asg_client.io.bes.log;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * Tells the phone about BES incidents (OS-1988 contract section 8): {@code bes_crash_detected}
 * when an incident becomes {@code STORED}, and again on every {@code phone_ready} for every
 * incident that is still {@code STORED} or {@code REPORTED} and not uploaded.
 *
 * <p>All sends go through one lock and one sender (the BLE response path used by the other
 * replies), so they are serialized with each other and ride the transport's own throttling.
 */
public final class BesIncidentNotifier {
    private static final String TAG = "BesIncidentNotifier";
    private static final int MAX_RECENT_EVICTIONS = 16;

    /** Total evicted incidents and the most recent evictions, as in {@code evictions.json}. */
    public static final class EvictionSummary {
        public final long count;
        public final JSONArray recent;

        public EvictionSummary(long count, JSONArray recent) {
            this.count = count;
            this.recent = recent != null ? recent : new JSONArray();
        }
    }

    private static final BesIncidentNotifier SHARED =
            new BesIncidentNotifier(BesIncidentAccessProvider::get);

    private final Supplier<BesIncidentUploadAccess> mAccess;
    private final Object mSendLock = new Object();
    private volatile Predicate<JSONObject> mSender;
    private volatile Supplier<EvictionSummary> mEvictions;

    public BesIncidentNotifier(Supplier<BesIncidentUploadAccess> access) {
        mAccess = access;
    }

    public static BesIncidentNotifier get() {
        return SHARED;
    }

    /** BLE send path; returns whether the transport accepted the message. */
    public void setSender(Predicate<JSONObject> sender) {
        mSender = sender;
    }

    /**
     * Supplier the incident store fills with its eviction ring. Without one, the notifier reads
     * {@code evictions.json} next to the incident bundles.
     */
    public void setEvictionSummarySupplier(Supplier<EvictionSummary> supplier) {
        mEvictions = supplier;
    }

    /** Sends {@code bes_crash_detected} for one incident, when it is pending. */
    public void notifyDetected(String incidentKey) {
        BesIncidentUploadAccess access = mAccess.get();
        if (access == null || incidentKey == null) {
            return;
        }
        try {
            JSONObject record = access.find(incidentKey);
            if (!BesIncidentUploader.isUploadable(record)) {
                return;
            }
            send(record, access, mSender);
        } catch (RuntimeException e) {
            Log.e(TAG, "notifyDetected failed for " + incidentKey, e);
        }
    }

    /** Resends every pending incident over the configured sender. */
    public void resendPending() {
        resendPending(mSender);
    }

    /** Resends every pending incident over {@code sender} (the phone_ready reply path). */
    public void resendPending(Predicate<JSONObject> sender) {
        BesIncidentUploadAccess access = mAccess.get();
        if (access == null) {
            return;
        }
        try {
            List<JSONObject> pending = access.pendingForPhone();
            for (JSONObject record : pending) {
                if (!send(record, access, sender)) {
                    // The link is gone or refused it; the next phone_ready tries again.
                    return;
                }
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "resendPending failed", e);
        }
    }

    private boolean send(JSONObject record, BesIncidentUploadAccess access, Predicate<JSONObject> sender) {
        if (sender == null) {
            Log.w(TAG, "No BLE sender yet; incident stays pending until the next phone_ready");
            return false;
        }
        synchronized (mSendLock) {
            try {
                JSONObject message = buildDetectedMessage(record, evictionSummary(record, access));
                boolean sent = sender.test(message);
                Log.i(TAG, (sent ? "Sent" : "Could not send") + " bes_crash_detected "
                        + record.optString("incidentKey") + " state=" + record.optString("state"));
                return sent;
            } catch (Exception e) {
                Log.e(TAG, "bes_crash_detected failed for " + record.optString("incidentKey"), e);
                return false;
            }
        }
    }

    private EvictionSummary evictionSummary(JSONObject record, BesIncidentUploadAccess access) {
        Supplier<EvictionSummary> supplier = mEvictions;
        if (supplier != null) {
            try {
                EvictionSummary summary = supplier.get();
                if (summary != null) {
                    return summary;
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "Eviction summary supplier failed", e);
            }
        }
        return readEvictionsFile(access.bundleDir(record.optString("incidentKey")));
    }

    private static EvictionSummary readEvictionsFile(File bundleDir) {
        File dir = bundleDir != null ? bundleDir.getParentFile() : null;
        File file = dir != null ? new File(dir, "evictions.json") : null;
        if (file == null || !file.isFile()) {
            return new EvictionSummary(0, new JSONArray());
        }
        try (InputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length(), 64 * 1024)];
            int read = 0;
            int n;
            while (read < bytes.length && (n = in.read(bytes, read, bytes.length - read)) > 0) {
                read += n;
            }
            JSONObject json = new JSONObject(new String(bytes, 0, read, StandardCharsets.UTF_8));
            return new EvictionSummary(json.optLong("count", 0), json.optJSONArray("recent"));
        } catch (IOException | org.json.JSONException e) {
            Log.w(TAG, "Unreadable evictions.json", e);
            return new EvictionSummary(0, new JSONArray());
        }
    }

    /** The {@code bes_crash_detected} message for an incident.json record. */
    public static JSONObject buildDetectedMessage(JSONObject record, EvictionSummary evictions)
            throws org.json.JSONException {
        JSONObject message = new JSONObject();
        message.put("type", "bes_crash_detected");
        message.put("incidentKey", record.optString("incidentKey"));
        message.put("reason", record.optString("reason"));
        message.put("state", record.optString("state"));
        message.put("reportId", nullable(record, "reportId"));

        JSONObject summary = new JSONObject();
        summary.put("attribution", nullable(record, "attribution"));
        summary.put("dumpId", nullable(record, "dumpId"));
        summary.put("bootId", nullable(record, "bootId"));
        summary.put("resetHw", nullable(record, "resetHw"));
        summary.put("resetSw", nullable(record, "resetSw"));
        summary.put("crashUnixMs", nullable(record, "crashUnixMs"));
        summary.put("coveredFromMs", nullable(record, "coveredFromMs"));
        summary.put("coveredToMs", nullable(record, "coveredToMs"));
        summary.put("traceGaps", record.optLong("traceGaps", 0));
        JSONObject flags = record.optJSONObject("flags");
        summary.put("truncated", flags != null && flags.optBoolean("truncated", false));
        summary.put("torn", flags != null && flags.optBoolean("torn", false));
        summary.put("tailCaptured", flags != null && flags.optBoolean("tailCaptured", false));
        summary.put("dumpGap", flags != null && flags.optBoolean("dumpGap", false));

        EvictionSummary ev = evictions != null ? evictions : new EvictionSummary(0, null);
        summary.put("evictedCount", ev.count);
        JSONArray recent = new JSONArray();
        for (int i = Math.max(0, ev.recent.length() - MAX_RECENT_EVICTIONS); i < ev.recent.length(); i++) {
            recent.put(ev.recent.opt(i));
        }
        summary.put("recentEvictions", recent);

        message.put("summary", summary);
        return message;
    }

    private static Object nullable(JSONObject record, String key) {
        return record.has(key) && !record.isNull(key) ? record.opt(key) : JSONObject.NULL;
    }
}
