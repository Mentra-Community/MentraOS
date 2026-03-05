package com.mentra.asg_client.io.bes.log;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.utils.ServerConfigUtil;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Manages BES chip log collection over UART.
 *
 * <p>When requested, sends {@code mh_logs} to BES and reassembles the streamed
 * {@code sr_log} response packets. On completion, uploads the assembled BES
 * trace buffer to the incident backend as source {@code "glasses_firmware"}.</p>
 *
 * <p>Timeout chain:
 * <ul>
 *   <li>2 s – first-packet timeout: BES may not support mh_logs in this build</li>
 *   <li>20 s – overall safety timeout: if we never receive the terminator (cur=255, body=end),
 *       we stop waiting and upload whatever we have. Kept long so we don't cut off a stream
 *       that is still sending; only used when BES stalls or never sends terminator.</li>
 * </ul>
 * </p>
 *
 * <p>One instance per collection request; not a singleton.</p>
 */
public class BesLogManager {

  private static final String TAG = "BesLogManager";

  private static final int TERMINATOR_CUR = 255;
  private static final String TERMINATOR_BODY = "end";
  private static final long FIRST_PACKET_TIMEOUT_MS = 2000;
  private static final long OVERALL_TIMEOUT_MS = 20_000; // 20 s — only fires if terminator never arrives

  private static final MediaType JSON_MEDIA_TYPE =
      MediaType.parse("application/json; charset=utf-8");

  private final String mIncidentId;
  private final Context mContext;
  private final IConfigurationManager mConfigurationManager;
  private final Handler mHandler;

  private final StringBuilder mLogBuffer = new StringBuilder();
  private boolean mIsReceiving = false;
  private boolean mFinished = false;

  private final Runnable mFirstPacketTimeout;
  private final Runnable mOverallTimeout;

  /**
   * Create a new BES log collection session.
   *
   * @param incidentId       incident ID to attach logs to; may be null for standalone collection
   * @param context          application context
   * @param configurationManager provides the coreToken for backend auth
   */
  public BesLogManager(String incidentId, Context context,
                       IConfigurationManager configurationManager) {
    mIncidentId = incidentId;
    mContext = context;
    mConfigurationManager = configurationManager;
    mHandler = new Handler(Looper.getMainLooper());

    mFirstPacketTimeout = () -> {
      if (!mIsReceiving && !mFinished) {
        Log.w(TAG, "⏰ No sr_log packet within 2 s — BES may not support mh_logs in this build");
        finish("first_packet_timeout");
      }
    };

    mOverallTimeout = () -> {
      if (!mFinished) {
        Log.w(TAG, "⏰ Overall safety timeout (terminator not received) — uploading partial ("
            + mLogBuffer.length() + " chars)");
        finish("overall_timeout");
      }
    };
  }

  /**
   * Start the timeout watchdogs. Call immediately after sending the {@code mh_logs} UART command.
   */
  public void startTimeouts() {
    mHandler.postDelayed(mFirstPacketTimeout, FIRST_PACKET_TIMEOUT_MS);
    mHandler.postDelayed(mOverallTimeout, OVERALL_TIMEOUT_MS);
  }

