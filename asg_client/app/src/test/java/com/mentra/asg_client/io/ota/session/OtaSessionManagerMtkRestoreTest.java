package com.mentra.asg_client.io.ota.session;

import static org.assertj.core.api.Assertions.assertThat;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;
import java.time.Duration;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaSessionManagerMtkRestoreTest {
    @Test public void originalSelectionSurvivesRestartAndDuplicateCannotReplaceIt() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaSessionManager original = new OtaSessionManager(context);
        String id = "firmware-" + "a".repeat(32), sha = "b".repeat(64);
        JSONObject patch = new JSONObject().put("start_firmware", "20260709")
                .put("end_firmware", "20260908.10").put("url", "https://cdn/patch.zip")
                .put("sha256", sha).put("size", 1024);
        assertThat(original.createMtkRestore(id, sha, patch, "20260709", "original-boot")).isTrue();
        assertThat(original.recordMtkRestoreDownload(1024)).isTrue();
        OtaSessionManager replacement = new OtaSessionManager(context);
        assertThat(replacement.getMtkRestoreReceipt().getString("artifact_id")).isEqualTo(id);
        assertThat(replacement.getMtkRestoreReceipt().getLong("downloaded_size")).isEqualTo(1024);
        ShadowSystemClock.advanceBy(Duration.ofMinutes(31));
        assertThat(replacement.hasActiveSession()).isTrue();
        assertThat(replacement.createSession(new String[]{"mtk"}, "https://cdn/other.json")).isFalse();
        assertThat(replacement.createMtkRestore(id, sha, patch, "20260709", "other-boot")).isFalse();
        replacement.setComplete();
        assertThat(replacement.createMtkRestore(id, sha, patch, "20260709", "other-boot")).isFalse();
        assertThat(new OtaSessionManager(context).getMtkRestoreReceipt().getString("source_boot_id")).isEqualTo("original-boot");
        assertThat(replacement.createMtkRestore("firmware-" + "c".repeat(32), sha, patch, "20260709", "next-boot")).isTrue();
    }

    @Test public void restartSettlesOnlyAbandonedTransfersAndObservedBootOutcomes() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        String id = "firmware-" + "a".repeat(32), sha = "b".repeat(64);
        JSONObject full = new JSONObject().put("end_firmware", "20260908.10").put("url", "https://cdn/full.zip").put("sha256", sha).put("size", 1024);
        OtaSessionManager first = new OtaSessionManager(context);
        assertThat(first.createMtkRestore(id, sha, full, "20260709", "original-boot")).isTrue();
        OtaSessionManager restarted = new OtaSessionManager(context);
        restarted.reconcileMtkRestore("20260709", "original-boot");
        assertThat(restarted.getStatus()).isEqualTo("failed");
        assertThat(restarted.getMtkRestoreReceipt().getString("artifact_id")).isEqualTo(id);
        assertThat(restarted.createMtkRestore(id, sha, full, "20260709", "original-boot")).isFalse();

        assertThat(restarted.createMtkRestore("firmware-" + "c".repeat(32), sha, full, "20260709", "original-boot")).isTrue();
        assertThat(restarted.markMtkInstallDispatched()).isTrue();
        restarted = new OtaSessionManager(context);
        restarted.reconcileMtkRestore("20260709", "original-boot");
        assertThat(restarted.hasActiveMtkRestore()).isTrue();
        assertThat(restarted.createSession(new String[]{"mtk"}, "https://cdn/other.json")).isFalse();
        restarted.reconcileMtkRestore("MentraLive_20260908.10", "new-boot");
        assertThat(new OtaSessionManager(context).getStatus()).isEqualTo("complete");

        assertThat(restarted.createMtkRestore("firmware-" + "d".repeat(32), sha, full, "20260709", "original-boot")).isTrue();
        assertThat(restarted.markMtkInstallDispatched()).isTrue();
        new OtaSessionManager(context).reconcileMtkRestore("20260709", "new-boot");
        assertThat(new OtaSessionManager(context).getStatus()).isEqualTo("failed");
    }

    @Test public void executingArtifactMustMatchEverySelectedPin() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        JSONObject full = new JSONObject().put("end_firmware", "20260908.10").put("url", "https://cdn/full.zip").put("sha256", "a".repeat(64)).put("size", 1024);
        OtaSessionManager session = new OtaSessionManager(context);
        assertThat(session.createMtkRestore("firmware-" + "b".repeat(32), "a".repeat(64), full, "20260709", "boot")).isTrue();
        assertThat(session.ownsMtkArtifact(full)).isTrue();
        for (String field : new String[]{"url", "sha256", "end_firmware", "start_firmware", "size"}) {
            JSONObject changed = new JSONObject(full.toString());
            changed.put(field, field.equals("size") ? 2048 : "different");
            assertThat(session.ownsMtkArtifact(changed)).as(field).isFalse();
        }
    }
}
