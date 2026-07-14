package com.mentra.asg_client.io.ota.utils;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Resolves mutable MTK/BES firmware data referenced by an immutable ASG manifest. */
public final class OtaManifestResolver {
    public interface JsonFetcher {
        String fetch(String url) throws Exception;
    }

    private OtaManifestResolver() {}

    /**
     * Copies only firmware fields from {@code firmwareManifestUrl}. App pins and remediation
     * policy always remain owned by the original manifest.
     */
    public static JSONObject resolveFirmware(JSONObject manifest, JsonFetcher fetcher)
            throws Exception {
        String firmwareUrl = manifest.optString("firmwareManifestUrl", "").trim();
        if (firmwareUrl.isEmpty()) {
            return manifest;
        }

        JSONObject firmware = new JSONObject(fetcher.fetch(firmwareUrl));
        JSONArray mtkPatches = firmware.optJSONArray("mtk_patches");
        JSONObject besFirmware = firmware.optJSONObject("bes_firmware");
        if (mtkPatches == null || mtkPatches.length() == 0 || besFirmware == null) {
            throw new JSONException(
                    "Referenced firmware manifest must include non-empty mtk_patches and bes_firmware");
        }

        manifest.put("mtk_patches", mtkPatches);
        manifest.put("bes_firmware", besFirmware);
        return manifest;
    }
}