  /**
   * Process one incoming {@code sr_log} packet.
   *
   * @param cur  packet sequence number; 255 signals end of stream
   * @param body log text chunk, or {@code "end"} for the terminator packet
   */
  public void onLogPacketReceived(int cur, String body) {
    if (mFinished) return;

    if (!mIsReceiving) {
      mIsReceiving = true;
      mHandler.removeCallbacks(mFirstPacketTimeout);
      Log.d(TAG, "📥 First sr_log packet received — reassembly started");
    }

    if (cur == TERMINATOR_CUR && TERMINATOR_BODY.equals(body)) {
      Log.i(TAG, "✅ BES log stream complete (cur=255, body=end) — "
          + mLogBuffer.length() + " chars collected");
      mHandler.removeCallbacks(mOverallTimeout);
      finish(null);
    } else {
      if (body != null) {
        mLogBuffer.append(body);
      }
      Log.d(TAG, "📥 sr_log cur=" + cur + ", buffer=" + mLogBuffer.length() + " chars");
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Finalize the collection and kick off the upload.
   *
   * @param timeoutReason null on normal completion, otherwise a reason string
   */
  private void finish(String timeoutReason) {
    if (mFinished) return;
    mFinished = true;
    mHandler.removeCallbacks(mFirstPacketTimeout);
    mHandler.removeCallbacks(mOverallTimeout);

    String fullLog = mLogBuffer.toString();

    if (timeoutReason != null) {
      Log.w(TAG, "⚠️ BES log collection ended due to: " + timeoutReason
          + " (" + fullLog.length() + " chars)");
    }

    if (mIncidentId == null || mIncidentId.isEmpty()) {
      if (fullLog.isEmpty()) {
        Log.i(TAG, "BES log buffer empty — nothing to print");
      } else {
        printLogsToLogcat(fullLog);
      }
      return;
    }

    if (fullLog.isEmpty()) {
      Log.i(TAG, "BES log buffer empty — nothing to upload");
      return;
    }

    final String snapshot = fullLog;
    new Thread(() -> uploadLogs(snapshot)).start();
  }

  /**
   * Print BES log text to logcat in 3000-char chunks (Android Log truncates at ~4000 chars).
   */
  private void printLogsToLogcat(String logText) {
    Log.i(TAG, "===== BES TRACE LOG START (" + logText.length() + " chars) =====");
    int chunkSize = 3000;
    int offset = 0;
    int part = 1;
    while (offset < logText.length()) {
      int end = Math.min(offset + chunkSize, logText.length());
      Log.i(TAG, "[BES part " + part + "] " + logText.substring(offset, end));
      offset = end;
      part++;
    }
    Log.i(TAG, "===== BES TRACE LOG END =====");
  }

  private void uploadLogs(String logText) {
    try {
      String coreToken = mConfigurationManager.getCoreToken();
      if (coreToken == null || coreToken.isEmpty()) {
        Log.e(TAG, "No coreToken — cannot upload BES logs for incident " + mIncidentId);
        return;
      }

      String baseUrl = ServerConfigUtil.getServerBaseUrl(mContext);
      // baseUrl = "https://devapi.mentra.glass:443";
      String url = baseUrl + "/api/incidents/" + mIncidentId + "/logs";

      // Build log entries: one entry per non-empty line, matching the incident logs schema
      JSONArray logs = new JSONArray();
      long now = System.currentTimeMillis();
      for (String line : logText.split("\n")) {
        if (line.trim().isEmpty()) continue;
        JSONObject entry = new JSONObject();
        entry.put("timestamp", now);
        entry.put("level", "debug");
        entry.put("message", line);
        entry.put("source", "BES");
        logs.put(entry);
      }

      JSONObject body = new JSONObject();
      body.put("source", "glasses_firmware");
      body.put("logs", logs);

      RequestBody requestBody = RequestBody.create(body.toString(), JSON_MEDIA_TYPE);

      // BES payload can be large (25k+ chars); backend may need time to merge + store to R2
      OkHttpClient client = new OkHttpClient.Builder()
          .connectTimeout(15, TimeUnit.SECONDS)
          .writeTimeout(45, TimeUnit.SECONDS)
          .readTimeout(60, TimeUnit.SECONDS)
          .build();

      Request request = new Request.Builder()
          .url(url)
          .header("Authorization", "Bearer " + coreToken)
          .post(requestBody)
          .build();

      // [LOGS] Full request for glasses firmware (BES) logs — backend routes by body.source
      String bodyStr = body.toString();
      int bodyPreviewLen = Math.min(bodyStr.length(), 1500);
      Log.i(TAG, "[LOGS] Glasses firmware (BES) full request: method=POST url=" + url
          + " body.source=glasses_firmware body.logs.length=" + logs.length()
          + " bodyPreview=" + (bodyStr.length() > bodyPreviewLen ? bodyStr.substring(0, bodyPreviewLen) + "..." : bodyStr));

      client.newCall(request).enqueue(new Callback() {
        @Override
        public void onFailure(Call call, IOException e) {
          Log.e(TAG, "Failed to upload BES logs for incident " + mIncidentId, e);
        }

        @Override
        public void onResponse(Call call, Response response) {
          if (response.isSuccessful()) {
            Log.i(TAG, "✅ BES (glasses_firmware) logs uploaded for incident "
                + mIncidentId + " (" + logs.length() + " lines)");
          } else {
            Log.e(TAG, "❌ Server rejected BES logs upload — status: "
                + response.code() + " for incident " + mIncidentId);
          }
          response.close();
        }
      });

    } catch (Exception e) {
      Log.e(TAG, "Error preparing BES logs upload for incident " + mIncidentId, e);
    }
  }
}
