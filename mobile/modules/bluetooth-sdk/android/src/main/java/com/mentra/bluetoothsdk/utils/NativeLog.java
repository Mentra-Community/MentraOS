package com.mentra.bluetoothsdk.utils;

import com.mentra.bluetoothsdk.Bridge;
import java.util.HashMap;
import java.util.Map;

/** Writes SDK diagnostics to both the native console and the SDK's JavaScript log event. */
public final class NativeLog {
  public static final int DEBUG = android.util.Log.DEBUG;

  private NativeLog() {}

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
    Map<String, Object> body = new HashMap<>();
    body.put("message", "[" + priorityLabel(priority) + "/" + tag + "] " + text);
    // Dispatch directly: Bridge.log uses this logger too. Never tail logcat here,
    // because React Native writes console output back to it.
    Bridge.sendTypedMessage("log", body);
    return result;
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
