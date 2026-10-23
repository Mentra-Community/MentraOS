package com.mentra.bluetoothsdk.utils;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 16-byte K900 file name for incident log payloads relayed over BLE (must match ASG
 * {@code IncidentLogBleRelayNaming}).
 */
public final class IncidentLogBleRelayNaming {

    private static final int SUFFIX_LEN = 15;
    private static final Pattern RELAY_FILE_NAME = Pattern.compile("^[BL][a-z0-9_]{15}$");

    private IncidentLogBleRelayNaming() {}

    /**
     * Whether a received K900 file has the shape of an incident log relay. Such a file is only
     * uploaded through a relay registered by {@code sendIncidentId}; without one it must not be
     * acknowledged as delivered.
     */
    public static boolean isRelayFileName(String fileName) {
        return fileName != null && RELAY_FILE_NAME.matcher(fileName).matches();
    }

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
