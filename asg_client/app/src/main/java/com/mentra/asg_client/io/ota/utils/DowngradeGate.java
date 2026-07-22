package com.mentra.asg_client.io.ota.utils;

/**
 * Decides whether an OTA manifest app entry requests a logical ASG downgrade.
 *
 * <p>Downgrades are strictly opt-in per manifest via {@code "allowDowngrade": true} on the app
 * entry. Only SDK-pinned manifests (which pin one exact ASG artifact) set the flag; the shared
 * fleet manifests never do, so a device pointed at the fleet manifest can never be pulled
 * backwards by it. Targets below the downgrade floor are refused even when pinned: builds older
 * than the floor predate the downgrade-safe contract (media storage layout, post-uninstall
 * behavior), mirroring how the fixed-versionCode design only reaches builds published under its
 * scheme.
 */
public final class DowngradeGate {
    private DowngradeGate() {}

    /**
     * @param installedVersion installed ASG versionCode
     * @param manifestVersion pinned versionCode from the manifest app entry
     * @param allowDowngrade the app entry's explicit {@code allowDowngrade} opt-in
     * @param floorVersion oldest supported downgrade target
     *     ({@link OtaConstants#DOWNGRADE_FLOOR_VERSION_CODE})
     */
    public static boolean shouldDowngrade(
            long installedVersion, long manifestVersion, boolean allowDowngrade, long floorVersion) {
        return allowDowngrade
                && manifestVersion > 0
                && manifestVersion >= floorVersion
                && installedVersion > manifestVersion;
    }
}
