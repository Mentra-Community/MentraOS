package com.mentra.bluetoothsdk.utils;

import android.os.SystemClock;
import com.mentra.bluetoothsdk.Bridge;
import java.util.HashMap;
import java.util.Map;

/**
 * Writes SDK diagnostics to both the native console and the SDK's JavaScript log event.
 *
 * <p>The native console write is unconditional. Forwarding to JavaScript is not: every
 * forwarded event pins a JNI global reference until the JavaScript thread drains it, and the
 * process-wide table holds roughly 51,200 references. A log source that outruns a busy
 * JavaScript thread will therefore abort the process rather than merely slow it down, so
 * forwarding is capped at {@link #MAX_FORWARDED_PER_WINDOW} messages per second. Messages
 * above the cap are dropped from the JavaScript stream only (they are still in logcat), and
 * each window that drops anything emits a single notice so the gap is never silent.
 */
public final class NativeLog {
  public static final int DEBUG = android.util.Log.DEBUG;

  private static final String TAG = "NativeLog";

  /**
   * Chosen to sit far above the SDK's steady-state diagnostic rate while staying far below the
   * rate at which a stalled JavaScript thread could exhaust the JNI global reference table.
   */
  private static final int MAX_FORWARDED_PER_WINDOW = 100;

  private static final long WINDOW_MS = 1000L;

  private static final Object FORWARD_LOCK = new Object();

  private static long windowStartedAtMs = 0L;
  private static int forwardedInWindow = 0;
  private static int droppedInWindow = 0;

  private NativeLog() {}

  /**
   * Clears the forwarding budget so a test starts from a known state. The window is otherwise
   * driven by the wall clock and is shared by every caller in the process.
   */
  static void resetForwardingBudgetForTest() {
    synchronized (FORWARD_LOCK) {
      windowStartedAtMs = 0L;
      forwardedInWindow = 0;
      droppedInWindow = 0;
    }
  }

  /** Preserves Android's per-tag log-level check for existing SDK callers. */
  public static boolean isLoggable(String tag, int level) {
    return android.util.Log.isLoggable(tag, level);
  }

  /** Emits a verbose diagnostic to both sinks. */
  public static int v(String tag, String message) {
    return write(android.util.Log.VERBOSE, tag, message, null);
  }

  /** Emits a verbose diagnostic with its stack trace to both sinks. */
  public static int v(String tag, String message, Throwable error) {
    return write(android.util.Log.VERBOSE, tag, message, error);
  }

  /** Emits a debug diagnostic to both sinks. */
  public static int d(String tag, String message) {
    return write(DEBUG, tag, message, null);
  }

  /** Emits a debug diagnostic with its stack trace to both sinks. */
  public static int d(String tag, String message, Throwable error) {
    return write(DEBUG, tag, message, error);
  }

  /** Emits an informational diagnostic to both sinks. */
  public static int i(String tag, String message) {
    return write(android.util.Log.INFO, tag, message, null);
  }

  /** Emits an informational diagnostic with its stack trace to both sinks. */
  public static int i(String tag, String message, Throwable error) {
    return write(android.util.Log.INFO, tag, message, error);
  }

  /** Emits a warning to both sinks. */
  public static int w(String tag, String message) {
    return write(android.util.Log.WARN, tag, message, null);
  }

  /** Emits a warning with its stack trace to both sinks. */
  public static int w(String tag, String message, Throwable error) {
    return write(android.util.Log.WARN, tag, message, error);
  }

  /** Emits an error to both sinks. */
  public static int e(String tag, String message) {
    return write(android.util.Log.ERROR, tag, message, null);
  }

  /** Emits an error with its stack trace to both sinks. */
  public static int e(String tag, String message, Throwable error) {
    return write(android.util.Log.ERROR, tag, message, error);
  }

  private static int write(int priority, String tag, String message, Throwable error) {
    String text = String.valueOf(message);
    if (error != null) text += "\n" + android.util.Log.getStackTraceString(error);
    int result = android.util.Log.println(priority, tag, text);

    String notice = null;
    boolean forward;
    synchronized (FORWARD_LOCK) {
      long now = SystemClock.elapsedRealtime();
      if (now - windowStartedAtMs >= WINDOW_MS) {
        if (droppedInWindow > 0) {
          notice =
              "[W/"
                  + TAG
                  + "] dropped "
                  + droppedInWindow
                  + " message(s) from the JavaScript log stream to stay under "
                  + MAX_FORWARDED_PER_WINDOW
                  + "/s; see logcat for the full output";
        }
        windowStartedAtMs = now;
        forwardedInWindow = 0;
        droppedInWindow = 0;
      }
      forward = forwardedInWindow < MAX_FORWARDED_PER_WINDOW;
      if (forward) {
        forwardedInWindow++;
      } else {
        droppedInWindow++;
      }
    }

    // Dispatch directly: Bridge.log uses this logger too. Never tail logcat here,
    // because React Native writes console output back to it.
    if (notice != null) {
      send(notice);
    }
    if (forward) {
      send("[" + priorityLabel(priority) + "/" + tag + "] " + text);
    }

    return result;
  }

  private static void send(String message) {
    Map<String, Object> body = new HashMap<>();
    body.put("message", message);
    Bridge.sendTypedMessage("log", body);
  }

  private static String priorityLabel(int priority) {
    switch (priority) {
      case android.util.Log.VERBOSE: return "V";
      case android.util.Log.DEBUG: return "D";
      case android.util.Log.WARN: return "W";
      case android.util.Log.ERROR: return "E";
      default: return "I";
    }
  }
}
