package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaManifestUrlResolutionTest {
    @Test
    public void resolvesRelativeArtifactsAgainstManifestUrl() throws Exception {
        JSONObject manifest =
                new JSONObject()
                        .put(
                                "apps",
                                new JSONObject()
                                        .put(
                                                "com.mentra.asg_client",
                                                new JSONObject()
                                                        .put("apkUrl", "artifacts/asg.apk")))
                        .put(
                                "mtk_patches",
                                new JSONArray()
                                        .put(new JSONObject().put("url", "./artifacts/mtk.zip")))
                        .put("bes_firmware", new JSONObject().put("url", "../shared/bes.bin"));

        JSONObject resolved =
                OtaHelper.resolveArtifactUrls(
                        manifest, "https://updates.example.com/releases/v1/version.json");

        assertThat(
                        resolved.getJSONObject("apps")
                                .getJSONObject("com.mentra.asg_client")
                                .getString("apkUrl"))
                .isEqualTo("https://updates.example.com/releases/v1/artifacts/asg.apk");
        assertThat(resolved.getJSONArray("mtk_patches").getJSONObject(0).getString("url"))
                .isEqualTo("https://updates.example.com/releases/v1/artifacts/mtk.zip");
        assertThat(resolved.getJSONObject("bes_firmware").getString("url"))
                .isEqualTo("https://updates.example.com/releases/shared/bes.bin");
    }

    @Test
    public void preservesAbsoluteArtifactUrls() throws Exception {
        JSONObject manifest =
                new JSONObject()
                        .put(
                                "apps",
                                new JSONObject()
                                        .put(
                                                "com.mentra.asg_client",
                                                new JSONObject()
                                                        .put(
                                                                "apkUrl",
                                                                "https://cdn.example.com/asg.apk")));

        JSONObject resolved =
                OtaHelper.resolveArtifactUrls(
                        manifest, "https://updates.example.com/releases/v1/version.json");

        assertThat(
                        resolved.getJSONObject("apps")
                                .getJSONObject("com.mentra.asg_client")
                                .getString("apkUrl"))
                .isEqualTo("https://cdn.example.com/asg.apk");
    }

    @Test
    public void rejectsNonHttpArtifactUrls() throws Exception {
        JSONObject manifest =
                new JSONObject()
                        .put(
                                "apps",
                                new JSONObject()
                                        .put(
                                                "com.mentra.asg_client",
                                                new JSONObject()
                                                        .put("apkUrl", "file:///tmp/asg.apk")));

        assertThatThrownBy(
                        () ->
                                OtaHelper.resolveArtifactUrls(
                                        manifest,
                                        "https://updates.example.com/releases/v1/version.json"))
                .hasMessageContaining("must resolve to HTTP(S)");
    }
}
