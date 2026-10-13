package com.mentra.asg_client.io.bes.log;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Persisted full/relay bodies, retry identity and the UPLOADED rules of an incident upload. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesIncidentUploaderTest {
    static final String KEY = "ML395018B-dump-0000002a-1f2e3d4c";
    static final String REPORT = "rep_01JZWY3V8N0F2E9GQ4T6KXH5RD";

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private FileBackedBesIncidentAccess access;
    private BesIncidentUploader uploader;

    @Before
    public void setUp() throws Exception {
        access = new FileBackedBesIncidentAccess(tmp.newFolder("bes_incident"));
        uploader = new BesIncidentUploader(() -> access);
        access.createStored(KEY, 1000L, "[CRASH-CONTEXT] v=2 seq=1\nline two\n\nline three\n", trace(5));
        assertThat(access.markReported(KEY, REPORT)).isTrue();
    }

    static String trace(int lines) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < lines; i++) {
            text.append(1759999000000L + i).append('\t').append(1).append('\t')
                    .append(Integer.toHexString(i * 16)).append('\t').append("trace line ").append(i)
                    .append('\n');
        }
        return text.toString();
    }

    private static JSONArray entries(byte[] body) throws Exception {
        return new JSONObject(new String(body, StandardCharsets.UTF_8)).getJSONArray("entries");
    }

    @Test
    public void fullAndRelayBodiesAreDistinctPersistedAndRecorded() throws Exception {
        BesIncidentUploader.Prepared full = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL);
        BesIncidentUploader.Prepared relay = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_RELAY);

        assertThat(full).isNotNull();
        assertThat(relay).isNotNull();
        assertThat(full.bytes).isNotEqualTo(relay.bytes);
        assertThat(full.file.getName()).isEqualTo("upload-full.json");
        assertThat(relay.file.getName()).isEqualTo("upload-relay.json");
        assertThat(Files.readAllBytes(full.file.toPath())).isEqualTo(full.bytes);
        assertThat(Files.readAllBytes(relay.file.toPath())).isEqualTo(relay.bytes);

        JSONObject fullJson = new JSONObject(new String(full.bytes, StandardCharsets.UTF_8));
        assertThat(fullJson.getString("source")).isEqualTo("glasses_firmware");
        assertThat(fullJson.getString("retryKey")).isEqualTo("glasses_firmware:full");
        JSONObject relayJson = new JSONObject(new String(relay.bytes, StandardCharsets.UTF_8));
        assertThat(relayJson.getString("retryKey")).isEqualTo("glasses_firmware:relay");

        JSONObject artifacts = access.find(KEY).getJSONObject("artifacts");
        for (BesIncidentUploader.Prepared p : new BesIncidentUploader.Prepared[] {full, relay}) {
            JSONObject recorded = artifacts.getJSONObject(p.artifactKey);
            assertThat(recorded.getString("sha256")).isEqualTo(BesIncidentUploader.sha256(p.bytes));
            assertThat(recorded.getLong("bytes")).isEqualTo(p.bytes.length);
            assertThat(recorded.getBoolean("attempted")).isTrue();
        }
    }

    @Test
    public void dumpLinesComeFirstThenTrace() throws Exception {
        JSONArray entries = entries(uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL).bytes);

        assertThat(entries.length()).isEqualTo(3 + 5); // blank dump line skipped
        for (int i = 0; i < 3; i++) {
            assertThat(entries.getJSONObject(i).getString("source")).isEqualTo("BES_CRASH");
        }
        assertThat(entries.getJSONObject(0).getString("message")).isEqualTo("[CRASH-CONTEXT] v=2 seq=1");
        for (int i = 3; i < 8; i++) {
            assertThat(entries.getJSONObject(i).getString("source")).isEqualTo("BES");
        }
        assertThat(entries.getJSONObject(3).getString("message")).isEqualTo("trace line 0");
        assertThat(entries.getJSONObject(3).getLong("timestamp")).isEqualTo(1759999000000L);
        assertThat(entries.getJSONObject(0).getLong("timestamp")).isEqualTo(1760000000000L);
    }

    @Test
    public void retryReusesPersistedBytesAndRecordsOnce() throws Exception {
        byte[] first = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL).bytes;
        byte[] second = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL).bytes;
        byte[] third = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL).bytes;

        assertThat(second).isEqualTo(first);
        assertThat(third).isEqualTo(first);
        assertThat(access.recordArtifactCalls).isEqualTo(1);
        assertThat(access.markAttemptedCalls).isEqualTo(1);
    }

    @Test
    public void retryAfterEvictionOfTheSourcesNeverRebuilds() throws Exception {
        BesIncidentUploader.Prepared first = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL);
        access.evictSources(KEY);

        BesIncidentUploader.Prepared retry = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL);

        assertThat(retry).isNotNull();
        assertThat(retry.bytes).isEqualTo(first.bytes);
        assertThat(retry.sha256).isEqualTo(first.sha256);
        assertThat(access.recordArtifactCalls).isEqualTo(1);
    }

    @Test
    public void changedSourcesNeverChangeAnAttemptedBody() throws Exception {
        BesIncidentUploader.Prepared first = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_RELAY);
        Files.write(
                new File(access.bundleDir(KEY), "trace.txt").toPath(),
                trace(50).getBytes(StandardCharsets.UTF_8));

        assertThat(uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_RELAY).bytes).isEqualTo(first.bytes);
    }

    @Test
    public void lostOrCorruptedBodyAfterAnAttemptIsNeverRebuilt() throws Exception {
        BesIncidentUploader.Prepared first = uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL);

        assertThat(first.file.delete()).isTrue();
        assertThat(uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL)).isNull();
        assertThat(first.file).doesNotExist();

        Files.write(first.file.toPath(), "{\"tampered\":true}".getBytes(StandardCharsets.UTF_8));
        assertThat(uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_FULL)).isNull();
    }

    @Test
    public void relayKeepsDumpFirstAndTrimsTheTraceToItsCap() throws Exception {
        int lines = 4000; // ~ 60 KB of trace text, far over the 32 KiB relay cap
        access.createStored("ML395018B-dump-00000002-aaaaaaaa", 2000L, "dump one\ndump two\n", trace(lines));
        access.markReported("ML395018B-dump-00000002-aaaaaaaa", "rep_big");
        String key = "ML395018B-dump-00000002-aaaaaaaa";

        byte[] relay = uploader.prepare(key, BesIncidentUploader.ARTIFACT_RELAY).bytes;
        byte[] full = uploader.prepare(key, BesIncidentUploader.ARTIFACT_FULL).bytes;

        JSONArray relayEntries = entries(relay);
        assertThat(entries(full).length()).isEqualTo(2 + lines);
        assertThat(relayEntries.length()).isLessThan(2 + lines);
        assertThat(relayEntries.getJSONObject(0).getString("source")).isEqualTo("BES_CRASH");
        assertThat(relayEntries.getJSONObject(0).getString("message"))
                .startsWith("[RELAY-TRIMMED dump_lines=2/2 trace_lines=")
                .endsWith("dump one");
        assertThat(relayEntries.getJSONObject(1).getString("source")).isEqualTo("BES_CRASH");
        // Newest TRACE lines survive, oldest are dropped, order stays chronological.
        JSONObject last = relayEntries.getJSONObject(relayEntries.length() - 1);
        assertThat(last.getString("message")).isEqualTo("trace line " + (lines - 1));
        assertThat(relayEntries.getJSONObject(2).getString("message")).isNotEqualTo("trace line 0");
        long traceBytes = 0;
        for (int i = 2; i < relayEntries.length(); i++) {
            traceBytes += relayEntries.getJSONObject(i).getString("message").length();
        }
        assertThat(traceBytes).isLessThanOrEqualTo(BesLogManager.BLE_RELAY_FIRMWARE_MAX_BYTES);
    }

    @Test
    public void untrimmedRelayCarriesNoMarker() throws Exception {
        JSONArray entries = entries(uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_RELAY).bytes);

        assertThat(entries.getJSONObject(0).getString("message")).doesNotContain("RELAY-TRIMMED");
        assertThat(entries.length()).isEqualTo(8);
    }

    @Test
    public void relayDumpIsCappedAt80KbAndStillFirst() throws Exception {
        StringBuilder dump = new StringBuilder();
        for (int i = 0; i < 3000; i++) {
            dump.append("dump line ").append(i).append(" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n");
        }
        String key = "ML395018B-dump-00000003-bbbbbbbb";
        access.createStored(key, 3000L, dump.toString(), trace(3));
        access.markReported(key, "rep_dump_cap");

        JSONArray entries = entries(uploader.prepare(key, BesIncidentUploader.ARTIFACT_RELAY).bytes);

        assertThat(entries.getJSONObject(0).getString("source")).isEqualTo("BES_CRASH");
        assertThat(entries.getJSONObject(0).getString("message")).startsWith("[RELAY-TRIMMED");
        int dumpEntries = 0;
        long dumpBytes = 0;
        while (dumpEntries < entries.length()
                && "BES_CRASH".equals(entries.getJSONObject(dumpEntries).getString("source"))) {
            dumpBytes += entries.getJSONObject(dumpEntries).getString("message").length();
            dumpEntries++;
        }
        assertThat(dumpBytes).isLessThanOrEqualTo(80 * 1024 + 120);
        assertThat(dumpEntries).isLessThan(3000);
        assertThat(entries.getJSONObject(dumpEntries).getString("source")).isEqualTo("BES");
    }

    @Test
    public void uploadedOnlyOnHttp2xx() throws Exception {
        List<Boolean> seenAttempted = new ArrayList<>();
        BesIncidentUploader.HttpPoster fail500 = (url, token, body) -> 500;
        BesIncidentUploader.HttpPoster fail409 = (url, token, body) -> 409;
        BesIncidentUploader.HttpPoster io =
                (url, token, body) -> {
                    throw new IOException("offline");
                };
        BesIncidentUploader.HttpPoster ok =
                (url, token, body) -> {
                    try {
                        seenAttempted.add(
                                access.find(KEY).getJSONObject("artifacts")
                                        .getJSONObject("glasses_firmware:full")
                                        .getBoolean("attempted"));
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                    return 204;
                };

        assertThat(uploader.uploadOverHttp(KEY, "u", "t", fail500)).isFalse();
        assertThat(uploader.uploadOverHttp(KEY, "u", "t", fail409)).isFalse();
        assertThat(uploader.uploadOverHttp(KEY, "u", "t", io)).isFalse();
        assertThat(access.find(KEY).getString("state")).isEqualTo("REPORTED");
        assertThat(access.find(KEY).getBoolean("uploaded")).isFalse();

        assertThat(uploader.uploadOverHttp(KEY, "u", "t", ok)).isTrue();
        assertThat(access.find(KEY).getString("state")).isEqualTo("UPLOADED");
        assertThat(access.find(KEY).getBoolean("uploaded")).isTrue();
        assertThat(seenAttempted).containsExactly(true); // marked before the send
    }

    @Test
    public void everyRetrySendsTheSameBytes() throws Exception {
        List<byte[]> bodies = new ArrayList<>();
        BesIncidentUploader.HttpPoster flaky =
                (url, token, body) -> {
                    bodies.add(body);
                    return bodies.size() < 3 ? 503 : 200;
                };

        uploader.uploadOverHttp(KEY, "u", "t", flaky);
        access.evictSources(KEY);
        uploader.uploadOverHttp(KEY, "u", "t", flaky);
        uploader.uploadOverHttp(KEY, "u", "t", flaky);

        assertThat(bodies).hasSize(3);
        assertThat(bodies.get(1)).isEqualTo(bodies.get(0));
        assertThat(bodies.get(2)).isEqualTo(bodies.get(0));
        assertThat(access.find(KEY).getString("state")).isEqualTo("UPLOADED");
    }

    @Test
    public void missingBundleOrNonPendingStateNeverUploads() throws Exception {
        String empty = "ML395018B-reset-00000000000000aa";
        access.createStored(empty, 500L, null, null);
        access.markReported(empty, "rep_empty");
        boolean[] called = {false};
        BesIncidentUploader.HttpPoster poster =
                (url, token, body) -> {
                    called[0] = true;
                    return 200;
                };

        assertThat(uploader.uploadOverHttp(empty, "u", "t", poster)).isFalse();
        assertThat(uploader.uploadOverHttp("unknown-key", "u", "t", poster)).isFalse();
        access.createStored("evicted-key", 600L, "d\n", trace(1));
        access.markReported("evicted-key", "rep_evicted");
        access.evict("evicted-key");
        assertThat(uploader.uploadOverHttp("evicted-key", "u", "t", poster)).isFalse();

        assertThat(called[0]).isFalse();
        assertThat(access.find(empty).getString("state")).isEqualTo("REPORTED");
        assertThat(new File(access.bundleDir(empty), "upload-full.json")).doesNotExist();
    }

    @Test
    public void transferCompleteSuccessForTheRelayFileMarksUploaded() throws Exception {
        uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_RELAY);
        String file = BesIncidentUploader.relayFileBaseName(REPORT);

        assertThat(file).startsWith("B").hasSize(16);
        assertThat(uploader.onTransferComplete(file, false)).isNull();
        assertThat(access.find(KEY).getString("state")).isEqualTo("REPORTED");
        assertThat(uploader.onTransferComplete("L" + file.substring(1), true)).isNull();
        assertThat(uploader.onTransferComplete("Bzzzzzzzzzzzzzzz", true)).isNull();
        assertThat(uploader.onTransferComplete("photo.jpg", true)).isNull();
        assertThat(access.find(KEY).getString("state")).isEqualTo("REPORTED");

        assertThat(uploader.onTransferComplete(file + ".json", true)).isEqualTo(KEY);
        assertThat(access.find(KEY).getString("state")).isEqualTo("UPLOADED");
        assertThat(uploader.onTransferComplete(file, true)).isNull(); // nothing pending any more
    }

    @Test
    public void transferCompleteBeforeAnyRelayAttemptDoesNothing() throws Exception {
        assertThat(uploader.onTransferComplete(BesIncidentUploader.relayFileBaseName(REPORT), true))
                .isNull();
        assertThat(access.find(KEY).getString("state")).isEqualTo("REPORTED");
    }

    @Test
    public void aSecondReportWithTheSameRelayFileNameWaitsUntilTheFirstIsConfirmed() throws Exception {
        String otherKey = "ML395018B-dump-0000002b-1f2e3d4d";
        String otherReport = "rep_01JZWY3V8N0ZZZZZZZZZZZZZZZ";
        access.createStored(otherKey, 2000L, "[CRASH-CONTEXT] v=2 seq=2\nx\n", trace(5));
        assertThat(access.markReported(otherKey, otherReport)).isTrue();
        assertThat(BesIncidentUploader.relayFileBaseName(otherReport))
                .isEqualTo(BesIncidentUploader.relayFileBaseName(REPORT));

        assertThat(uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_RELAY)).isNotNull();
        // The first body is in flight under that name: the second is not admitted or attempted.
        assertThat(uploader.prepare(otherKey, BesIncidentUploader.ARTIFACT_RELAY)).isNull();
        assertThat(access.find(otherKey).getJSONObject("artifacts")
                .getJSONObject(BesIncidentUploader.ARTIFACT_RELAY).getBoolean("attempted")).isFalse();
        // Retrying the first is still allowed.
        assertThat(uploader.prepare(KEY, BesIncidentUploader.ARTIFACT_RELAY)).isNotNull();

        assertThat(uploader.onTransferComplete(BesIncidentUploader.relayFileBaseName(REPORT), true))
                .isEqualTo(KEY);
        assertThat(uploader.prepare(otherKey, BesIncidentUploader.ARTIFACT_RELAY)).isNotNull();
        assertThat(uploader.onTransferComplete(BesIncidentUploader.relayFileBaseName(otherReport), true))
                .isEqualTo(otherKey);
    }

    @Test
    public void transferCompleteIsNotAttributedWhenTwoAttemptedReportsShareTheRelayFileName() throws Exception {
        String otherKey = "ML395018B-dump-0000002b-1f2e3d4d";
        String otherReport = "rep_01JZWY3V8N0ZZZZZZZZZZZZZZZ";
        access.createStored(otherKey, 2000L, "[CRASH-CONTEXT] v=2 seq=2\nx\n", trace(5));
        assertThat(access.markReported(otherKey, otherReport)).isTrue();
        // Both were attempted before admission control existed.
        access.commitArtifact(KEY, BesIncidentUploader.ARTIFACT_RELAY, (dir, rec) -> new byte[] {1});
        access.commitArtifact(otherKey, BesIncidentUploader.ARTIFACT_RELAY, (dir, rec) -> new byte[] {2});

        assertThat(uploader.onTransferComplete(BesIncidentUploader.relayFileBaseName(REPORT), true))
                .isNull();
        assertThat(access.find(KEY).getString("state")).isEqualTo("REPORTED");
        assertThat(access.find(otherKey).getString("state")).isEqualTo("REPORTED");
    }
}
