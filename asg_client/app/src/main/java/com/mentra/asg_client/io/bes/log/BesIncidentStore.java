package com.mentra.asg_client.io.bes.log;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.service.utils.SysProp;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * Persistent store of BES crash incident bundles under {@code files/bes_incident} (OS-1988
 * contract sections 1 and 7).
 *
 * <pre>
 * bes_incident/
 *   device_id        16 hex, created once; names the incident keys when the serial is unprovisioned
 *   last_boot        the last BES boot_id ASG observed
 *   collected.json   dump ids / observed-reset boot ids already handled (bounded rings)
 *   evictions.json   {"count": total, "recent": [latest 16]}
 *   &lt;incidentKey&gt;/  incident.json, dump.txt | dump.partial, trace.txt, upload-*.json
 * </pre>
 *
 * <p>Every write of a small file is tmp + fsync + rename, so a crash leaves either the old or the
 * new content. All methods are synchronized on the store.
 */
public final class BesIncidentStore implements BesIncidentUploadAccess {
    private static final String TAG = "BesIncidentStore";
    private static final String FILE_DEVICE_ID = "device_id";
    private static final String FILE_LAST_BOOT = "last_boot";
    private static final String FILE_COLLECTED = "collected.json";
    private static final String FILE_EVICTIONS = "evictions.json";
    private static final String TMP_SUFFIX = ".tmp";

    private final File mRoot;
    private final LongSupplier mClockMs;
    private final Supplier<String> mSerial;
    private final Supplier<String> mRandomHex;

    /** Store under {@code files/bes_incident} using the device serial for incident keys. */
    public static BesIncidentStore create(Context context) {
        Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        return new BesIncidentStore(
                new File(app.getFilesDir(), AsgConstants.BES_INCIDENT_DIR_NAME),
                System::currentTimeMillis,
                () -> SysProp.getDeviceSerial(app),
                BesIncidentStore::randomHex16);
    }

    public BesIncidentStore(File root, LongSupplier clockMs, Supplier<String> serial,
            Supplier<String> randomHex) {
        mRoot = root;
        mClockMs = clockMs;
        mSerial = serial;
        mRandomHex = randomHex;
    }

    public File root() {
        return mRoot;
    }

    // ---------------------------------------------------------------- identity

    /** Serial part of an incident key: the sanitized serial, or {@code anon<16 hex>}. */
    public synchronized String serialPart() {
        String serial = mSerial.get();
        if (serial != null && !serial.trim().isEmpty()) {
            return BesIncident.sanitizeKeyPart(serial.trim());
        }
        return "anon" + deviceId();
    }

