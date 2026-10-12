package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.mentra.asg_client.AsgConstants;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

@RunWith(RobolectricTestRunner.class)
public class BesIncidentStoreTest {
    private static final long T0 = 1_800_000_000_000L;
    private static final int MIB = 1024 * 1024;
    /** Ten of these overflow the 8 MiB budget; nine do not. */
    private static final int S = 900 * 1024;

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private File mRoot;
    private AtomicLong mNow;
    private String mSerial;

    @Before
    public void setUp() {
        mRoot = new File(folder.getRoot(), "bes_incident");
        mNow = new AtomicLong(T0);
        mSerial = "ML395018B";
    }

    private BesIncidentStore store() {
        return new BesIncidentStore(mRoot, mNow::get, () -> mSerial, () -> "0123456789abcdef");
    }

    /** A STORED dump incident whose TRACE is {@code traceBytes} bytes of 100-byte lines. */
    private String addIncident(BesIncidentStore store, int n, int traceBytes) throws Exception {
        String key = store.dumpKey(String.format("%08x-%08x", n, n));
        JSONObject record = new JSONObject()
                .put("v", 1).put("incidentKey", key).put("kind", "dump")
                .put("reason", "bes_crash").put("state", "STORED").put("attribution", "match")
                .put("dumpId", String.format("%08x-%08x", n, n)).put("dumpLen", 100)
                .put("coveredFromMs", T0).put("coveredToMs", T0).put("traceGaps", 0)
                .put("createdMs", T0 + n).put("collectAttempts", 1)
                .put("reportId", JSONObject.NULL).put("artifacts", BesIncident.newArtifacts())
                .put("uploaded", false);
        assertTrue(store.prepareBundleDir(key));
        StringBuilder trace = new StringBuilder();
        long wall = T0 - traceBytes;
        for (int bytes = 0; bytes < traceBytes; bytes += 100) {
            String line = (wall + bytes) + "\t3\t" + bytes + "\t";
            StringBuilder padded = new StringBuilder(line);
            while (padded.length() < 99) {
                padded.append('x');
            }
            trace.append(padded).append('\n');
        }
        try (FileOutputStream out = new FileOutputStream(store.traceFile(key))) {
            out.write(trace.toString().getBytes(StandardCharsets.UTF_8));
        }
        assertTrue(store.create(record));
        return key;
    }

    private static String sha() {
        return "ab".repeat(32);
    }

    @Test
    public void incidentKeysUseTheSerialOrAnAnonIdCreatedOnce() {
        BesIncidentStore store = store();
        assertEquals("ML395018B-dump-0000002a-1f2e3d4c", store.dumpKey("0000002a-1f2e3d4c"));
        assertEquals("ML395018B-reset-9f3a0c1b2d4e5f60", store.resetKey("9f3a0c1b2d4e5f60"));

        mSerial = "";
        assertFalse(new File(mRoot, "device_id").exists());
        String key = store.dumpKey("0000002a-1f2e3d4c");
        assertEquals("anon0123456789abcdef-dump-0000002a-1f2e3d4c", key);
        assertTrue(new File(mRoot, "device_id").isFile());

        // Never regenerated while the file exists, even by a new store with another random value.
        BesIncidentStore again = new BesIncidentStore(mRoot, mNow::get, () -> "",
                () -> "ffffffffffffffff");
        assertEquals(key, again.dumpKey("0000002a-1f2e3d4c"));
        assertEquals("0123456789abcdef", BesIncidentStore.readText(new File(mRoot, "device_id")));
    }

    @Test
    public void keysAreSanitizedAndFitTheKeyPattern() {
        mSerial = "ML 39/5018B";
        BesIncidentStore store = store();
        String key = store.dumpKey("0000002a-1f2e3d4c");
        assertEquals("ML_39_5018B-dump-0000002a-1f2e3d4c", key);
        assertTrue(BesIncident.isValidKey(key));

        mSerial = "S".repeat(300);
        String longKey = store.dumpKey("0000002a-1f2e3d4c");
        assertEquals(128, longKey.length());
        assertTrue(longKey.endsWith("-dump-0000002a-1f2e3d4c"));
        assertTrue(BesIncident.isValidKey(longKey));
        assertFalse(BesIncident.isValidKey("../x"));
        assertFalse(BesIncident.isValidKey(".."));
        assertNull(store.find("../device_id"));
    }

