package com.mentra.asg_client.reporting.incidentlogs;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.AsgClientApplication;
import com.mentra.asg_client.reporting.core.ReportLevel;
import com.mentra.asg_client.reporting.core.ReportManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * Durable on-disk queue for incident log payloads.
 *
 * <p>When the phone sends {@code upload_incident_logs} over BLE, the command handler
 * captures logcat immediately and persists it here. A WorkManager job
 * ({@link IncidentLogUploadWorker}) later drains the queue when WiFi is available.</p>
 *
 * <p>Files are plain JSON (human-readable, ADB-pullable) stored in internal app storage.
 * Size, count, and TTL caps prevent unbounded growth.</p>
 */
public class PendingIncidentLogStore {

  private static final String TAG = "PendingIncidentLogStore";
  private static final String PENDING_DIR = "incident_logs_pending";
  private static final String SEPARATOR = "__";
  private static final String EXTENSION = ".json";
  private static final String TMP_SUFFIX = ".tmp";

  /** Max bytes per pending file (500 KB). */
  static final int MAX_FILE_BYTES = 500 * 1024;
  /** Max total bytes across all pending files (5 MB). */
  static final long MAX_TOTAL_BYTES = 5L * 1024 * 1024;
  /** Max number of pending files. */
  static final int MAX_FILE_COUNT = 5;
  /** Pending files older than this are expired (3 days). */
  static final long TTL_MS = 3L * 24 * 60 * 60 * 1000;
  /** Clock-skew guard: delete files with createdAt more than 60 s in the future. */
  private static final long FUTURE_TOLERANCE_MS = 60_000;

  private final File mPendingDir;

  public PendingIncidentLogStore(Context context) {
    mPendingDir = new File(context.getFilesDir(), PENDING_DIR);
    if (!mPendingDir.exists()) {
      mPendingDir.mkdirs();
    }
  }

  // -------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------

