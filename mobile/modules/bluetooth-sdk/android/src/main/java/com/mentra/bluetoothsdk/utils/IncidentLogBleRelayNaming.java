package com.mentra.core.utils;

import java.util.Locale;

/**
 * 16-byte K900 file name for incident log payloads relayed over BLE (must match ASG
 * {@code IncidentLogBleRelayNaming}).
 */
public final class IncidentLogBleRelayNaming {

    private static final int SUFFIX_LEN = 15;

    private IncidentLogBleRelayNaming() {}

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