    /** Persisted random id, created once with an atomic write and never regenerated. */
    synchronized String deviceId() {
        File file = new File(mRoot, FILE_DEVICE_ID);
        String existing = readText(file);
        if (existing != null && !existing.trim().isEmpty()) {
            return BesIncident.sanitizeKeyPart(existing.trim());
        }
        String value = mRandomHex.get();
        try {
            writeAtomic(file, value.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.e(TAG, "Could not persist device_id", e);
        }
        return value;
    }

    public synchronized String dumpKey(String dumpId) {
        return BesIncident.key(serialPart(), "dump", dumpId);
    }

    public synchronized String resetKey(String bootId) {
        return BesIncident.key(serialPart(), "reset", bootId);
    }

    // ----------------------------------------------------------------- startup

    /**
     * Removes what an interrupted write can leave behind: temporary files and bundle directories
     * that never got an incident.json (the record is the first thing written for a bundle).
     */
    public synchronized void recover() {
        File[] entries = mRoot.listFiles();
        if (entries == null) {
            return;
        }
        for (File entry : entries) {
            if (entry.isFile() && entry.getName().endsWith(TMP_SUFFIX)) {
                entry.delete();
            } else if (entry.isDirectory()) {
                File[] inner = entry.listFiles();
                if (inner != null) {
                    for (File f : inner) {
                        if (f.getName().endsWith(TMP_SUFFIX)) {
                            f.delete();
                        }
                    }
                }
                if (!new File(entry, BesIncident.FILE_RECORD).isFile()) {
                    deleteRecursive(entry);
                }
            }
        }
    }

    // ----------------------------------------------------------------- records

    public synchronized boolean exists(String incidentKey) {
        return BesIncident.isValidKey(incidentKey) && recordFile(incidentKey).isFile();
    }

    @Override
    public synchronized JSONObject find(String incidentKey) {
        if (!BesIncident.isValidKey(incidentKey)) {
            return null;
        }
        return readRecord(recordFile(incidentKey));
    }

    @Override
    public synchronized JSONObject findByReportId(String reportId) {
        if (reportId == null || reportId.isEmpty()) {
            return null;
        }
        for (JSONObject record : all()) {
            if (!record.isNull("reportId") && reportId.equals(record.optString("reportId"))) {
                return record;
            }
        }
        return null;
    }

    @Override
    public synchronized File bundleDir(String incidentKey) {
        return exists(incidentKey) ? new File(mRoot, incidentKey) : null;
    }

    /** Every incident record, oldest first. */
    public synchronized List<JSONObject> all() {
        List<JSONObject> records = new ArrayList<>();
        File[] entries = mRoot.listFiles();
        if (entries != null) {
            for (File entry : entries) {
                if (entry.isDirectory() && BesIncident.isValidKey(entry.getName())) {
                    JSONObject record = readRecord(new File(entry, BesIncident.FILE_RECORD));
                    if (record != null) {
                        records.add(record);
                    }
                }
            }
        }
        Collections.sort(records, BY_AGE);
        return records;
    }

    @Override
    public synchronized List<JSONObject> pendingForPhone() {
        List<JSONObject> pending = new ArrayList<>();
        for (JSONObject record : all()) {
            String state = record.optString("state");
            if ((BesIncident.STATE_STORED.equals(state) || BesIncident.STATE_REPORTED.equals(state))
                    && !record.optBoolean("uploaded", false)) {
                pending.add(record);
            }
        }
        return pending;
    }

    /** Creates the (still record-less) bundle directory so a TRACE freeze can write into it. */
    public synchronized boolean prepareBundleDir(String incidentKey) {
        if (!BesIncident.isValidKey(incidentKey)) {
            return false;
        }
        File dir = new File(mRoot, incidentKey);
        return dir.isDirectory() || dir.mkdirs();
    }

    /** Removes a bundle directory that never got a record. */
    public synchronized void discardBundleDir(String incidentKey) {
        if (BesIncident.isValidKey(incidentKey) && !recordFile(incidentKey).isFile()) {
            deleteRecursive(new File(mRoot, incidentKey));
        }
    }

    /** Writes a new bundle's record; false when a bundle with that key exists or the write failed. */
    public synchronized boolean create(JSONObject record) {
        String key = record.optString("incidentKey");
        if (!BesIncident.isValidKey(key) || recordFile(key).isFile()) {
            return false;
        }
        File dir = new File(mRoot, key);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            return false;
        }
        return writeRecord(record);
    }

    /** Atomically rewrites an existing incident's record. */
    public synchronized boolean save(JSONObject record) {
        String key = record.optString("incidentKey");
        if (!BesIncident.isValidKey(key) || !recordFile(key).isFile()) {
            return false;
        }
        return writeRecord(record);
    }

    public File dumpPartialFile(String key) {
        return new File(new File(mRoot, key), BesIncident.FILE_DUMP_PARTIAL);
    }

    public File dumpFile(String key) {
        return new File(new File(mRoot, key), BesIncident.FILE_DUMP);
    }

    public File traceFile(String key) {
        return new File(new File(mRoot, key), BesIncident.FILE_TRACE);
    }

    // ------------------------------------------------------- upload-side access

    @Override
    public synchronized boolean markReported(String incidentKey, String reportId) {
        JSONObject record = find(incidentKey);
        if (record == null || reportId == null || reportId.isEmpty()) {
            return false;
        }
        String state = record.optString("state");
        String existing = record.isNull("reportId") ? null : record.optString("reportId", null);
        if (existing != null && !existing.isEmpty()) {
            return existing.equals(reportId) && (BesIncident.STATE_REPORTED.equals(state)
                    || BesIncident.STATE_UPLOADED.equals(state));
        }
        if (!BesIncident.STATE_STORED.equals(state)) {
            return false;
        }
        try {
            record.put("reportId", reportId);
            record.put("state", BesIncident.STATE_REPORTED);
        } catch (JSONException e) {
            return false;
        }
        return writeRecord(record);
    }