    @Test
    public void markReportedIsIdempotentForTheSameReportOnly() throws Exception {
        BesIncidentStore store = store();
        String key = addIncident(store, 1, 1000);
        assertFalse(store.markReported(key, ""));
        assertTrue(store.markReported(key, "rep_1"));
        assertEquals("REPORTED", store.find(key).getString("state"));
        assertTrue(store.markReported(key, "rep_1"));
        assertFalse(store.markReported(key, "rep_2"));
        assertEquals("rep_1", store.findByReportId("rep_1").getString("reportId"));
        assertNull(store.findByReportId("rep_2"));
        assertFalse(store.markReported("nope-dump-00000001-00000001", "rep_1"));
    }

    @Test
    public void uploadedOnlyFollowsReportedAndIsIdempotent() throws Exception {
        BesIncidentStore store = store();
        String key = addIncident(store, 1, 1000);
        assertFalse(store.markUploaded(key)); // STORED: Cloud never confirmed a report
        assertTrue(store.markReported(key, "rep_1"));
        assertEquals(1, store.pendingForPhone().size());
        assertTrue(store.markUploaded(key));
        assertTrue(store.markUploaded(key));
        assertEquals("UPLOADED", store.find(key).getString("state"));
        assertTrue(store.find(key).getBoolean("uploaded"));
        assertTrue(store.pendingForPhone().isEmpty());
        assertTrue(store.markReported(key, "rep_1"));
        assertFalse(store.markReported(key, "rep_2"));
    }

    @Test
    public void pendingForPhoneIsOldestFirstAndSkipsOtherStates() throws Exception {
        BesIncidentStore store = store();
        String k3 = addIncident(store, 3, 1000);
        String k1 = addIncident(store, 1, 1000);
        String k2 = addIncident(store, 2, 1000);
        store.markReported(k2, "rep_2");
        store.markUploaded(k2);
        List<JSONObject> pending = store.pendingForPhone();
        assertEquals(2, pending.size());
        assertEquals(k1, pending.get(0).getString("incidentKey"));
        assertEquals(k3, pending.get(1).getString("incidentKey"));
    }

    @Test
    public void artifactIsRecordedOnceAndFrozenByAttempt() throws Exception {
        BesIncidentStore store = store();
        String key = addIncident(store, 1, 1000);
        assertFalse(store.markAttempted(key, BesIncident.ARTIFACT_FULL)); // nothing built yet
        assertTrue(store.recordArtifact(key, BesIncident.ARTIFACT_FULL, sha(), 123));
        assertTrue(store.recordArtifact(key, BesIncident.ARTIFACT_FULL, sha(), 123));
        assertFalse(store.recordArtifact(key, BesIncident.ARTIFACT_FULL, "cd".repeat(32), 123));
        assertFalse(store.recordArtifact(key, BesIncident.ARTIFACT_FULL, sha(), 124));
        assertFalse(store.recordArtifact(key, "glasses_firmware:other", sha(), 1));
        JSONObject full = store.find(key).getJSONObject("artifacts")
                .getJSONObject(BesIncident.ARTIFACT_FULL);
        assertEquals(sha(), full.getString("sha256"));
        assertEquals(123, full.getLong("bytes"));
        assertFalse(full.getBoolean("attempted"));
        assertTrue(store.markAttempted(key, BesIncident.ARTIFACT_FULL));
        assertTrue(store.markAttempted(key, BesIncident.ARTIFACT_FULL));
        assertTrue(store.find(key).getJSONObject("artifacts")
                .getJSONObject(BesIncident.ARTIFACT_FULL).getBoolean("attempted"));
        assertFalse(store.find(key).getJSONObject("artifacts")
                .getJSONObject(BesIncident.ARTIFACT_RELAY).getBoolean("attempted"));
    }

