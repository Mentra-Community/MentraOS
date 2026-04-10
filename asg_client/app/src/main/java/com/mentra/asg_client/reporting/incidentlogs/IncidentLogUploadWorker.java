package com.mentra.asg_client.reporting.incidentlogs;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.mentra.asg_client.AsgClientApplication;
import com.mentra.asg_client.reporting.core.ReportLevel;
import com.mentra.asg_client.reporting.core.ReportManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.utils.ServerConfigUtil;

import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * WorkManager worker that drains the pending incident log queue.
 *
 * <p>Runs when network is available (constraint: {@code NetworkType.CONNECTED}).
 * Iterates all pending files newest-first, attempts upload for each, and
 * deletes on success or permanent failure. Retries on transient failure
 * with exponential backoff.</p>
 *
 * <p>Permanent failures (4xx): file is deleted, will not retry.<br>
 * Transient failures (5xx, IOException): file is retained, worker returns RETRY.</p>
 */
public class IncidentLogUploadWorker extends Worker {

  private static final String TAG = "IncidentLogUploadWrkr";

  private static final MediaType JSON_MEDIA_TYPE =
      MediaType.parse("application/json; charset=utf-8");

  /** Stop retrying after this many attempts per file. */
  private static final int MAX_ATTEMPTS = 20;

  private final PendingIncidentLogStore mStore;

  public IncidentLogUploadWorker(@NonNull Context context,
                                  @NonNull WorkerParameters params) {
    super(context, params);
    mStore = new PendingIncidentLogStore(context);
  }

  @NonNull
  @Override
  public Result doWork() {
    Log.i(TAG, "Starting incident log upload drain");

    // Sweep TTL/caps before attempting anything
    mStore.sweep();

    List<File> files = mStore.listPending();
    if (files.isEmpty()) {
      Log.d(TAG, "No pending incident logs to upload");
      return Result.success();
    }

    Log.i(TAG, "Found " + files.size() + " pending incident log(s)");

    boolean transientFailureSeen = false;

    for (File file : files) {
      PendingIncidentLog pending = mStore.load(file);
      if (pending == null) {
        // load() already deleted corrupt file
        continue;
      }

      if (pending.attempts >= MAX_ATTEMPTS) {
        Log.w(TAG, "Max attempts exceeded for " + pending.incidentId + " — deleting");
        mStore.deleteWithReason(file, "max_attempts_exceeded");
        continue;
      }

      UploadResult result = uploadOnce(pending);

      switch (result.outcome) {
        case SUCCESS:
          breadcrumb("incident_log.upload_success",
              "incidentId=" + pending.incidentId
              + ", attempt=" + (pending.attempts + 1)
              + ", ageMs=" + (System.currentTimeMillis() - pending.createdAt));
          mStore.deleteWithReason(file, "uploaded");
          break;

        case PERMANENT_FAILURE:
          breadcrumb("incident_log.upload_permanent_failure",
              "incidentId=" + pending.incidentId
              + ", reason=" + result.reason
              + ", attempt=" + (pending.attempts + 1)
              + ", ageMs=" + (System.currentTimeMillis() - pending.createdAt));
          mStore.deleteWithReason(file, result.reason);
          break;

        case TRANSIENT_FAILURE:
          breadcrumb("incident_log.upload_transient_failure",
              "incidentId=" + pending.incidentId
              + ", reason=" + result.reason
              + ", attempt=" + (pending.attempts + 1)
              + ", ageMs=" + (System.currentTimeMillis() - pending.createdAt));
          mStore.recordAttempt(file,
              pending.attempts + 1,
              System.currentTimeMillis(),
              result.reason);
          transientFailureSeen = true;
          break;
      }
    }

    if (transientFailureSeen) {
      Log.i(TAG, "Transient failures seen — requesting retry");
      return Result.retry();
    }

    Log.i(TAG, "Drain complete");
    return Result.success();
  }

