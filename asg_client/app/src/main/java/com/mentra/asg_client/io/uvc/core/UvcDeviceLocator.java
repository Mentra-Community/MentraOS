package com.mentra.asg_client.io.uvc.core;

import android.util.Log;

import java.io.File;
import java.io.FileReader;
import java.io.IOException;

/**
 * Scans the device filesystem for a UVC gadget output node.
 *
 * <p>Device nodes are resolved in priority order:
 * <ol>
 *   <li>Nodes whose sysfs {@code name} file contains "uvc", "gadget", or "output"</li>
 *   <li>First writable node found in any candidate path that does NOT look like a camera input</li>
 *   <li>First existing node found (fallback, regardless of write permission)</li>
 * </ol>
 *
 * <p>The sysfs and dev base paths are injectable via the constructor so that unit tests can
 * operate against a temporary directory instead of the real filesystem.
 */
public class UvcDeviceLocator {

  private static final String TAG = "UvcDeviceLocator";

  private static final String[] DEV_PREFIXES = {
      "uvc",
      "gadget/video",
      "video",
  };

  private static final String[] PREFERRED_NAME_FRAGMENTS = {
      "uvc", "gadget", "output",
  };

  private static final String[] REJECTED_NAME_FRAGMENTS = {
      "camera", "isp", "capture", "sensor", "preview",
  };

  private final String sysVideoLinuxBase;
  private final String devBase;

  public UvcDeviceLocator() {
    this("/sys/class/video4linux", "/dev");
  }

  /**
   * Injectable constructor for testing.
   *
   * @param sysVideoLinuxBase path equivalent to {@code /sys/class/video4linux}
   * @param devBase           path equivalent to {@code /dev}
   */
  public UvcDeviceLocator(String sysVideoLinuxBase, String devBase) {
    this.sysVideoLinuxBase = sysVideoLinuxBase;
    this.devBase = devBase;
  }

  /**
   * Returns the path of the best candidate UVC gadget output device node, or {@code null} if
   * nothing is found.
   *
   * <p>Callers should treat a {@code null} return as "gadget not available yet" and log
   * accordingly before declining to start the V4L2 sink.
   */
  public String findGadgetOutputDevicePath() {
    String preferred = null;
    String writable = null;
    String fallback = null;

    for (String prefix : DEV_PREFIXES) {
      File baseDir;
      String namePrefix;

      if (prefix.contains("/")) {
        baseDir = new File(devBase, prefix.substring(0, prefix.lastIndexOf('/')));
        namePrefix = prefix.substring(prefix.lastIndexOf('/') + 1);
      } else {
        baseDir = new File(devBase);
        namePrefix = prefix;
      }

      if (!baseDir.isDirectory()) {
        continue;
      }

      File[] entries = baseDir.listFiles(
          f -> f.getName().startsWith(namePrefix) && f.exists());
      if (entries == null) {
        continue;
      }

      for (File candidate : entries) {
        String nodeName = candidate.getName();
        String sysName = readSysName(nodeName);
        boolean looksLikeCamera = containsAny(sysName, REJECTED_NAME_FRAGMENTS)
            || containsAny(nodeName, REJECTED_NAME_FRAGMENTS);

        if (looksLikeCamera) {
          logDebug("Skipping camera-like node: " + candidate.getAbsolutePath()
              + " (sysName=" + sysName + ")");
          continue;
        }

        boolean looksLikeGadget = containsAny(sysName, PREFERRED_NAME_FRAGMENTS)
            || containsAny(nodeName, PREFERRED_NAME_FRAGMENTS);

        if (looksLikeGadget && preferred == null) {
          preferred = candidate.getAbsolutePath();
          logInfo("Preferred gadget node found: " + preferred
              + " (sysName=" + sysName + ")");
        } else if (candidate.canWrite() && writable == null) {
          writable = candidate.getAbsolutePath();
        } else if (fallback == null) {
          fallback = candidate.getAbsolutePath();
        }
      }
    }

    String result = preferred != null ? preferred
        : writable != null ? writable
        : fallback;

    if (result != null) {
      logInfo("UVC gadget output device resolved to: " + result);
    } else {
      logWarn("No UVC gadget output device found under " + devBase
          + " — gadget may not be active yet (USB not in conn_gadget mode?)");
    }

    return result;
  }

  /**
   * Legacy alias kept for backward compatibility; delegates to {@link #findGadgetOutputDevicePath()}.
   */
  public String findOutputDevicePath() {
    return findGadgetOutputDevicePath();
  }

  private String readSysName(String videoNodeName) {
    File nameFile = new File(sysVideoLinuxBase + "/" + videoNodeName + "/name");
    if (!nameFile.exists()) {
      return "";
    }
    try (FileReader reader = new FileReader(nameFile)) {
      char[] buf = new char[128];
      int n = reader.read(buf);
      return n > 0 ? new String(buf, 0, n).trim().toLowerCase() : "";
    } catch (IOException e) {
      return "";
    }
  }

  private static boolean containsAny(String haystack, String[] needles) {
    if (haystack == null || haystack.isEmpty()) {
      return false;
    }
    String lower = haystack.toLowerCase();
    for (String needle : needles) {
      if (lower.contains(needle)) {
        return true;
      }
    }
    return false;
  }

  private void logInfo(String message) {
    try {
      Log.i(TAG, message);
    } catch (Throwable ignored) {
      // android.util.Log is not available in JVM unit tests.
    }
  }

  private void logDebug(String message) {
    try {
      Log.d(TAG, message);
    } catch (Throwable ignored) {
      // android.util.Log is not available in JVM unit tests.
    }
  }

  private void logWarn(String message) {
    try {
      Log.w(TAG, message);
    } catch (Throwable ignored) {
      // android.util.Log is not available in JVM unit tests.
    }
  }
}