    @Override
    public synchronized boolean recordArtifact(String incidentKey, String artifactKey,
            String sha256, long bytes) {
        JSONObject record = find(incidentKey);
        if (record == null || !BesIncident.isArtifactKey(artifactKey) || sha256 == null
                || sha256.isEmpty() || bytes < 0) {
            return false;
        }
        JSONObject artifacts = record.optJSONObject("artifacts");
        JSONObject artifact = artifacts == null ? null : artifacts.optJSONObject(artifactKey);
        if (artifact == null) {
            return false;
        }
        if (!artifact.isNull("sha256")) {
            return sha256.equals(artifact.optString("sha256")) && bytes == artifact.optLong("bytes");
        }
        try {
            artifact.put("sha256", sha256);
            artifact.put("bytes", bytes);
        } catch (JSONException e) {
            return false;
        }
        return writeRecord(record);
    }

    @Override
    public synchronized byte[] commitArtifact(String incidentKey, String artifactKey,
            ArtifactBuilder builder) {
        JSONObject record = find(incidentKey);
        if (record == null || !BesIncident.isArtifactKey(artifactKey)) {
            return null;
        }
        JSONObject artifacts = record.optJSONObject("artifacts");
        JSONObject artifact = artifacts == null ? null : artifacts.optJSONObject(artifactKey);
        if (artifact == null) {
            return null;
        }
        boolean relay = artifactKey.endsWith(":relay");
        File file = new File(bundleDir(incidentKey),
                relay ? BesIncident.FILE_UPLOAD_RELAY : BesIncident.FILE_UPLOAD_FULL);
        String recordedSha = artifact.isNull("sha256") ? null : artifact.optString("sha256", "");
        if (recordedSha != null && recordedSha.isEmpty()) {
            recordedSha = null;
        }
        try {
            byte[] bytes = builder.build(bundleDir(incidentKey), record);
            if (bytes == null) {
                return null;
            }
            String sha = sha256Hex(bytes);
            if (recordedSha != null && !recordedSha.equals(sha)) {
                Log.e(TAG, "Rebuilt " + artifactKey + " differs from the recorded body for "
                        + incidentKey);
                return null;
            }
            writeAtomic(file, bytes);
            artifact.put("sha256", sha);
            artifact.put("bytes", bytes.length);
            artifact.put("attempted", true);
            if (!writeRecord(record)) {
                return null;
            }
            enforceBudget(incidentKey);
            return find(incidentKey) != null && file.isFile() ? bytes : null;
        } catch (IOException | JSONException | java.security.NoSuchAlgorithmException e) {
            Log.e(TAG, "commitArtifact failed for " + incidentKey + " " + artifactKey, e);
            return null;
        }
    }