  // -------------------------------------------------------------------------
  // Upload logic
  // -------------------------------------------------------------------------

  private UploadResult uploadOnce(PendingIncidentLog pending) {
    String coreToken = getCoreToken();
    if (coreToken == null || coreToken.isEmpty()) {
      Log.e(TAG, "No coreToken — permanent failure for " + pending.incidentId);
      return UploadResult.permanent("no_core_token");
    }

    String baseUrl = ServerConfigUtil.getServerBaseUrl(getApplicationContext());
    String url = baseUrl + "/api/incidents/" + pending.incidentId + "/logs";

    String bodyStr = pending.payload.toString();

    breadcrumb("incident_log.upload_attempt",
        "incidentId=" + pending.incidentId
        + ", attempt=" + (pending.attempts + 1)
        + ", source=" + pending.source);

    OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build();

    RequestBody requestBody = RequestBody.create(bodyStr, JSON_MEDIA_TYPE);

    Request request = new Request.Builder()
        .url(url)
        .header("Authorization", "Bearer " + coreToken)
        .post(requestBody)
        .build();

    Log.i(TAG, "Uploading " + pending.source + " logs for incident " + pending.incidentId
        + " (attempt " + (pending.attempts + 1) + ", " + bodyStr.length() + " bytes)");

    Response response = null;
    try {
      response = client.newCall(request).execute();
      int code = response.code();

      if (code >= 200 && code < 300) {
        Log.i(TAG, "Upload succeeded for " + pending.incidentId + " (HTTP " + code + ")");
        return UploadResult.success();
      } else if (code == 400 || code == 401 || code == 403 || code == 404 || code == 413) {
        Log.e(TAG, "Permanent failure for " + pending.incidentId + " (HTTP " + code + ")");
        return UploadResult.permanent("http_" + code);
      } else {
        Log.w(TAG, "Transient failure for " + pending.incidentId + " (HTTP " + code + ")");
        return UploadResult.transient_("http_" + code);
      }
    } catch (IOException e) {
      Log.e(TAG, "Network error uploading " + pending.incidentId, e);
      return UploadResult.transient_(e.getClass().getSimpleName() + ": " + e.getMessage());
    } catch (Exception e) {
      Log.e(TAG, "Unexpected error uploading " + pending.incidentId, e);
      return UploadResult.permanent("exception: " + e.getClass().getSimpleName());
    } finally {
      if (response != null) {
        response.close();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private String getCoreToken() {
    try {
      // ConfigurationManager uses PreferenceManager.getDefaultSharedPreferences
      // with key "core_token". WorkManager workers run outside the service
      // lifecycle, so we read SharedPreferences directly.
      Context ctx = getApplicationContext();
      android.content.SharedPreferences prefs =
          androidx.preference.PreferenceManager.getDefaultSharedPreferences(ctx);
      return prefs.getString("core_token", null);
    } catch (Exception e) {
      Log.e(TAG, "Failed to get coreToken", e);
      return null;
    }
  }

  private void breadcrumb(String category, String message) {
    try {
      AsgClientApplication app = AsgClientApplication.getInstance();
      if (app != null) {
        app.getReportManager().addBreadcrumb(message, category, ReportLevel.INFO);
      }
    } catch (Exception ignored) {
      // Best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Result type
  // -------------------------------------------------------------------------

  private enum Outcome { SUCCESS, PERMANENT_FAILURE, TRANSIENT_FAILURE }

  private static class UploadResult {
    final Outcome outcome;
    final String reason;

    private UploadResult(Outcome outcome, String reason) {
      this.outcome = outcome;
      this.reason = reason;
    }

    static UploadResult success() {
      return new UploadResult(Outcome.SUCCESS, null);
    }

    static UploadResult permanent(String reason) {
      return new UploadResult(Outcome.PERMANENT_FAILURE, reason);
    }

    static UploadResult transient_(String reason) {
      return new UploadResult(Outcome.TRANSIENT_FAILURE, reason);
    }
  }
}