    // --------------------------------------------------------------- budget

    @Test
    public void overBudgetTrimsTraceOfUnattemptedIncidentsOldestFirstBeforeEvicting()
            throws Exception {
        BesIncidentStore store = store();
        String newest = null;
        for (int n = 1; n <= 10; n++) { // 10 x 900 KiB against the 8 MiB budget
            newest = addIncident(store, n, S);
            store.enforceBudget(newest);
        }
        assertTrue(store.totalBytes() <= AsgConstants.BES_INCIDENT_DIR_BUDGET_BYTES);
        assertEquals(0, store.evictionSummary().getInt("count"));
        assertEquals(10, store.all().size());

        JSONObject oldest = store.all().get(0);
        String oldestKey = oldest.getString("incidentKey");
        assertTrue(oldest.optBoolean("traceTrimmed"));
        long trimmedSize = store.traceFile(oldestKey).length();
        assertTrue(trimmedSize >= AsgConstants.BES_INCIDENT_TRACE_TRIM_FLOOR_BYTES - 100);
        assertTrue(trimmedSize < S);
        // The newest lines survive and the record's window follows the kept lines.
        String kept = BesIncidentStore.readText(store.traceFile(oldestKey));
        assertTrue(kept.endsWith("\n"));
        long firstWall = Long.parseLong(kept.substring(0, kept.indexOf('\t')));
        assertEquals(firstWall, oldest.getLong("coveredFromMs"));
        // The newest bundle is untouched.
        assertEquals(S, store.traceFile(newest).length(), 100);
    }

    @Test
    public void trimNeverTouchesIncidentsWithAnAttemptedArtifactAndEvictsInstead() throws Exception {
        BesIncidentStore store = store();
        String[] keys = new String[12];
        for (int n = 1; n <= 11; n++) {
            keys[n] = addIncident(store, n, S);
            // Incidents 1..10 had their upload attempted: their bytes are immutable.
            if (n <= 10) {
                assertTrue(store.recordArtifact(keys[n], BesIncident.ARTIFACT_RELAY, sha(), 10));
                assertTrue(store.markAttempted(keys[n], BesIncident.ARTIFACT_RELAY));
                try (FileOutputStream out = new FileOutputStream(
                        new File(store.bundleDir(keys[n]), BesIncident.FILE_UPLOAD_RELAY))) {
                    out.write("body".getBytes(StandardCharsets.UTF_8));
                }
            }
            store.enforceBudget(keys[n]);
        }
        assertTrue(store.totalBytes() <= AsgConstants.BES_INCIDENT_DIR_BUDGET_BYTES);
        // With every older bundle attempted, only the new one could be trimmed, which was not
        // enough: the oldest not-uploaded bundle was dropped.
        assertNull(store.find(keys[1]));
        assertNotNull(store.bundleDir(keys[2]));
        for (int n = 2; n <= 10; n++) {
            assertEquals(S, store.traceFile(keys[n]).length(), 100);
            assertEquals("body", BesIncidentStore.readText(
                    new File(store.bundleDir(keys[n]), BesIncident.FILE_UPLOAD_RELAY)));
            assertFalse(store.find(keys[n]).optBoolean("traceTrimmed"));
        }
        assertTrue(store.find(keys[11]).optBoolean("traceTrimmed"));
        JSONObject evictions = store.evictionSummary();
        assertEquals(1, evictions.getInt("count"));
        JSONObject entry = evictions.getJSONArray("recent").getJSONObject(0);
        assertEquals(keys[1], entry.getString("incidentKey"));
        assertEquals("budget", entry.getString("reason"));
        assertTrue(entry.getLong("bytes") >= S);
        assertEquals(T0, entry.getLong("ms"));
    }