    private static String sha256Hex(byte[] bytes) throws java.security.NoSuchAlgorithmException {
        byte[] hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            hex.append(String.format(java.util.Locale.US, "%02x", b));
        }
        return hex.toString();
    }

    @Override
    public synchronized boolean markAttempted(String incidentKey, String artifactKey) {
        JSONObject record = find(incidentKey);
        if (record == null || !BesIncident.isArtifactKey(artifactKey)) {
            return false;
        }
        JSONObject artifacts = record.optJSONObject("artifacts");
        JSONObject artifact = artifacts == null ? null : artifacts.optJSONObject(artifactKey);
        if (artifact == null || artifact.isNull("sha256")) {
            // Nothing was built (or the body was invalidated by a budget trim): there are no
            // bytes to freeze, so the caller must record the artifact again first.
            return false;
        }
        if (artifact.optBoolean("attempted", false)) {
            return true;
        }
        try {
            artifact.put("attempted", true);
        } catch (JSONException e) {
            return false;
        }
        return writeRecord(record);
    }

    @Override
    public synchronized boolean markUploaded(String incidentKey) {
        JSONObject record = find(incidentKey);
        if (record == null) {
            return false;
        }
        String state = record.optString("state");
        if (BesIncident.STATE_UPLOADED.equals(state)) {
            return true;
        }
        if (!BesIncident.STATE_REPORTED.equals(state)) {
            return false;
        }
        try {
            record.put("state", BesIncident.STATE_UPLOADED);
            record.put("uploaded", true);
        } catch (JSONException e) {
            return false;
        }
        return writeRecord(record);
    }

    // ------------------------------------------------------------ bookkeeping

    /** The last BES boot_id ASG observed, or null (first connect, cleared data). */
    public synchronized String lastBoot() {
        String value = readText(new File(mRoot, FILE_LAST_BOOT));
        value = value == null ? null : value.trim();
        return BesIncident.isBootId(value) ? value : null;
    }

    public synchronized boolean saveLastBoot(String bootId) {
        try {
            writeAtomic(new File(mRoot, FILE_LAST_BOOT), bootId.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (IOException e) {
            Log.e(TAG, "Could not persist last_boot", e);
            return false;
        }
    }

    public synchronized boolean isDumpCollected(String dumpId) {
        return ringContains("dumps", dumpId);
    }

    public synchronized boolean markDumpCollected(String dumpId) {
        return ringAdd("dumps", dumpId);
    }

    /** True when a no-dump incident was already raised for the boot that observed the reset. */
    public synchronized boolean isResetObserved(String bootId) {
        return ringContains("resets", bootId);
    }

    public synchronized boolean markResetObserved(String bootId) {
        return ringAdd("resets", bootId);
    }

    private boolean ringContains(String name, String id) {
        JSONArray ring = readCollected().optJSONArray(name);
        for (int i = 0; ring != null && i < ring.length(); i++) {
            if (ring.optString(i).equals(id)) {
                return true;
            }
        }
        return false;
    }

    private boolean ringAdd(String name, String id) {
        JSONObject collected = readCollected();
        try {
            JSONArray old = collected.optJSONArray(name);
            JSONArray next = new JSONArray();
            int start = old == null ? 0
                    : Math.max(0, old.length() + 1 - AsgConstants.BES_INCIDENT_COLLECTED_RING);
            boolean present = false;
            for (int i = start; old != null && i < old.length(); i++) {
                String value = old.optString(i);
                present |= value.equals(id);
                next.put(value);
            }
            if (present) {
                return true;
            }
            next.put(id);
            collected.put(name, next);
            writeAtomic(new File(mRoot, FILE_COLLECTED),
                    collected.toString().getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (JSONException | IOException e) {
            Log.e(TAG, "Could not persist collected.json", e);
            return false;
        }
    }

    private JSONObject readCollected() {
        String text = readText(new File(mRoot, FILE_COLLECTED));
        if (text != null) {
            try {
                return new JSONObject(text);
            } catch (JSONException ignored) {
                // Corrupt bookkeeping starts over; the bundles themselves still deduplicate.
            }
        }
        return new JSONObject();
    }

    // -------------------------------------------------- budget and eviction

    /** Bytes used by everything under the incident directory. */
    public synchronized long totalBytes() {
        return sizeOf(mRoot);
    }

    /**
     * Brings the directory back under {@link AsgConstants#BES_INCIDENT_DIR_BUDGET_BYTES} and the
     * bundle count under {@link AsgConstants#BES_INCIDENT_MAX_BUNDLES}. Order:
     *
     * <ol>
     *   <li>drop the payload of bundles already UPLOADED (their record stays, a few hundred bytes);
     *   <li>trim the TRACE (oldest lines first) of incidents whose artifact bytes were never
     *       attempted, oldest incident first, down to the trim floor;
     *   <li>evict the oldest not-uploaded bundle, writing an eviction record.
     * </ol>
     *
     * Trimming never touches an incident with an attempted artifact: its upload bytes are
     * immutable. {@code protectedKey} (the bundle just written) is evicted only as a last resort,
     * which cannot happen while a single bundle is smaller than the budget.
     */
    public synchronized void enforceBudget(String protectedKey) {
        for (int guard = 0; guard < 1000; guard++) {
            List<JSONObject> records = all();
            long total = totalBytes();
            boolean overBytes = total > AsgConstants.BES_INCIDENT_DIR_BUDGET_BYTES;
            boolean overCount = records.size() > AsgConstants.BES_INCIDENT_MAX_BUNDLES;
            if (!overBytes && !overCount) {
                return;
            }
            if (overCount) {
                JSONObject uploaded = firstInState(records, BesIncident.STATE_UPLOADED, null);
                if (uploaded != null) {
                    retireReport(uploaded);
                    deleteRecursive(new File(mRoot, uploaded.optString("incidentKey")));
                    continue;
                }
            } else {
                JSONObject shrinkable = null;
                for (JSONObject r : records) {
                    if (BesIncident.STATE_UPLOADED.equals(r.optString("state"))
                            && hasPayload(r.optString("incidentKey"))) {
                        shrinkable = r;
                        break;
                    }
                }
                if (shrinkable != null) {
                    dropPayload(shrinkable.optString("incidentKey"));
                    continue;
                }
                long excess = total - AsgConstants.BES_INCIDENT_DIR_BUDGET_BYTES;
                if (trimOne(records, protectedKey, excess)) {
                    continue;
                }
            }
            JSONObject victim = oldestNotUploaded(records, protectedKey);
            if (victim == null) {
                victim = oldestNotUploaded(records, null);
            }
            if (victim == null) {
                return;
            }
            evict(victim.optString("incidentKey"), "budget", true);
        }
    }

    /**
     * Deletes a bundle and records the eviction. The dump id is remembered as collected so the
     * still-saved BES dump does not create the incident again.
     */
    public synchronized void evict(String incidentKey, String reason, boolean markCollected) {
        if (!BesIncident.isValidKey(incidentKey)) {
            return;
        }
        File dir = new File(mRoot, incidentKey);
        JSONObject record = readRecord(new File(dir, BesIncident.FILE_RECORD));
        long bytes = sizeOf(dir);
        String dumpId = record == null || record.isNull("dumpId") ? null : record.optString("dumpId");
        if (markCollected && BesIncident.isDumpId(dumpId)) {
            markDumpCollected(dumpId);
        }
        deleteRecursive(dir);
        JSONObject evictions = readEvictions();
        try {
            addRetiredReport(evictions, record);
            JSONArray old = evictions.optJSONArray("recent");
            JSONArray next = new JSONArray();
            int start = old == null ? 0
                    : Math.max(0, old.length() + 1 - AsgConstants.BES_INCIDENT_EVICTION_RING);
            for (int i = start; old != null && i < old.length(); i++) {
                next.put(old.get(i));
            }
            JSONObject entry = new JSONObject();
            entry.put("incidentKey", incidentKey);
            entry.put("reason", reason);
            entry.put("bytes", bytes);
            entry.put("ms", mClockMs.getAsLong());
            next.put(entry);
            evictions.put("recent", next);
            evictions.put("count", evictions.optLong("count", 0) + 1);
            writeAtomic(new File(mRoot, FILE_EVICTIONS),
                    evictions.toString().getBytes(StandardCharsets.UTF_8));
        } catch (JSONException | IOException e) {
            Log.e(TAG, "Could not persist evictions.json", e);
        }
        Log.w(TAG, "Evicted incident " + incidentKey + " (" + reason + ", " + bytes + " bytes)");
    }

    /**
     * The {@code evictions.json} content: {@code {"count": total, "recent": [...]}} with the
     * latest {@link AsgConstants#BES_INCIDENT_EVICTION_RING} entries, oldest first.
     */
    public synchronized JSONObject evictionSummary() {
        return readEvictions();
    }

    /**
     * True when the incident of {@code reportId} was evicted or deleted. Persisted in
     * {@code evictions.json}, bounded by {@link AsgConstants#BES_INCIDENT_RETIRED_REPORT_RING}.
     */
    @Override
    public synchronized boolean isRetiredReport(String reportId) {
        if (reportId == null || reportId.isEmpty()) {
            return false;
        }
        JSONArray reports = readEvictions().optJSONArray("reports");
        for (int i = 0; reports != null && i < reports.length(); i++) {
            if (reportId.equals(reports.optString(i))) {
                return true;
            }
        }
        return false;
    }

    /** Remembers the record's reportId before its bundle is deleted without an eviction entry. */
    private void retireReport(JSONObject record) {
        JSONObject evictions = readEvictions();
        try {
            if (addRetiredReport(evictions, record)) {
                writeAtomic(new File(mRoot, FILE_EVICTIONS),
                        evictions.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (JSONException | IOException e) {
            Log.e(TAG, "Could not persist the retired report id", e);
        }
    }

    /** Appends the record's reportId to {@code evictions.reports} (newest last, bounded). */
    private static boolean addRetiredReport(JSONObject evictions, JSONObject record)
            throws JSONException {
        if (record == null || record.isNull("reportId")) {
            return false;
        }
        String reportId = record.optString("reportId", "");
        if (reportId.isEmpty()) {
            return false;
        }
        JSONArray old = evictions.optJSONArray("reports");
        JSONArray next = new JSONArray();
        int start = old == null ? 0
                : Math.max(0, old.length() + 1 - AsgConstants.BES_INCIDENT_RETIRED_REPORT_RING);
        for (int i = start; old != null && i < old.length(); i++) {
            if (!reportId.equals(old.optString(i))) {
                next.put(old.get(i));
            }
        }
        next.put(reportId);
        evictions.put("reports", next);
        return true;
    }

    private JSONObject readEvictions() {
        String text = readText(new File(mRoot, FILE_EVICTIONS));
        if (text != null) {
            try {
                JSONObject evictions = new JSONObject(text);
                if (evictions.optJSONArray("recent") == null) {
                    evictions.put("recent", new JSONArray());
                }
                return evictions;
            } catch (JSONException ignored) {
                // Fall through to an empty summary.
            }
        }
        JSONObject empty = new JSONObject();
        try {
            empty.put("count", 0);
            empty.put("recent", new JSONArray());
        } catch (JSONException ignored) {
            // Cannot happen with these literals.
        }
        return empty;
    }

    private boolean trimOne(List<JSONObject> records, String protectedKey, long excessBytes) {
        List<JSONObject> order = new ArrayList<>(records);
        // The bundle just written is trimmed last.
        Collections.sort(order, (a, b) -> {
            boolean pa = a.optString("incidentKey").equals(protectedKey);
            boolean pb = b.optString("incidentKey").equals(protectedKey);
            return pa == pb ? BY_AGE.compare(a, b) : (pa ? 1 : -1);
        });
        for (JSONObject record : order) {
            if (BesIncident.STATE_UPLOADED.equals(record.optString("state"))
                    || anyAttempted(record)) {
                continue;
            }
            String key = record.optString("incidentKey");
            File trace = traceFile(key);
            long size = trace.length();
            if (size <= AsgConstants.BES_INCIDENT_TRACE_TRIM_FLOOR_BYTES) {
                continue;
            }
            long target = Math.max(AsgConstants.BES_INCIDENT_TRACE_TRIM_FLOOR_BYTES,
                    size - excessBytes);
            if (trimTrace(record, trace, target)) {
                return true;
            }
        }
        return false;
    }

    /** Keeps the newest whole lines of the TRACE within {@code targetBytes} and fixes the record. */
    private boolean trimTrace(JSONObject record, File trace, long targetBytes) {
        byte[] data = readBytes(trace);
        if (data == null) {
            return false;
        }
        List<Integer> starts = new ArrayList<>();
        starts.add(0);
        for (int i = 0; i < data.length - 1; i++) {
            if (data[i] == '\n') {
                starts.add(i + 1);
            }
        }
        int keepFrom = data.length;
        long kept = 0;
        // Walk lines from the newest, keeping whole lines while they fit.
        for (int s = starts.size() - 1; s >= 0; s--) {
            int start = starts.get(s);
            int end = s + 1 < starts.size() ? starts.get(s + 1) : data.length;
            if (kept + (end - start) > targetBytes) {
                break;
            }
            kept += end - start;
            keepFrom = start;
        }
        if (keepFrom == 0 || keepFrom >= data.length) {
            return false;
        }
        byte[] trimmed = new byte[data.length - keepFrom];
        System.arraycopy(data, keepFrom, trimmed, 0, trimmed.length);
        String text = new String(trimmed, StandardCharsets.UTF_8);
        int gaps = 0;
        for (int at = text.indexOf("[ASG-BES-GAP]"); at >= 0;
                at = text.indexOf("[ASG-BES-GAP]", at + 1)) {
            gaps++;
        }
        long firstWall = 0;
        int tab = text.indexOf('\t');
        if (tab > 0) {
            try {
                firstWall = Long.parseLong(text.substring(0, tab));
            } catch (NumberFormatException ignored) {
                firstWall = 0;
            }
        }
        try {
            writeAtomic(trace, trimmed);
            // Built-but-unattempted upload bodies were made from the longer TRACE.
            new File(trace.getParentFile(), BesIncident.FILE_UPLOAD_FULL).delete();
            new File(trace.getParentFile(), BesIncident.FILE_UPLOAD_RELAY).delete();
            JSONObject artifacts = BesIncident.newArtifacts();
            record.put("artifacts", artifacts);
            if (firstWall > 0) {
                record.put("coveredFromMs", firstWall);
            }
            record.put("traceGaps", gaps);
            record.put("traceTrimmed", true);
            return writeRecord(record);
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Could not trim TRACE", e);
            return false;
        }
    }

    private static boolean anyAttempted(JSONObject record) {
        JSONObject artifacts = record.optJSONObject("artifacts");
        if (artifacts == null) {
            return false;
        }
        JSONArray names = artifacts.names();
        for (int i = 0; names != null && i < names.length(); i++) {
            JSONObject artifact = artifacts.optJSONObject(names.optString(i));
            if (artifact != null && artifact.optBoolean("attempted", false)) {
                return true;
            }
        }
        return false;
    }

    private JSONObject firstInState(List<JSONObject> records, String state, String exceptKey) {
        for (JSONObject r : records) {
            if (state.equals(r.optString("state")) && !r.optString("incidentKey").equals(exceptKey)) {
                return r;
            }
        }
        return null;
    }

    private JSONObject oldestNotUploaded(List<JSONObject> records, String exceptKey) {
        for (JSONObject r : records) {
            if (!BesIncident.STATE_UPLOADED.equals(r.optString("state"))
                    && !r.optString("incidentKey").equals(exceptKey)) {
                return r;
            }
        }
        return null;
    }

    private boolean hasPayload(String key) {
        File dir = new File(mRoot, key);
        File[] files = dir.listFiles();
        if (files == null) {
            return false;
        }
        for (File f : files) {
            if (!f.getName().equals(BesIncident.FILE_RECORD)) {
                return true;
            }
        }
        return false;
    }

    private void dropPayload(String key) {
        File[] files = new File(mRoot, key).listFiles();
        if (files == null) {
            return;
        }
        for (File f : files) {
            if (!f.getName().equals(BesIncident.FILE_RECORD)) {
                f.delete();
            }
        }
    }

    // ------------------------------------------------------------ file helpers

    private static final Comparator<JSONObject> BY_AGE = (a, b) -> {
        int byTime = Long.compare(a.optLong("createdMs", 0), b.optLong("createdMs", 0));
        return byTime != 0 ? byTime
                : a.optString("incidentKey").compareTo(b.optString("incidentKey"));
    };

    private File recordFile(String key) {
        return new File(new File(mRoot, key), BesIncident.FILE_RECORD);
    }

    private boolean writeRecord(JSONObject record) {
        try {
            writeAtomic(recordFile(record.optString("incidentKey")),
                    record.toString(2).getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (IOException | JSONException e) {
            Log.e(TAG, "Could not persist incident record", e);
            return false;
        }
    }

    private static JSONObject readRecord(File file) {
        String text = readText(file);
        if (text == null) {
            return null;
        }
        try {
            return new JSONObject(text);
        } catch (JSONException e) {
            Log.e(TAG, "Unreadable incident record " + file, e);
            return null;
        }
    }

    /** Writes {@code data} to {@code dest} through a temporary sibling: fsync, then rename. */
    static void writeAtomic(File dest, byte[] data) throws IOException {
        File dir = dest.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Cannot create " + dir);
        }
        File tmp = new File(dir, dest.getName() + TMP_SUFFIX);
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.flush();
            out.getFD().sync();
        }
        if (!tmp.renameTo(dest)) {
            tmp.delete();
            throw new IOException("Cannot rename " + tmp + " to " + dest);
        }
    }

    static byte[] readBytes(File file) {
        if (!file.isFile()) {
            return null;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(file.length(), 1 << 20));
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) {
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }

    static String readText(File file) {
        byte[] bytes = readBytes(file);
        return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
    }

    static long sizeOf(File file) {
        if (file.isFile()) {
            return file.length();
        }
        long total = 0;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                total += sizeOf(child);
            }
        }
        return total;
    }

    static void deleteRecursive(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursive(child);
            }
        }
        file.delete();
    }

    static String randomHex16() {
        byte[] bytes = new byte[8];
        new SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder(16);
        for (byte b : bytes) {
            out.append(String.format("%02x", b));
        }
        return out.toString();
    }
}
