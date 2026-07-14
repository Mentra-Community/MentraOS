package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;

public class OtaManifestResolverTest {
    @Test
    public void leavesLegacyEmbeddedFirmwareUntouched() throws Exception {
        JSONObject manifest = new JSONObject().put("mtk_patches", "legacy");

        assertSame(
                manifest,
                OtaManifestResolver.resolveFirmware(
                        manifest,
                        ignored -> {
                            throw new AssertionError("fetch must not run");
                        }));
        assertEquals("legacy", manifest.getString("mtk_patches"));
    }

    @Test
    public void copiesOnlyFirmwareFieldsFromMutableManifest() throws Exception {
        JSONObject manifest =
                new JSONObject()
                        .put("firmwareManifestUrl", "https://example.test/firmware.json")
                        .put("apps", new JSONObject().put("pinned", true));

        OtaManifestResolver.resolveFirmware(
                manifest,
                url ->
                        "{\"apps\":{\"wrong\":true},\"remediation\":{\"wrong\":true},"
                                + "\"mtk_patches\":[{\"name\":\"latest\"}],"
                                + "\"bes_firmware\":{\"version\":\"latest\"}}");

        assertEquals("latest", manifest.getJSONArray("mtk_patches").getJSONObject(0).getString("name"));
        assertEquals("latest", manifest.getJSONObject("bes_firmware").getString("version"));
        assertEquals(true, manifest.getJSONObject("apps").getBoolean("pinned"));
        assertFalse(manifest.has("remediation"));
    }

    @Test
    public void rejectsIncompleteReferencedFirmware() throws Exception {
        JSONObject manifest =
                new JSONObject().put("firmwareManifestUrl", "https://example.test/firmware.json");

        assertThrows(
                Exception.class,
                () -> OtaManifestResolver.resolveFirmware(manifest, ignored -> "{\"mtk_patches\":[]}"));
    }
}
