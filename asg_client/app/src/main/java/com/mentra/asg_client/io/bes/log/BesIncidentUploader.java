package com.mentra.asg_client.io.bes.log;

import android.util.Log;

import com.mentra.asg_client.utils.IncidentLogBleRelayNaming;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.function.Supplier;

/**
 * Upload side of a BES incident bundle (OS-1988): builds each {@code glasses_firmware}
 * representation once, persists it in the bundle, and sends only those persisted bytes on every
 * retry.
 *
 * <ul>
 *   <li>{@code glasses_firmware:full} ({@code upload-full.json}) is the Wi-Fi HTTP body;
 *   <li>{@code glasses_firmware:relay} ({@code upload-relay.json}) is the trimmed BLE relay body
 *       the phone POSTs as-is.
 * </ul>
 *
 * Both bodies carry {@code retryKey} = the artifact key, so Cloud treats identical bytes as
 * idempotent. {@code UPLOADED} is set only on an HTTP 2xx (Wi-Fi) or on the phone's
 * {@code transfer_complete success:true} for this incident's relay file; the phone sends that only
 * after its own POST succeeded.
 */
public final class BesIncidentUploader {
    private static final String TAG = "BesIncidentUploader";

    public static final String ARTIFACT_FULL = "glasses_firmware:full";
    public static final String ARTIFACT_RELAY = "glasses_firmware:relay";

    static final String FULL_FILE = "upload-full.json";
    static final String RELAY_FILE = "upload-relay.json";

    private static final Object LOCK = new Object();
    private static final BesIncidentUploader SHARED =
            new BesIncidentUploader(BesIncidentAccessProvider::get);

    /** Synchronous HTTP seam: returns the HTTP status code. */
    public interface HttpPoster {
        int post(String url, String bearerToken, byte[] body) throws IOException;
    }

    /** A persisted, recorded and attempt-marked upload body. */
    public static final class Prepared {
        public final String incidentKey;
        public final String artifactKey;
        public final byte[] bytes;
        public final String sha256;
        public final File file;

        Prepared(String incidentKey, String artifactKey, byte[] bytes, String sha256, File file) {
            this.incidentKey = incidentKey;
            this.artifactKey = artifactKey;
            this.bytes = bytes;
            this.sha256 = sha256;
            this.file = file;
        }
    }

    private final Supplier<BesIncidentUploadAccess> mAccess;

    public BesIncidentUploader(Supplier<BesIncidentUploadAccess> access) {
        mAccess = access;
    }

    public static BesIncidentUploader shared() {
        return SHARED;
    }

    /** The incident record whose persisted reportId is {@code reportId}, or {@code null}. */
    public JSONObject findByReportId(String reportId) {
        BesIncidentUploadAccess access = mAccess.get();
        if (access == null || reportId == null || reportId.isEmpty()) {
            return null;
        }
        try {
            return access.findByReportId(reportId);
        } catch (RuntimeException e) {
            Log.e(TAG, "findByReportId failed for " + reportId, e);
            return null;
        }
    }

    /** The report's incident was evicted or deleted: there is nothing to upload and no other BES
     *  data may stand in for it. */
    public boolean isRetiredReport(String reportId) {
        BesIncidentUploadAccess access = mAccess.get();
        if (access == null || reportId == null || reportId.isEmpty()) {
            return false;
        }
        try {
            return access.isRetiredReport(reportId);
        } catch (RuntimeException e) {
            Log.e(TAG, "isRetiredReport failed for " + reportId, e);
            return false;
        }
    }

    /** Only STORED and REPORTED incidents are uploaded. */
    public static boolean isUploadable(JSONObject record) {
        if (record == null || record.optBoolean("uploaded", false)) {
            return false;
        }
        String state = record.optString("state", "");
        return "STORED".equals(state) || "REPORTED".equals(state);
    }

