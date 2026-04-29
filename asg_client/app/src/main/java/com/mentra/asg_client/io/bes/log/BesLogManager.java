package com.mentra.asg_client.io.bes.log;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.function.Consumer;

/**
 * Manages BES chip log collection over UART.
 *
 * <p>When requested, sends {@code mh_logs} to BES and reassembles the streamed
 * {@code sr_log} response packets. On completion, delivers the assembled BES
 * trace buffer as source {@code "glasses_firmware"} for the phone/host to handle.</p>
 *
 * <p>Timeout chain:
 * <ul>
 *   <li>2 s – first-packet timeout: BES may not support mh_logs in this build</li>
 *   <li>20 s – overall safety timeout: if we never receive the terminator (cur=255, body=end),
 *       we stop waiting and report whatever we have. Kept long so we don't cut off a stream
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

  private final String mIncidentId;
  private final Handler mHandler;

  private final StringBuilder mLogBuffer = new StringBuilder();
  private boolean mIsReceiving = false;
  private boolean mFinished = false;

  private final Runnable mFirstPacketTimeout;
  private final Runnable mOverallTimeout;

  /**
   * When non-null, {@link #finish(String)} delivers JSON on a background thread for BLE relay to
   * the phone.
   */
  private final Consumer<String> mRelayJsonCallback;

  /**
   * @param relayJsonCallback if non-null, completion invokes this with glasses_firmware JSON.
   */
  public BesLogManager(String incidentId, Consumer<String> relayJsonCallback) {
    mIncidentId = incidentId;
    mRelayJsonCallback = relayJsonCallback;
    mHandler = new Handler(Looper.getMainLooper());

    mFirstPacketTimeout = () -> {
      if (!mIsReceiving && !mFinished) {
        Log.w(TAG, "⏰ No sr_log packet within 2 s — BES may not support mh_logs in this build");
        finish("first_packet_timeout");
      }
    };

    mOverallTimeout = () -> {
      if (!mFinished) {
        Log.w(TAG, "⏰ Overall safety timeout (terminator not received) — reporting partial ("
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
   * Finalize the collection and deliver or print the result.
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

    if (mRelayJsonCallback != null) {
      final String json = buildFirmwareUploadJson(fullLog);
      new Thread(() -> {
        try {
          mRelayJsonCallback.accept(json);
        } catch (Exception e) {
          Log.e(TAG, "relayJsonCallback failed", e);
        }
      }).start();
      return;
    }

    if (fullLog.isEmpty()) {
      Log.i(TAG, "BES log buffer empty — nothing to print");
      return;
    }

    printLogsToLogcat(fullLog);
  }

  /**
   * JSON body for a firmware log report with {@code source: glasses_firmware}.
   */
  public static String buildFirmwareUploadJson(String fullLog) {
    try {
      JSONArray logs = new JSONArray();
      long now = System.currentTimeMillis();
      if (fullLog != null) {
        for (String line : fullLog.split("\n")) {
          if (line.trim().isEmpty()) {
            continue;
          }
          JSONObject entry = new JSONObject();
          entry.put("timestamp", now);
          entry.put("level", "debug");
          entry.put("message", line);
          entry.put("source", "BES");
          logs.put(entry);
        }
      }
      JSONObject body = new JSONObject();
      body.put("source", "glasses_firmware");
      body.put("logs", logs);
      return body.toString();
    } catch (Exception e) {
      Log.e(TAG, "buildFirmwareUploadJson failed", e);
      return "{\"source\":\"glasses_firmware\",\"logs\":[]}";
    }
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

}
