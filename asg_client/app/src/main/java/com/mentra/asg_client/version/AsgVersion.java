package com.mentra.asg_client.version;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.BuildConfig;
import org.json.JSONObject;

/** Canonical logical ASG release version helpers. */
public final class AsgVersion {
    public static final String MANIFEST_KEY = "com.mentra.asg_client.ASG_VERSION";
    public static final String MANIFEST_PREFIX = "asg-";

    private AsgVersion() {}

    /** Logical version compiled into the running ASG APK. */
    public static long current() {
        return BuildConfig.ASG_VERSION;
    }

    /**
     * Read the logical version from installed/archive package metadata. Legacy APKs fall back to
     * their Android versionCode, which used the same modified-epoch sequence.
     */
    public static long fromPackageInfo(PackageInfo info) {
        if (info == null) {
            return -1L;
        }
        long metadataVersion = fromApplicationInfo(info.applicationInfo);
        return metadataVersion > 0
                ? metadataVersion
                : legacyLogicalVersion(androidVersionCode(info));
    }

    public static long fromApplicationInfo(ApplicationInfo info) {
        if (info == null) {
            return -1L;
        }
        Bundle metadata = info.metaData;
        if (metadata == null) {
            return -1L;
        }
        return parseMetadataValue(metadata.get(MANIFEST_KEY));
    }

    static long parseMetadataValue(Object value) {
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        if (!(value instanceof String)) {
            return -1L;
        }
        String raw = ((String) value).trim();
        if (raw.startsWith(MANIFEST_PREFIX)) {
            raw = raw.substring(MANIFEST_PREFIX.length());
        }
        try {
            long parsed = Long.parseLong(raw);
            return parsed > 0 ? parsed : -1L;
        } catch (NumberFormatException ignored) {
            return -1L;
        }
    }

    /** Read a target logical version, falling back only to a legacy logical versionCode. */
    public static long fromManifestApp(JSONObject appInfo) {
        if (appInfo == null) {
            return -1L;
        }
        long logical = appInfo.optLong("asgVersion", -1L);
        return logical > 0
                ? logical
                : legacyLogicalVersion(appInfo.optLong("versionCode", -1L));
    }

    public static boolean requiresInstall(long installed, long target) {
        return installed <= 0 || target <= 0 || installed != target;
    }

    public static boolean isDowngrade(long installed, long target) {
        return installed > 0 && target > 0 && target < installed;
    }

    private static long androidVersionCode(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.getLongVersionCode();
        }
        return info.versionCode;
    }

    private static long legacyLogicalVersion(long versionCode) {
        if (versionCode <= 0
                || versionCode == AsgConstants.ASG_ANDROID_TRANSPORT_VERSION_CODE) {
            return -1L;
        }
        return versionCode;
    }
}
