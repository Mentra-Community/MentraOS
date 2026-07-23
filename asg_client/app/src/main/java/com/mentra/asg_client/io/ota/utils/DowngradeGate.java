package com.mentra.asg_client.io.ota.utils;

/**
 * Decides whether an OTA manifest app entry requests a logical ASG downgrade.
 *
 * <p>Every manifest the glasses act on is phone-supplied and pins one exact ASG artifact
 * (ota_start's manifest URL is mandatory and there is no baked fallback), so any pinned version
 * that differs from the installed build is actionable in either direction — no per-manifest
 * opt-in flag is needed. Targets below the downgrade floor are refused even when pinned: builds
 * older than the floor predate the downgrade-safe contract (media storage layout, post-uninstall
 * behavior), mirroring how the fixed-versionCode design only reaches builds published under its
 * scheme.
 */
public final class DowngradeGate {
    private DowngradeGate() {}

    /**
     * @param installedVersion installed ASG versionCode
     * @param manifestVersion pinned versionCode from the manifest app entry
     * @param floorVersion oldest supported downgrade target
     *     ({@link OtaConstants#DOWNGRADE_FLOOR_VERSION_CODE})
     */
    public static boolean shouldDowngrade(
            long installedVersion, long manifestVersion, long floorVersion) {
        return manifestVersion > 0
                && manifestVersion >= floorVersion
                && installedVersion > manifestVersion;
    }
}
