package com.mentra.asg_client.io.bes.log;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import java.io.File;
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

/** bes_crash_detected content and the resend-until-UPLOADED rule. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesIncidentNotifierTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private File root;
    private FileBackedBesIncidentAccess access;
    private BesIncidentNotifier notifier;
    private final List<JSONObject> sent = new ArrayList<>();
    private boolean linkUp = true;

    @Before
    public void setUp() throws Exception {
        root = tmp.newFolder("bes_incident");
        access = new FileBackedBesIncidentAccess(root);
        notifier = new BesIncidentNotifier(() -> access);
        notifier.setSender(
                message -> {
                    if (linkUp) {
                        sent.add(message);
                    }
                    return linkUp;
                });
    }

    @Test
    public void detectedMessageFollowsTheContract() throws Exception {
        access.createStored("k1", 100L, "d\n", "1\t1\t0\tx\n");
        JSONArray recent =
                new JSONArray()
                        .put(new JSONObject().put("incidentKey", "old").put("reason", "budget"));
        notifier.setEvictionSummarySupplier(() -> new BesIncidentNotifier.EvictionSummary(3, recent));

        notifier.notifyDetected("k1");

        assertThat(sent).hasSize(1);
        JSONObject m = sent.get(0);
        assertThat(m.getString("type")).isEqualTo("bes_crash_detected");
        assertThat(m.getString("incidentKey")).isEqualTo("k1");
        assertThat(m.getString("reason")).isEqualTo("bes_crash");
        assertThat(m.getString("state")).isEqualTo("STORED");
        assertThat(m.isNull("reportId")).isTrue();
        JSONObject s = m.getJSONObject("summary");
        assertThat(s.getString("attribution")).isEqualTo("match");
        assertThat(s.getString("dumpId")).isEqualTo("0000002a-1f2e3d4c");
        assertThat(s.getString("bootId")).isEqualTo("9f3a0c1b2d4e5f60");
        assertThat(s.getLong("crashUnixMs")).isEqualTo(1760000000000L);
        assertThat(s.getLong("coveredFromMs")).isEqualTo(1759998200000L);
        assertThat(s.getLong("coveredToMs")).isEqualTo(1760000000000L);
        assertThat(s.getInt("traceGaps")).isZero();
        assertThat(s.getBoolean("truncated")).isFalse();
        assertThat(s.getBoolean("tailCaptured")).isTrue();
        assertThat(s.getBoolean("dumpGap")).isFalse();
        assertThat(s.getLong("evictedCount")).isEqualTo(3);
        assertThat(s.getJSONArray("recentEvictions").getJSONObject(0).getString("incidentKey"))
                .isEqualTo("old");
    }

    @Test
    public void evictionsFileIsUsedWithoutASupplier() throws Exception {
        access.createStored("k1", 100L, "d\n", null);
        Files.write(
                new File(root, "evictions.json").toPath(),
                "{\"count\":7,\"recent\":[{\"incidentKey\":\"e1\",\"reason\":\"budget\",\"bytes\":9,\"ms\":1}]}"
                        .getBytes(StandardCharsets.UTF_8));

        notifier.notifyDetected("k1");

        JSONObject s = sent.get(0).getJSONObject("summary");
        assertThat(s.getLong("evictedCount")).isEqualTo(7);
        assertThat(s.getJSONArray("recentEvictions").length()).isEqualTo(1);
    }

    @Test
    public void reportedIncidentCarriesItsReportId() throws Exception {
        access.createStored("k1", 100L, "d\n", null);
        access.markReported("k1", "rep_1");

        notifier.resendPending();

        assertThat(sent.get(0).getString("state")).isEqualTo("REPORTED");
        assertThat(sent.get(0).getString("reportId")).isEqualTo("rep_1");
    }

    @Test
    public void resendPendingRepeatsUntilUploadedOldestFirst() throws Exception {
        access.createStored("newer", 200L, "d\n", null);
        access.createStored("older", 100L, "d\n", null);
        access.createStored("done", 50L, "d\n", null);
        access.markReported("done", "rep_done");
        access.markUploaded("done");
        access.createStored("evicted", 60L, "d\n", null);
        access.evict("evicted");

        notifier.resendPending();
        notifier.resendPending();

        assertThat(keys()).containsExactly("older", "newer", "older", "newer");

        access.markReported("older", "rep_older");
        notifier.resendPending();
        assertThat(keys()).hasSize(6);

        access.markUploaded("older");
        notifier.resendPending();
        assertThat(keys().subList(6, keys().size())).containsExactly("newer");
    }

    @Test
    public void failedSendStopsAndNextPhoneReadyTriesAgain() throws Exception {
        access.createStored("a", 100L, "d\n", null);
        access.createStored("b", 200L, "d\n", null);
        linkUp = false;

        notifier.resendPending();
        assertThat(sent).isEmpty();

        linkUp = true;
        notifier.resendPending();
        assertThat(keys()).containsExactly("a", "b");
    }

    @Test
    public void notifyDetectedIgnoresUnknownUploadedAndSenderlessCases() throws Exception {
        access.createStored("k1", 100L, "d\n", null);
        notifier.notifyDetected("unknown");
        access.markReported("k1", "rep_1");
        access.markUploaded("k1");
        notifier.notifyDetected("k1");
        assertThat(sent).isEmpty();

        access.createStored("k2", 100L, "d\n", null);
        BesIncidentNotifier noSender = new BesIncidentNotifier(() -> access);
        noSender.notifyDetected("k2"); // must not throw
        new BesIncidentNotifier(() -> null).resendPending(); // no store yet: no-op
    }

    private List<String> keys() throws Exception {
        List<String> keys = new ArrayList<>();
        for (JSONObject m : sent) {
            keys.add(m.getString("incidentKey"));
        }
        return keys;
    }
}
