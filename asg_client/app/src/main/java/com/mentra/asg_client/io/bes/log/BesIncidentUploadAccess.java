package com.mentra.asg_client.io.bes.log;

import java.io.File;
import java.util.List;
import org.json.JSONObject;

/** Incident bundle access used by the upload and phone-notification side. Records are
 *  the incident.json objects from the OS-1988 contract. All methods are thread-safe. */
public interface BesIncidentUploadAccess {
    /** Record for the incident whose persisted reportId equals reportId, or null. */
    JSONObject findByReportId(String reportId);

    /** True when the incident of this report existed here but its bundle was evicted or deleted
     *  (bounded memory). Such a report has no BES data to upload, and must not be given the
     *  current BES log instead. */
    boolean isRetiredReport(String reportId);

    JSONObject find(String incidentKey);

    File bundleDir(String incidentKey);

    /** Incidents in STORED or REPORTED that are not uploaded, oldest first. */
    List<JSONObject> pendingForPhone();

    /** STORED -> REPORTED with the reportId; idempotent for the same reportId, false for a
     *  different one or an unknown/evicted incident. Persists before returning. */
    boolean markReported(String incidentKey, String reportId);

    /** Records the first-built representation (artifactKey is "glasses_firmware:full" or
     *  "glasses_firmware:relay"): sha256 and byte count, once. A second call with different
     *  values returns false and changes nothing. */
    boolean recordArtifact(String incidentKey, String artifactKey, String sha256, long bytes);

    /** Builds an upload body from the bundle sources. */
    interface ArtifactBuilder {
        /** Returns the body, or null when the bundle has nothing to upload. */
        byte[] build(File bundleDir, JSONObject record) throws java.io.IOException;
    }

    /**
     * Builds, persists, records and attempt-marks an upload body as one step that no trim,
     * eviction or budget pass can interleave with. The body file is written into the bundle, its
     * sha256/bytes recorded (an already recorded hash must be reproduced) and the artifact marked
     * attempted, then the storage budget is enforced with this incident protected. Returns the
     * persisted bytes, or null when the incident is gone, the builder yields nothing, the hash
     * differs from the recorded one, or the incident did not survive the budget.
     */
    byte[] commitArtifact(String incidentKey, String artifactKey, ArtifactBuilder builder);

    /** Sets attempted=true for the artifact; its body file is immutable from now on. */
    boolean markAttempted(String incidentKey, String artifactKey);

    /** REPORTED -> UPLOADED, only after Cloud confirmed. Idempotent. */
    boolean markUploaded(String incidentKey);
}
