package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperInlineMtkTest {
    @Test public void inlineRequestUsesSharedDownloadAndRetainsItsOriginalSource() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        OtaHelper original = new OtaHelper(context, mock(IBesOtaRegistry.class)), helper = spy(original);
        try {
            doReturn("20260709").when(helper).readMtkSourceVersion();
            doReturn("11111111-1111-4111-8111-111111111111").when(helper).readMtkSourceBoot();
            doReturn(false).when(helper).downloadMtkFirmware(anyString(), any(), any());
            String sha = "a".repeat(64), id = "firmware-" + "b".repeat(32);
            JSONObject full = new JSONObject().put("end_firmware", "20260908.10").put("url", "https://cdn/full.zip").put("sha256", sha).put("size", 1024);
            JSONObject patch = new JSONObject().put("start_firmware", "20260709").put("end_firmware", "20260908.10")
                    .put("url", "https://cdn/delta.zip").put("sha256", sha).put("size", 512);
            String manifest = new JSONObject().put("mtk_full_ota", full).put("mtk_patches", new JSONArray().put(patch)).toString();
            assertThat(helper.startValidatedDebugMtkFirmware(manifest, id)).isTrue();
            verify(helper, times(1)).downloadMtkFirmware(eq("https://cdn/delta.zip"), any(), eq(context));
            assertThat(helper.getSessionManager().getMtkRestoreReceipt().getString("source_version")).isEqualTo("20260709");
            assertThat(helper.getSessionManager().getMtkRestoreReceipt().getString("artifact_id")).isEqualTo(id);
            assertThat(helper.getSessionManager().getStatus()).isEqualTo("failed");
            assertThat(helper.startValidatedDebugMtkFirmware(manifest, id)).isFalse();
            verify(helper, times(1)).downloadMtkFirmware(anyString(), any(), any());
        } finally {helper.cleanup(); original.cleanup(); OtaHelper.setMtkOtaInProgress(false); OtaHelper.clearMtkSessionFlag();}
    }
}
