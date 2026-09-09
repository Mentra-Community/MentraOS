package com.mentra.asg_client.io.ota.interfaces;

import androidx.annotation.Nullable;
import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator.ValidatedBesArtifact;
import org.json.JSONObject;

/**
 * Operations on the BES coprocessor OTA subsystem. Implemented by the vendor-specific OTA manager
 * (e.g. {@code BesOtaManager} on Mentra Live); core code interacts with BES firmware updates only
 * through this interface.
 */
public interface IBesOtaController {

    /**
     * @return true if a BES OTA update is currently in progress
     */
    boolean isBesOtaInProgress();

    /**
     * Get the current firmware version reported by the BES device.
     *
     * @return version bytes [major, minor, patch, build], or null if not yet known
     */
    @Nullable
    byte[] getCurrentFirmwareVersion();

    /**
     * Parse a server-supplied version code into the byte format used for comparison.
     *
     * @param versionCode long version code from the server (XYYYZZZ format)
     * @return byte array [major, minor, patch, build]
     */
    byte[] parseServerVersionCode(long versionCode);

    /**
     * Compare two firmware version byte arrays.
     *
     * @param v1 candidate version
     * @param v2 reference version
     * @return true if v1 is newer than v2
     */
    boolean isNewerVersion(byte[] v1, byte[] v2);

    /**
     * Begin a firmware update.
     *
     * @param artifact fully validated immutable release artifact
     * @param ownerSessionId top-level OTA session that owns the durable BES transaction
     * @return true if the update was started successfully
     */
    boolean startFirmwareUpdate(ValidatedBesArtifact artifact, String ownerSessionId);

    /**
     * Begin a phone-controlled firmware update, writing the install status to the companion path
     * immediately before BES authorization in the same ordered transport action.
     */
    boolean startFirmwareUpdateWithInstallGuard(
            ValidatedBesArtifact artifact, String ownerSessionId, JSONObject installGuard);

    /** Authoritative BES OTA projection, or null when no durable BES transaction exists. */
    @Nullable
    JSONObject getAuthoritativeStatus();

    /** Apply terminal retirement/restart rules before a new top-level OTA session is admitted. */
    boolean prepareForNewOtaSession();

    /** Called by the MCU event subscriber when BES authorizes the update. */
    void onAuthorizationGranted();

    /** Called by the MCU event subscriber when BES denies the update. */
    void onAuthorizationDenied();
}
