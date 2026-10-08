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
}