  /**
   * Capture a log payload to disk atomically.
   *
   * <p>If the serialized file would exceed {@link #MAX_FILE_BYTES}, the oldest log
   * lines are dropped and a synthetic truncation marker is inserted.</p>
   *
   * <p>After writing, {@link #sweep()} runs to enforce caps.</p>
   *
   * @param incidentId incident to attach logs to
   * @param source     "glasses" or "glasses_firmware"
   * @param logs       JSON array of log entries from GlassesLogBuffer or BesLogManager
   * @return the written file, or null on I/O failure
   */
  public File enqueue(String incidentId, String source, JSONArray logs) {
    try {
      // Build the payload that will be POSTed verbatim
      JSONObject payload = new JSONObject();
      payload.put("source", source);
      payload.put("logs", logs);

      // Build the wrapper with metadata
      long now = System.currentTimeMillis();
      JSONObject wrapper = new JSONObject();
      wrapper.put("incidentId", incidentId);
      wrapper.put("source", source);
      wrapper.put("createdAt", now);
      wrapper.put("attempts", 0);
      wrapper.put("lastAttemptAt", 0);
      wrapper.put("lastError", JSONObject.NULL);
      wrapper.put("payload", payload);

      byte[] jsonBytes = wrapper.toString().getBytes(StandardCharsets.UTF_8);

      // Truncate oldest log lines if over per-file cap
      if (jsonBytes.length > MAX_FILE_BYTES) {
        int originalCount = logs.length();
        while (jsonBytes.length > MAX_FILE_BYTES && logs.length() > 1) {
          logs.remove(0);
          payload.put("logs", logs);
          wrapper.put("payload", payload);
          jsonBytes = wrapper.toString().getBytes(StandardCharsets.UTF_8);
        }
        int dropped = originalCount - logs.length();
        if (dropped > 0) {
          // Insert synthetic marker at the front
          JSONObject marker = new JSONObject();
          marker.put("timestamp", now);
          marker.put("level", "warn");
          marker.put("message", "[truncated " + dropped + " oldest lines due to size cap]");
          marker.put("source", "PendingIncidentLogStore");

          JSONArray truncated = new JSONArray();
          truncated.put(marker);
          for (int i = 0; i < logs.length(); i++) {
            truncated.put(logs.get(i));
          }
          payload.put("logs", truncated);
          wrapper.put("payload", payload);
          jsonBytes = wrapper.toString().getBytes(StandardCharsets.UTF_8);

          Log.w(TAG, "Truncated " + dropped + " lines for incident " + incidentId
              + " (final size: " + jsonBytes.length + " bytes)");
          breadcrumb("incident_log.truncated",
              "Truncated " + dropped + " lines, final=" + jsonBytes.length + " bytes"
              + ", incidentId=" + incidentId);
        }
      }

      // Atomic write: tmp -> fsync -> rename
      String fileName = incidentId + SEPARATOR + source + EXTENSION;
      File tmpFile = new File(mPendingDir, fileName + TMP_SUFFIX);
      File finalFile = new File(mPendingDir, fileName);

      FileOutputStream fos = new FileOutputStream(tmpFile);
      fos.write(jsonBytes);
      fos.getFD().sync();
      fos.close();

      if (!tmpFile.renameTo(finalFile)) {
        Log.e(TAG, "Failed to rename tmp file to " + finalFile.getAbsolutePath());
        tmpFile.delete();
        return null;
      }

      Log.i(TAG, "Queued incident logs: " + fileName + " (" + jsonBytes.length + " bytes)");
      breadcrumb("incident_log.enqueued",
          "incidentId=" + incidentId + ", source=" + source
          + ", bytes=" + jsonBytes.length + ", totalPending=" + countPending());

      // Enforce caps after writing
      sweep();

      return finalFile;
    } catch (Exception e) {
      Log.e(TAG, "Failed to enqueue incident logs for " + incidentId, e);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // List / Load / Update / Delete
  // -------------------------------------------------------------------------

  /**
   * List all pending files, newest-first by createdAt.
   */
  public List<File> listPending() {
    File[] files = mPendingDir.listFiles((dir, name) -> name.endsWith(EXTENSION));
    if (files == null || files.length == 0) {
      return new ArrayList<>();
    }

    // Sort newest-first by last modified (proxy for createdAt without parsing every file)
    Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
    return new ArrayList<>(Arrays.asList(files));
  }

  /**
   * Parse a pending file into a {@link PendingIncidentLog}.
   * Returns null and deletes the file if it cannot be parsed.
   */
  public PendingIncidentLog load(File file) {
    try {
      byte[] bytes = readFileBytes(file);
      String json = new String(bytes, StandardCharsets.UTF_8);
      JSONObject wrapper = new JSONObject(json);

      return new PendingIncidentLog(
          wrapper.getString("incidentId"),
          wrapper.getString("source"),
          wrapper.getLong("createdAt"),
          wrapper.getInt("attempts"),
          wrapper.optLong("lastAttemptAt", 0),
          wrapper.isNull("lastError") ? null : wrapper.optString("lastError"),
          wrapper.getJSONObject("payload")
      );
    } catch (Exception e) {
      Log.e(TAG, "Failed to parse pending file " + file.getName() + " — deleting", e);
      deleteWithReason(file, "parse_failure");
      return null;
    }
  }

  /**
   * Update attempt metadata on a pending file after a failed upload.
   */
  public void recordAttempt(File file, int attempts, long lastAttemptAt, String lastError) {
    try {
      byte[] bytes = readFileBytes(file);
      String json = new String(bytes, StandardCharsets.UTF_8);
      JSONObject wrapper = new JSONObject(json);
      wrapper.put("attempts", attempts);
      wrapper.put("lastAttemptAt", lastAttemptAt);
      wrapper.put("lastError", lastError != null ? lastError : JSONObject.NULL);

      byte[] updated = wrapper.toString().getBytes(StandardCharsets.UTF_8);

      // Atomic rewrite
      File tmpFile = new File(mPendingDir, file.getName() + TMP_SUFFIX);
      FileOutputStream fos = new FileOutputStream(tmpFile);
      fos.write(updated);
      fos.getFD().sync();
      fos.close();
      tmpFile.renameTo(file);
    } catch (Exception e) {
      Log.e(TAG, "Failed to record attempt on " + file.getName(), e);
    }
  }

  /**
   * Delete a pending file and log a Sentry breadcrumb with the reason.
   *
   * @param file   the file to delete
   * @param reason why (e.g. "uploaded", "http_404", "ttl_expired", "parse_failure")
   */
  public void deleteWithReason(File file, String reason) {
    String fileName = file.getName();
    long ageMs = System.currentTimeMillis() - file.lastModified();

    // Extract incidentId from filename (avoid calling load() which calls deleteWithReason on failure)
    String incidentId = "unknown";
    try {
      int sepIdx = fileName.indexOf(SEPARATOR);
      if (sepIdx > 0) {
        incidentId = fileName.substring(0, sepIdx);
      }
    } catch (Exception ignored) {
      // Best-effort metadata extraction
    }

    boolean deleted = file.delete();
    if (deleted) {
      Log.i(TAG, "Deleted pending file: " + fileName + " reason=" + reason);
    } else {
      Log.w(TAG, "Failed to delete pending file: " + fileName);
    }

    breadcrumb("incident_log.purged",
        "incidentId=" + incidentId + ", reason=" + reason + ", ageMs=" + ageMs);
  }

  // -------------------------------------------------------------------------
  // Sweep: TTL + cap enforcement
  // -------------------------------------------------------------------------

  /**
   * Enforce TTL, size cap, and count cap. Called from {@link #enqueue} and
   * from the upload worker before draining.
   */
  public void sweep() {
    File[] files = mPendingDir.listFiles((dir, name) -> name.endsWith(EXTENSION));
    if (files == null || files.length == 0) return;

    long now = System.currentTimeMillis();

    // Pass 1: delete expired and future-timestamped files
    List<File> remaining = new ArrayList<>();
    for (File file : files) {
      long lastModified = file.lastModified();
      if (lastModified > now + FUTURE_TOLERANCE_MS) {
        Log.w(TAG, "Deleting future-timestamped file: " + file.getName());
        deleteFileQuietly(file, "future_timestamp");
      } else if (lastModified < now - TTL_MS) {
        Log.w(TAG, "Deleting TTL-expired file: " + file.getName());
        deleteFileQuietly(file, "ttl_expired");
      } else {
        remaining.add(file);
      }
    }

    // Sort oldest-first for cap enforcement (we purge oldest)
    remaining.sort(Comparator.comparingLong(File::lastModified));

    // Pass 2: enforce count cap
    while (remaining.size() > MAX_FILE_COUNT) {
      File oldest = remaining.remove(0);
      Log.w(TAG, "Deleting over count cap: " + oldest.getName());
      deleteFileQuietly(oldest, "count_cap");
    }

    // Pass 3: enforce size cap
    long totalBytes = 0;
    for (File f : remaining) {
      totalBytes += f.length();
    }
    while (totalBytes > MAX_TOTAL_BYTES && !remaining.isEmpty()) {
      File oldest = remaining.remove(0);
      totalBytes -= oldest.length();
      Log.w(TAG, "Deleting over size cap: " + oldest.getName());
      deleteFileQuietly(oldest, "size_cap");
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private int countPending() {
    File[] files = mPendingDir.listFiles((dir, name) -> name.endsWith(EXTENSION));
    return files != null ? files.length : 0;
  }

  private void deleteFileQuietly(File file, String reason) {
    String fileName = file.getName();
    long ageMs = System.currentTimeMillis() - file.lastModified();
    file.delete();
    breadcrumb("incident_log.purged",
        "file=" + fileName + ", reason=" + reason + ", ageMs=" + ageMs);
  }

  private static byte[] readFileBytes(File file) throws IOException {
    FileInputStream fis = new FileInputStream(file);
    byte[] bytes = new byte[(int) file.length()];
    int read = 0;
    while (read < bytes.length) {
      int n = fis.read(bytes, read, bytes.length - read);
      if (n == -1) break;
      read += n;
    }
    fis.close();
    return bytes;
  }

  private void breadcrumb(String category, String message) {
    try {
      AsgClientApplication app = AsgClientApplication.getInstance();
      if (app != null) {
        app.getReportManager().addBreadcrumb(message, category, ReportLevel.INFO);
      }
    } catch (Exception ignored) {
      // Breadcrumbs are best-effort
    }
  }
}