    /**
     * Returns the persisted body for {@code artifactKey}, building it first only when it was never
     * recorded. Records {@code sha256}/{@code bytes} when first built and marks the artifact
     * attempted before returning, so the caller may send immediately.
     *
     * <p>Once a representation is recorded it is never rebuilt from the bundle sources (which may
     * have been trimmed or evicted since): the persisted file must still hash to the recorded
     * value, otherwise this returns {@code null} and the incident stays {@code REPORTED}.
     */
    public Prepared prepare(String incidentKey, String artifactKey) {
        BesIncidentUploadAccess access = mAccess.get();
        if (access == null || incidentKey == null) {
            return null;
        }
        boolean relay = ARTIFACT_RELAY.equals(artifactKey);
        if (!relay && !ARTIFACT_FULL.equals(artifactKey)) {
            Log.e(TAG, "Unknown artifact key " + artifactKey);
            return null;
        }
        synchronized (LOCK) {
            try {
                JSONObject record = access.find(incidentKey);
                if (!isUploadable(record)) {
                    Log.w(TAG, "Incident " + incidentKey + " is not uploadable");
                    return null;
                }
                File dir = access.bundleDir(incidentKey);
                if (dir == null) {
                    return null;
                }
                if (relay && relayNameBusy(access, record)) {
                    Log.w(TAG, "Relay file name of " + incidentKey
                            + " is held by another report in flight; waiting for it");
                    return null;
                }
                JSONObject artifacts = record.optJSONObject("artifacts");
                JSONObject artifact = artifacts != null ? artifacts.optJSONObject(artifactKey) : null;
                String recordedSha = null;
                long recordedBytes = 0;
                boolean attempted = false;
                if (artifact != null) {
                    if (!artifact.isNull("sha256")) {
                        String sha = artifact.optString("sha256", "");
                        recordedSha = sha.isEmpty() ? null : sha;
                    }
                    recordedBytes = artifact.optLong("bytes", 0);
                    attempted = artifact.optBoolean("attempted", false);
                }

                File file = new File(dir, relay ? RELAY_FILE : FULL_FILE);
                byte[] bytes = null;
                if (recordedSha != null) {
                    bytes = readIfExists(file);
                    if (bytes != null
                            && (!recordedSha.equals(sha256(bytes)) || bytes.length != recordedBytes)) {
                        bytes = null;
                    }
                    if (bytes == null && attempted) {
                        Log.e(TAG, "Persisted " + artifactKey + " body for " + incidentKey
                                + " is gone or changed after an attempt; never rebuilding");
                        return null;
                    }
                }
                if (bytes == null) {
                    // First build, or an unattempted recorded body whose file was lost. The
                    // builder is deterministic, so a rebuild must reproduce the recorded hash.
                    // Build, persist, record and attempt-mark happen as one store step, so a
                    // concurrent trim or budget pass cannot delete the body in between.
                    bytes = access.commitArtifact(incidentKey, artifactKey,
                            (bundleDir, rec) -> build(bundleDir, rec, relay, artifactKey));
                    if (bytes == null) {
                        Log.w(TAG, "Could not build and persist " + artifactKey + " for "
                                + incidentKey);
                        return null;
                    }
                } else if (!attempted && !access.markAttempted(incidentKey, artifactKey)) {
                    Log.e(TAG, "Could not mark " + artifactKey + " attempted for " + incidentKey);
                    return null;
                }
                return new Prepared(incidentKey, artifactKey, bytes, sha256(bytes), file);
            } catch (Exception e) {
                Log.e(TAG, "prepare failed for " + incidentKey + " " + artifactKey, e);
                return null;
            }
        }
    }

