package com.mentra.asg_client.io.streaming.services;

import android.util.Log;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import org.json.JSONArray;
import org.json.JSONObject;

/** Debug-mode ingest for the WHIP uplink. Reaches the host over `adb reverse tcp:7331`. */
public final class AsgDebugLog {
  private static final String TAG = "AsgDebugLog";
  private static final String INGEST =
      "http://127.0.0.1:7331/ingest/3cce15b2-06a7-47f9-8f9c-924fd72ec258";
  private static final String SESSION = "5e97f2";
  private static final String RUN_ID = "pre-fix";

  // Bounded + discard-oldest: an unreachable ingest must never grow a queue or
  // block the stats thread. The logcat line below is the lossless copy.
  private static final ThreadPoolExecutor PUMP = new ThreadPoolExecutor(
      1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(512),
      runnable -> {
        Thread thread = new Thread(runnable, "asg-dbg-log");
        thread.setDaemon(true);
        return thread;
      },
      new ThreadPoolExecutor.DiscardOldestPolicy());

  private AsgDebugLog() {}

  public static void emitJson(String hypothesisId, String location, String message, JSONObject data) {
    String line;
    try {
      line = new JSONObject()
          .put("sessionId", SESSION)
          .put("runId", RUN_ID)
          .put("hypothesisId", hypothesisId)
          .put("location", location)
          .put("message", message)
          .put("timestamp", System.currentTimeMillis())
          .put("data", data)
          .toString();
    } catch (Exception error) {
      return;
    }
    Log.i(TAG, "DBGJSON " + line);
    final String body = line;
    PUMP.execute(() -> post(body));
  }

  /** WebRTC members hold Number/String/Boolean plus nested maps and arrays. */
  public static JSONObject toJson(Map<String, Object> members) {
    JSONObject out = new JSONObject();
    for (Map.Entry<String, Object> entry : members.entrySet()) {
      try {
        out.put(entry.getKey(), wrap(entry.getValue()));
      } catch (Exception ignored) {
      }
    }
    return out;
  }

  private static Object wrap(Object value) {
    if (value == null) return JSONObject.NULL;
    if (value instanceof Number || value instanceof Boolean || value instanceof String) return value;
    if (value instanceof Map) {
      JSONObject obj = new JSONObject();
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
        try {
          obj.put(String.valueOf(entry.getKey()), wrap(entry.getValue()));
        } catch (Exception ignored) {
        }
      }
      return obj;
    }
    if (value instanceof Object[]) {
      JSONArray arr = new JSONArray();
      for (Object item : (Object[]) value) arr.put(wrap(item));
      return arr;
    }
    if (value instanceof Iterable) {
      JSONArray arr = new JSONArray();
      for (Object item : (Iterable<?>) value) arr.put(wrap(item));
      return arr;
    }
    return String.valueOf(value);
  }

  private static void post(String body) {
    try {
      HttpURLConnection conn = (HttpURLConnection) new URL(INGEST).openConnection();
      conn.setRequestMethod("POST");
      conn.setRequestProperty("Content-Type", "application/json");
      conn.setRequestProperty("X-Debug-Session-Id", SESSION);
      conn.setConnectTimeout(500);
      conn.setReadTimeout(500);
      conn.setDoOutput(true);
      conn.getOutputStream().write(body.getBytes("UTF-8"));
      conn.getOutputStream().close();
      conn.getInputStream().close();
      conn.disconnect();
    } catch (Exception ignored) {
    }
  }
}
