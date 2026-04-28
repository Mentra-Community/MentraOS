package com.mentra.asg_client.utils;

import java.util.Locale;

/**
 * 16-char K900 BLE file names for incident log relay (must match phone
 * {@code IncidentLogBleRelayNaming}).
 */
public final class IncidentLogBleRelayNaming {

  private static final int SUFFIX_LEN = 15;

  private IncidentLogBleRelayNaming() {}

  /**
   * @param prefix 'B' for glasses_firmware JSON, 'L' for glasses logcat JSON
   */
  public static String bleFileBaseName(String incidentId, char prefix) {
    if (incidentId == null || incidentId.isEmpty()) {
      return prefix + "000000000000000";
    }
    String compact = incidentId.replace("-", "").toLowerCase(Locale.US);
    if (compact.length() < SUFFIX_LEN) {
      StringBuilder sb = new StringBuilder(compact);
      while (sb.length() < SUFFIX_LEN) {
        sb.append('0');
      }
      compact = sb.toString();
    }
    return prefix + compact.substring(0, SUFFIX_LEN);
  }
}