    /**
     * True when this report's relay file name equals that of another REPORTED incident whose relay
     * body was already attempted but not confirmed. The phone keys its transfer by that name, so a
     * second body must wait: admitting it would overwrite the first mapping and could upload one
     * incident's bytes into the other's report. Does not apply once this incident's own relay body
     * is already attempted (it is being retried, not admitted).
     */
    private static boolean relayNameBusy(BesIncidentUploadAccess access, JSONObject record) {
        if (isRelayAttempted(record)) {
            return false;
        }
        String reportId = record.optString("reportId", "");
        if (record.isNull("reportId") || reportId.isEmpty()) {
            return false;
        }
        String name = relayFileBaseName(reportId);
        String ownKey = record.optString("incidentKey", "");
        for (JSONObject other : access.pendingForPhone()) {
            if (ownKey.equals(other.optString("incidentKey", ""))
                    || !"REPORTED".equals(other.optString("state", ""))
                    || other.isNull("reportId")
                    || !isRelayAttempted(other)) {
                continue;
            }
            if (name.equalsIgnoreCase(relayFileBaseName(other.optString("reportId", "")))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isRelayAttempted(JSONObject record) {
        JSONObject artifacts = record.optJSONObject("artifacts");
        JSONObject relay = artifacts != null ? artifacts.optJSONObject(ARTIFACT_RELAY) : null;
        return relay != null && relay.optBoolean("attempted", false);
    }

    /**
     * POSTs the full body. Marks the incident {@code UPLOADED} only when {@code poster} returns an
     * HTTP 2xx; any other outcome (including a bundle that cannot be prepared) leaves it as is.
     *
     * @return {@code true} only when Cloud confirmed
     */
    public boolean uploadOverHttp(
            String incidentKey, String url, String bearerToken, HttpPoster poster) {
        BesIncidentUploadAccess access = mAccess.get();
        Prepared prepared = prepare(incidentKey, ARTIFACT_FULL);
        if (access == null || prepared == null) {
            return false;
        }
        int status;
        try {
            status = poster.post(url, bearerToken, prepared.bytes);
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Incident upload failed for " + incidentKey, e);
            return false;
        }
        if (status < 200 || status >= 300) {
            Log.e(TAG, "Server rejected incident upload for " + incidentKey + ", status " + status);
            return false;
        }
        boolean marked = access.markUploaded(incidentKey);
        Log.i(TAG, "Incident " + incidentKey + " uploaded over HTTP, markUploaded=" + marked);
        return true;
    }

    /**
     * BLE file base name the phone and glasses use for this incident's relay body. It is the first
     * 15 characters of the report id (the K900 file-name limit, shared with the phone's
     * {@code IncidentLogBleRelayNaming} and released phones), so two report ids that agree on those
     * characters (the {@code rep_} prefix, a 10-character millisecond timestamp and one random
     * character) cannot be told apart; {@link #onTransferComplete} then marks neither.
     */
    public static String relayFileBaseName(String reportId) {
        return IncidentLogBleRelayNaming.bleFileBaseName(reportId, 'B');
    }

    /**
     * The phone's {@code transfer_complete}: {@code UPLOADED} only for {@code success:true} on the
     * relay file of a {@code REPORTED} incident whose relay body was actually attempted. The
     * relay file name is derived from the persisted reportId, so no state survives in memory.
     *
     * @return the incidentKey that became uploaded, or {@code null}
     */
    public String onTransferComplete(String fileName, boolean success) {
        BesIncidentUploadAccess access = mAccess.get();
        if (!success || access == null || fileName == null || fileName.isEmpty()) {
            return null;
        }
        String base = fileName;
        int slash = base.lastIndexOf('/');
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        int dot = base.indexOf('.');
        if (dot >= 0) {
            base = base.substring(0, dot);
        }
        if (base.isEmpty() || base.charAt(0) != 'B') {
            return null;
        }
        try {
            List<JSONObject> pending = access.pendingForPhone();
            String matchedKey = null;
            for (JSONObject record : pending) {
                if (!"REPORTED".equals(record.optString("state", ""))
                        || record.isNull("reportId")) {
                    continue;
                }
                String reportId = record.optString("reportId", "");
                JSONObject artifacts = record.optJSONObject("artifacts");
                JSONObject relay = artifacts != null ? artifacts.optJSONObject(ARTIFACT_RELAY) : null;
                if (reportId.isEmpty()
                        || relay == null
                        || !relay.optBoolean("attempted", false)
                        || !base.equalsIgnoreCase(relayFileBaseName(reportId))) {
                    continue;
                }
                if (matchedKey != null) {
                    // The 15-character file name cannot tell these reports apart, so no completion
                    // can be attributed to either; both stay REPORTED and are retried.
                    Log.e(TAG, "Relay file " + fileName + " is ambiguous between "
                            + matchedKey + " and " + record.optString("incidentKey", "")
                            + "; not marking either uploaded");
                    return null;
                }
                matchedKey = record.optString("incidentKey", "");
            }
            if (matchedKey != null) {
                boolean marked = access.markUploaded(matchedKey);
                Log.i(TAG, "Relay file " + fileName + " confirmed for " + matchedKey
                        + ", markUploaded=" + marked);
                return marked ? matchedKey : null;
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "transfer_complete bookkeeping failed for " + fileName, e);
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------

    private static byte[] build(File dir, JSONObject record, boolean relay, String artifactKey)
            throws IOException {
        byte[] dumpBytes = readIfExists(new File(dir, "dump.txt"));
        byte[] traceBytes = readIfExists(new File(dir, "trace.txt"));
        if (dumpBytes == null && traceBytes == null) {
            return null;
        }
        long crashMs = record.optLong("crashUnixMs", 0);
        long dumpTs = crashMs > 0 ? crashMs : record.optLong("createdMs", 0);
        String json = BesLogManager.buildIncidentFirmwareJson(
                dumpBytes != null ? new String(dumpBytes, StandardCharsets.UTF_8) : null,
                dumpTs,
                BesLogManager.parseIncidentTrace(
                        traceBytes != null ? new String(traceBytes, StandardCharsets.UTF_8) : null),
                relay,
                artifactKey);
        return json != null ? json.getBytes(StandardCharsets.UTF_8) : null;
    }

    private static byte[] readIfExists(File file) throws IOException {
        if (file == null || !file.isFile()) {
            return null;
        }
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(file.length(), 1 << 20));
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    static String sha256(byte[] bytes) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(bytes);
        StringBuilder hex = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            hex.append(String.format(Locale.US, "%02x", b));
        }
        return hex.toString();
    }
}
