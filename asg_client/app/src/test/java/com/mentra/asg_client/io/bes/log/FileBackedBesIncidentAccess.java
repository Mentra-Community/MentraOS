package com.mentra.asg_client.io.bes.log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.json.JSONObject;

/**
 * Small file-backed fake of {@link BesIncidentUploadAccess} for the upload side's tests: one
 * {@code <root>/<incidentKey>/incident.json} per incident, state transitions as in the OS-1988
 * contract, plus counters for the calls the upload side must make exactly once.
 */
public final class FileBackedBesIncidentAccess implements BesIncidentUploadAccess {
    private final File mRoot;
    public int recordArtifactCalls;
    public int markAttemptedCalls;

    public FileBackedBesIncidentAccess(File root) {
        mRoot = root;
        mRoot.mkdirs();
    }

    /** Creates a STORED dump incident with a bundle (dump.txt and trace.txt). */
    public synchronized JSONObject createStored(
            String incidentKey, long createdMs, String dumpText, String traceText) throws Exception {
        File dir = bundleDir(incidentKey);
        dir.mkdirs();
        if (dumpText != null) {
            write(new File(dir, "dump.txt"), dumpText);
        }
        if (traceText != null) {
            write(new File(dir, "trace.txt"), traceText);
        }
        JSONObject record = new JSONObject();
        record.put("v", 1);
        record.put("incidentKey", incidentKey);
        record.put("kind", "dump");
        record.put("reason", "bes_crash");
        record.put("state", "STORED");
        record.put("attribution", "match");
        record.put("bootId", "9f3a0c1b2d4e5f60");
        record.put("dumpId", "0000002a-1f2e3d4c");
        record.put("dumpLen", dumpText != null ? dumpText.length() : 0);
        record.put("resetHw", 0);
        record.put("resetSw", 0);
        record.put("crashUnixMs", 1760000000000L);
        record.put(
                "flags",
                new JSONObject()
                        .put("truncated", false)
                        .put("torn", false)
                        .put("tailCaptured", true)
                        .put("dumpGap", false));
        record.put("coveredFromMs", 1759998200000L);
        record.put("coveredToMs", 1760000000000L);
        record.put("traceGaps", 0);
        record.put("createdMs", createdMs);
        record.put("reportId", JSONObject.NULL);
        record.put(
                "artifacts",
                new JSONObject()
                        .put("glasses_firmware:full", emptyArtifact())
                        .put("glasses_firmware:relay", emptyArtifact()));
        record.put("uploaded", false);
        save(incidentKey, record);
        return new JSONObject(record.toString());
    }

    private static JSONObject emptyArtifact() throws Exception {
        return new JSONObject()
                .put("sha256", JSONObject.NULL)
                .put("bytes", 0)
                .put("attempted", false);
    }

    /** Simulates storage pressure: bundle sources gone, record state EVICTED. */
    public synchronized void evictSources(String incidentKey) {
        new File(bundleDir(incidentKey), "dump.txt").delete();
        new File(bundleDir(incidentKey), "trace.txt").delete();
    }

    public synchronized void evict(String incidentKey) throws Exception {
        evictSources(incidentKey);
        JSONObject record = load(incidentKey);
        record.put("state", "EVICTED");
        save(incidentKey, record);
    }

    @Override
    public synchronized JSONObject findByReportId(String reportId) {
        File[] dirs = mRoot.listFiles(File::isDirectory);
        if (dirs == null) {
            return null;
        }
        for (File dir : dirs) {
            JSONObject record = find(dir.getName());
            if (record != null
                    && !record.isNull("reportId")
                    && reportId.equals(record.optString("reportId"))) {
                return record;
            }
        }
        return null;
    }

    @Override
    public synchronized JSONObject find(String incidentKey) {
        try {
            JSONObject record = load(incidentKey);
            return record != null ? new JSONObject(record.toString()) : null;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public File bundleDir(String incidentKey) {
        return new File(mRoot, incidentKey);
    }

    @Override
    public synchronized List<JSONObject> pendingForPhone() {
        List<JSONObject> pending = new ArrayList<>();
        File[] dirs = mRoot.listFiles(File::isDirectory);
        if (dirs != null) {
            for (File dir : dirs) {
                JSONObject record = find(dir.getName());
                if (record != null
                        && !record.optBoolean("uploaded", false)
                        && ("STORED".equals(record.optString("state"))
                                || "REPORTED".equals(record.optString("state")))) {
                    pending.add(record);
                }
            }
        }
        pending.sort(Comparator.comparingLong(r -> r.optLong("createdMs")));
        return pending;
    }

    @Override
    public synchronized boolean markReported(String incidentKey, String reportId) {
        try {
            JSONObject record = load(incidentKey);
            if (record == null) {
                return false;
            }
            String state = record.optString("state");
            if (!record.isNull("reportId")) {
                return reportId.equals(record.optString("reportId"));
            }
            if (!"STORED".equals(state)) {
                return false;
            }
            record.put("state", "REPORTED");
            record.put("reportId", reportId);
            save(incidentKey, record);
            return true;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public synchronized boolean recordArtifact(
            String incidentKey, String artifactKey, String sha256, long bytes) {
        recordArtifactCalls++;
        try {
            JSONObject record = load(incidentKey);
            if (record == null) {
                return false;
            }
            JSONObject artifact = record.getJSONObject("artifacts").getJSONObject(artifactKey);
            if (!artifact.isNull("sha256")) {
                return sha256.equals(artifact.getString("sha256")) && bytes == artifact.getLong("bytes");
            }
            artifact.put("sha256", sha256);
            artifact.put("bytes", bytes);
            save(incidentKey, record);
            return true;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public synchronized boolean markAttempted(String incidentKey, String artifactKey) {
        markAttemptedCalls++;
        try {
            JSONObject record = load(incidentKey);
            if (record == null) {
                return false;
            }
            record.getJSONObject("artifacts").getJSONObject(artifactKey).put("attempted", true);
            save(incidentKey, record);
            return true;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public synchronized boolean markUploaded(String incidentKey) {
        try {
            JSONObject record = load(incidentKey);
            if (record == null) {
                return false;
            }
            String state = record.optString("state");
            if ("UPLOADED".equals(state)) {
                return true;
            }
            if (!"REPORTED".equals(state)) {
                return false;
            }
            record.put("state", "UPLOADED");
            record.put("uploaded", true);
            save(incidentKey, record);
            return true;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private JSONObject load(String incidentKey) throws Exception {
        File file = new File(bundleDir(incidentKey), "incident.json");
        if (!file.isFile()) {
            return null;
        }
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    private void save(String incidentKey, JSONObject record) throws IOException {
        File dir = bundleDir(incidentKey);
        File tmp = new File(dir, "incident.json.tmp");
        write(tmp, record.toString());
        if (!tmp.renameTo(new File(dir, "incident.json"))) {
            throw new IOException("rename failed");
        }
    }

    private static void write(File file, String text) throws IOException {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }
}
