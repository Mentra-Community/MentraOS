package com.mentra.asg_client.io.bes.log;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.service.core.handlers.K900CommandHandler;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;

import org.json.JSONObject;

/**
 * Debug-only helper that pulls the BES trace ring buffer at a short interval and
 * emits only newly observed lines into the MentraBleTrace log stream.
 */
public class BesTracePoller {
  private static final String TAG = "BesTracePoller";
  private static final long DEFAULT_INTERVAL_MS = 5000;
  private static final long MIN_INTERVAL_MS = 3000;
  private static final long MAX_INTERVAL_MS = 60000;
  private static final int MAX_INITIAL_LINES = 40;
  private static final int MAX_LINES_PER_POLL = 120;
  private static final int MAX_OVERLAP_SCAN_CHARS = 16000;

  private final Handler mHandler = new Handler(Looper.getMainLooper());

  private K900CommandHandler mK900CommandHandler;
  private Context mContext;
  private IConfigurationManager mConfigurationManager;
  private long mIntervalMs = DEFAULT_INTERVAL_MS;
  private boolean mRunning = false;
  private boolean mRequestInFlight = false;
  private boolean mHasBaseline = false;
  private String mLastSnapshot = "";

  private final Runnable mPollRunnable = this::pollOnce;

  public synchronized void start(K900CommandHandler k900CommandHandler,
                                 Context context,
                                 IConfigurationManager configurationManager,
                                 long intervalMs) {
    mK900CommandHandler = k900CommandHandler;
    mContext = context != null ? context.getApplicationContext() : null;
    mConfigurationManager = configurationManager;
    mIntervalMs = clampInterval(intervalMs);
    mRunning = true;
    mRequestInFlight = false;

    logControl("start", null);
    mHandler.removeCallbacks(mPollRunnable);
    mHandler.post(mPollRunnable);
  }

  public synchronized void stop() {
    if (!mRunning) {
      return;
    }
    mRunning = false;
    mRequestInFlight = false;
    mHandler.removeCallbacks(mPollRunnable);
    logControl("stop", null);
  }

  public synchronized boolean isRunning() {
    return mRunning;
  }

  private void pollOnce() {
    synchronized (this) {
      if (!mRunning) {
        return;
      }
      if (mRequestInFlight) {
        scheduleNextLocked();
        return;
      }
      if (mK900CommandHandler == null || mContext == null || mConfigurationManager == null) {
        logControl("skip", "missing_dependencies");
        scheduleNextLocked();
        return;
      }
      mRequestInFlight = true;
    }

    boolean started = mK900CommandHandler.requestBesLogsForTrace(
        mContext,
        mConfigurationManager,
        this::onSnapshotReceived);

    if (!started) {
      synchronized (this) {
        mRequestInFlight = false;
        scheduleNextLocked();
      }
    }
  }

  private void onSnapshotReceived(String snapshot) {
    String delta;
    synchronized (this) {
      mRequestInFlight = false;
      delta = extractDelta(snapshot != null ? snapshot : "");
      scheduleNextLocked();
    }
    emitDelta(delta);
  }

  private String extractDelta(String snapshot) {
    if (!mHasBaseline) {
      mHasBaseline = true;
      mLastSnapshot = snapshot;
      return tailLines(snapshot, MAX_INITIAL_LINES);
    }

    String previous = mLastSnapshot;
    mLastSnapshot = snapshot;

    if (snapshot.isEmpty() || snapshot.equals(previous)) {
      return "";
    }
    if (!previous.isEmpty() && snapshot.startsWith(previous)) {
      return snapshot.substring(previous.length());
    }

    int overlap = suffixPrefixOverlap(previous, snapshot);
    if (overlap > 0) {
      return snapshot.substring(overlap);
    }

    logControl("resync", "trace_buffer_rotated");
    return tailLines(snapshot, MAX_INITIAL_LINES);
  }

  private int suffixPrefixOverlap(String previous, String current) {
    int max = Math.min(Math.min(previous.length(), current.length()), MAX_OVERLAP_SCAN_CHARS);
    if (max == 0) {
      return 0;
    }

    String currentHead = current.substring(0, max);
    String previousTail = previous.substring(previous.length() - max);
    String combined = currentHead + '\0' + previousTail;
    int[] prefixLengths = new int[combined.length()];

    for (int index = 1; index < combined.length(); index++) {
      int length = prefixLengths[index - 1];
      while (length > 0 && combined.charAt(index) != combined.charAt(length)) {
        length = prefixLengths[length - 1];
      }
      if (combined.charAt(index) == combined.charAt(length)) {
        length++;
      }
      prefixLengths[index] = length;
    }

    return Math.min(prefixLengths[combined.length() - 1], max);
  }

  private String tailLines(String text, int maxLines) {
    if (text == null || text.isEmpty()) {
      return "";
    }
    String[] lines = text.split("\\r?\\n");
    int start = Math.max(0, lines.length - maxLines);
    StringBuilder builder = new StringBuilder();
    for (int i = start; i < lines.length; i++) {
      if (!lines[i].trim().isEmpty()) {
        builder.append(lines[i]).append('\n');
      }
    }
    return builder.toString();
  }

  private void emitDelta(String delta) {
    if (delta == null || delta.trim().isEmpty()) {
      return;
    }

    String[] lines = delta.split("\\r?\\n");
    int emitted = 0;
    for (String line : lines) {
      if (line.trim().isEmpty()) {
        continue;
      }
      if (isTraceTransportNoise(line)) {
        continue;
      }
      if (emitted >= MAX_LINES_PER_POLL) {
        logControl("truncated", "too_many_lines");
        break;
      }
      BleTraceLogger.logBesTraceLine(line);
      emitted++;
    }
  }

  private boolean isTraceTransportNoise(String line) {
    String normalized = line.replace("\\\"", "\"");
    return normalized.contains(">>>lxy uart cmd={\"C\":\"sr_log\"")
        || normalized.contains("<<<1 lxy uart string cmd=mh_logs")
        || normalized.contains("<<<lxy mh_request_logs")
        || normalized.contains("\"C\":\"mh_logs\"");
  }

  private synchronized void scheduleNextLocked() {
    if (!mRunning) {
      return;
    }
    mHandler.removeCallbacks(mPollRunnable);
    mHandler.postDelayed(mPollRunnable, mIntervalMs);
  }

  private long clampInterval(long intervalMs) {
    if (intervalMs <= 0) {
      return DEFAULT_INTERVAL_MS;
    }
    return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, intervalMs));
  }

  private void logControl(String event, String reason) {
    try {
      JSONObject payload = new JSONObject();
      payload.put("event", event);
      payload.put("intervalMs", mIntervalMs);
      if (reason != null) {
        payload.put("reason", reason);
      }
      BleTraceLogger.logEvent("bes_to_asg", "bes_trace_control", event, payload);
    } catch (Exception e) {
      Log.d(TAG, "Trace control log failed", e);
    }
  }
}
