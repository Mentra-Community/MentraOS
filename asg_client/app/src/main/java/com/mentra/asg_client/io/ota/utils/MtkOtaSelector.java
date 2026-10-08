package com.mentra.asg_client.io.ota.utils;

import com.mentra.asg_client.AsgConstants;
import org.json.JSONArray;
import org.json.JSONObject;

/** One selection policy for MTK step planning, ordering, and installation. */
public final class MtkOtaSelector {
    private MtkOtaSelector() {}

    /** Prefer an exact-base delta; a full OTA is eligible only for a known older version. */
    public static JSONObject select(JSONObject manifest, String currentVersion) {
        return select(manifest, currentVersion, null);
    }

    /** Inline ADB input keeps the requested full destination while reusing normal update eligibility. */
    public static JSONObject selectForTarget(JSONObject manifest, String currentVersion) {
        JSONObject full = manifest.optJSONObject("mtk_full_ota");
        String target = full == null ? "" : normalize(full.optString("end_firmware"));
        if (!target.matches("[0-9]{8}(\\.[0-9]{1,9})?")) return null;
        return select(manifest, currentVersion, target);
    }

    private static JSONObject select(JSONObject manifest, String currentVersion, String target) {
        String current = normalize(currentVersion);
        if (current.isEmpty() || current.equals(target)
                || target != null && !current.matches("[0-9]{8}(\\.[0-9]{1,9})?")) return null;
        JSONArray patches = manifest.optJSONArray("mtk_patches");
        if (patches != null) {
            for (int i = 0; i < patches.length(); i++) {
                JSONObject patch = patches.optJSONObject(i);
                if (patch != null && current.equals(normalize(patch.optString("start_firmware")))
                        && (target == null || target.equals(normalize(patch.optString("end_firmware"))))) {
                    return patch;
                }
            }
        }
        JSONObject full = manifest.optJSONObject("mtk_full_ota");
        if (full == null || !(full.opt("end_firmware") instanceof String)
                || !isNewer((String) full.opt("end_firmware"), current)) return null;
        long size = full.optLong("size", 0);
        if (full.has("start_firmware")
                || !(full.opt("size") instanceof Integer || full.opt("size") instanceof Long)
                || !full.optString("url").matches("https?://[^/\\s]+/.*")
                || !full.optString("sha256").matches("[a-fA-F0-9]{64}")
                || size <= 0 || size > AsgConstants.MTK_OTA_MAX_DOWNLOAD_BYTES) return null;
        return full;
    }

    /** Compare date and numeric revision; legacy date-only versions have revision zero. */
    public static boolean isNewer(String targetVersion, String currentVersion) {
        String target = normalize(targetVersion);
        String current = normalize(currentVersion);
        if (!target.matches("[0-9]{8}(\\.[0-9]{1,9})?")
                || !current.matches("[0-9]{8}(\\.[0-9]{1,9})?")) return false;
        String[] targetParts = target.split("\\.");
        String[] currentParts = current.split("\\.");
        int dateComparison = targetParts[0].compareTo(currentParts[0]);
        if (dateComparison != 0) return dateComparison > 0;
        long targetRevision = targetParts.length == 2 ? Long.parseLong(targetParts[1]) : 0;
        long currentRevision = currentParts.length == 2 ? Long.parseLong(currentParts[1]) : 0;
        return targetRevision > currentRevision;
    }

    /** Firmware properties and release entries may use the same model prefix differently. */
    public static boolean isSameVersion(String first, String second) {
        String normalized = normalize(first);
        return !normalized.isEmpty() && normalized.equals(normalize(second));
    }

    private static String normalize(String version) {
        if (version == null) return "";
        String trimmed = version.trim();
        return trimmed.substring(trimmed.lastIndexOf('_') + 1);
    }
}