    @Test
    public void evictedIncidentIsNeverUploaded() throws Exception {
        BesIncidentStore store = store();
        String key = addIncident(store, 1, 1000);
        assertTrue(store.markReported(key, "rep_1"));
        store.evict(key, "budget", true);
        assertNull(store.find(key));
        assertNull(store.bundleDir(key));
        assertNull(store.findByReportId("rep_1"));
        assertFalse(store.markUploaded(key));
        assertFalse(store.markReported(key, "rep_1"));
        assertFalse(store.recordArtifact(key, BesIncident.ARTIFACT_FULL, sha(), 1));
        assertTrue(store.pendingForPhone().isEmpty());
        // The dump stays remembered, so the BES's still-saved dump does not come back.
        assertTrue(store.isDumpCollected("00000001-00000001"));
    }

    @Test
    public void anEvictedReportIsRememberedAcrossRestartsAndBounded() throws Exception {
        BesIncidentStore store = store();
        String key = addIncident(store, 1, 1000);
        assertTrue(store.markReported(key, "rep_1"));
        assertFalse(store.isRetiredReport("rep_1"));

        store.evict(key, "budget", true);

        assertNull(store.findByReportId("rep_1"));
        assertTrue(store.isRetiredReport("rep_1"));
        assertFalse(store.isRetiredReport("rep_other"));
        assertTrue(store().isRetiredReport("rep_1")); // a new store over the same directory

        // The memory is bounded and keeps the newest.
        for (int n = 2; n <= AsgConstants.BES_INCIDENT_RETIRED_REPORT_RING + 5; n++) {
            String next = addIncident(store, n, 1000);
            assertTrue(store.markReported(next, "rep_" + n));
            store.evict(next, "budget", true);
        }
        assertFalse(store.isRetiredReport("rep_1"));
        assertTrue(store.isRetiredReport("rep_" + (AsgConstants.BES_INCIDENT_RETIRED_REPORT_RING + 5)));
    }

    @Test
    public void evictionRecordKeepsTheLatestSixteenAndATotalCount() throws Exception {
        BesIncidentStore store = store();
        for (int n = 1; n <= 20; n++) {
            mNow.set(T0 + n);
            String key = addIncident(store, n, 1000);
            store.evict(key, "budget", true);
        }
        JSONObject summary = store.evictionSummary();
        assertEquals(20, summary.getInt("count"));
        assertEquals(AsgConstants.BES_INCIDENT_EVICTION_RING, summary.getJSONArray("recent").length());
        assertEquals(T0 + 5, summary.getJSONArray("recent").getJSONObject(0).getLong("ms"));
        assertEquals(T0 + 20, summary.getJSONArray("recent").getJSONObject(15).getLong("ms"));
        // The file itself stays small however many incidents were evicted.
        assertTrue(new File(mRoot, "evictions.json").length() < 4096);
        assertEquals(20, new BesIncidentStore(mRoot, mNow::get, () -> mSerial, () -> "x")
                .evictionSummary().getInt("count"));
    }

    @Test
    public void metadataDoesNotGrowWithoutBound() throws Exception {
        BesIncidentStore store = store();
        for (int n = 1; n <= 80; n++) {
            String key = addIncident(store, n, 200);
            if (n % 2 == 0) {
                store.markReported(key, "rep_" + n);
                store.markUploaded(key);
            }
            store.enforceBudget(key);
        }
        assertTrue(store.all().size() <= AsgConstants.BES_INCIDENT_MAX_BUNDLES);
        // Uploaded bundles went first, then (40 pending > 32) the oldest pending ones.
        assertTrue(store.evictionSummary().getInt("count") > 0);
        // The dedupe rings are bounded too.
        for (int n = 1; n <= 200; n++) {
            store.markDumpCollected(String.format("%08x-%08x", n, n));
            store.markResetObserved(String.format("%016x", n));
        }
        assertTrue(new File(mRoot, "collected.json").length() < 8192);
        assertTrue(store.isDumpCollected(String.format("%08x-%08x", 200, 200)));
        assertFalse(store.isDumpCollected(String.format("%08x-%08x", 1, 1)));
    }

