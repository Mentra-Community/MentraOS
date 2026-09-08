package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class MtkOtaSelectorTest {
    private JSONObject full() throws Exception {
        return new JSONObject().put("end_firmware", "MentraLive_20260908.10")
                .put("url", "https://cdn/full.zip").put("sha256", "a".repeat(64))
                .put("size", 640341205);
    }

    @Test public void deltaWinsOtherwiseFullIsUpgradeOnly() throws Exception {
        JSONObject full = full();
        JSONObject delta = new JSONObject().put("start_firmware", "20260709")
                .put("end_firmware", "20260908.10");
        JSONObject manifest = new JSONObject().put("mtk_full_ota", full)
                .put("mtk_patches", new JSONArray().put(delta));
        assertSame(delta, MtkOtaSelector.select(manifest, "MentraLive_20260709"));
        assertSame(full, MtkOtaSelector.select(manifest, "20260908.9"));
        assertSame(full, MtkOtaSelector.select(manifest, "20260907.20"));
        for (String current : new String[]{null, "", "unknown", "20260908.10", "20260908.11", "20260909"}) {
            assertNull(MtkOtaSelector.select(manifest, current));
        }
        assertFalse(MtkOtaSelector.isNewer("20260908.0", "20260908"));
    }

    @Test public void fullOnlyAndMissingMetadataFailClosed() throws Exception {
        JSONObject full = full();
        JSONObject manifest = new JSONObject().put("mtk_full_ota", full);
        assertSame(full, MtkOtaSelector.select(manifest, "20260709"));
        for (String key : new String[]{"end_firmware", "url", "sha256", "size"}) {
            JSONObject invalid = full();
            invalid.remove(key);
            assertNull(MtkOtaSelector.select(new JSONObject().put("mtk_full_ota", invalid), "20260709"));
        }
        full.put("size", 2L * 1024 * 1024 * 1024);
        assertNull(MtkOtaSelector.select(manifest, "20260709"));
        assertNull(MtkOtaSelector.select(new JSONObject(), "20260709"));
    }
}