    @Test
    public void uploadedBundlePayloadIsDroppedBeforeAnythingElseUnderPressure() throws Exception {
        BesIncidentStore store = store();
        String uploaded = addIncident(store, 1, 6 * MIB);
        store.markReported(uploaded, "rep_1");
        store.markUploaded(uploaded);
        String pending = addIncident(store, 2, 3 * MIB);
        store.enforceBudget(pending);
        assertTrue(store.totalBytes() <= AsgConstants.BES_INCIDENT_DIR_BUDGET_BYTES);
        assertFalse(store.traceFile(uploaded).exists());
        assertEquals("UPLOADED", store.find(uploaded).getString("state"));
        assertEquals(3 * MIB, store.traceFile(pending).length(), 100);
        assertFalse(store.find(pending).optBoolean("traceTrimmed"));
        assertEquals(0, store.evictionSummary().getInt("count"));
    }

    @Test
    public void trimmingDropsBuiltButUnattemptedUploadBodies() throws Exception {
        BesIncidentStore store = store();
        String old = addIncident(store, 1, 5 * MIB);
        assertTrue(store.recordArtifact(old, BesIncident.ARTIFACT_FULL, sha(), 5));
        File body = new File(store.bundleDir(old), BesIncident.FILE_UPLOAD_FULL);
        try (FileOutputStream out = new FileOutputStream(body)) {
            out.write("built".getBytes(StandardCharsets.UTF_8));
        }
        String next = addIncident(store, 2, 5 * MIB);
        store.enforceBudget(next);
        assertFalse(body.exists());
        JSONObject artifact = store.find(old).getJSONObject("artifacts")
                .getJSONObject(BesIncident.ARTIFACT_FULL);
        assertTrue(artifact.isNull("sha256"));
        assertFalse(store.markAttempted(old, BesIncident.ARTIFACT_FULL));
    }

    // ---------------------------------------------------- atomic write recovery

    @Test
    public void interruptedRecordWriteLeavesTheOldRecordAndRecoverCleansUp() throws Exception {
        BesIncidentStore store = store();
        String key = addIncident(store, 1, 1000);
        JSONObject before = store.find(key);
        // A crash after the temporary file was started but before the rename.
        File dir = store.bundleDir(key);
        try (FileOutputStream out = new FileOutputStream(new File(dir, "incident.json.tmp"))) {
            out.write("{\"v\":1,\"incidentKey\":\"trunc".getBytes(StandardCharsets.UTF_8));
        }
        try (FileOutputStream out = new FileOutputStream(new File(mRoot, "last_boot.tmp"))) {
            out.write("0000".getBytes(StandardCharsets.UTF_8));
        }
        // A bundle whose record was never written (crash while creating it).
        File orphan = new File(mRoot, "ML395018B-dump-00000009-00000009");
        assertTrue(orphan.mkdirs());
        try (FileOutputStream out = new FileOutputStream(new File(orphan, "trace.txt"))) {
            out.write("x".getBytes(StandardCharsets.UTF_8));
        }

        BesIncidentStore restarted = store();
        assertEquals(before.toString(), restarted.find(key).toString());
        assertNull(restarted.lastBoot());
        restarted.recover();
        assertFalse(new File(dir, "incident.json.tmp").exists());
        assertFalse(new File(mRoot, "last_boot.tmp").exists());
        assertFalse(orphan.exists());
        assertEquals(before.toString(), restarted.find(key).toString());
        assertEquals(1, restarted.all().size());
    }

    @Test
    public void successfulWriteLeavesNoTemporaryFile() throws Exception {
        BesIncidentStore store = store();
        String key = addIncident(store, 1, 1000);
        assertTrue(store.markReported(key, "rep_1"));
        assertTrue(store.saveLastBoot(BesIncidentTestSupport.BOOT_A));
        for (File f : store.bundleDir(key).listFiles()) {
            assertFalse(f.getName(), f.getName().endsWith(".tmp"));
        }
        for (File f : mRoot.listFiles()) {
            assertFalse(f.getName(), f.getName().endsWith(".tmp"));
        }
        assertEquals(BesIncidentTestSupport.BOOT_A, store.lastBoot());
        assertNotNull(new BesIncidentStore(mRoot, mNow::get, () -> mSerial, () -> "x").find(key));
    }
}
