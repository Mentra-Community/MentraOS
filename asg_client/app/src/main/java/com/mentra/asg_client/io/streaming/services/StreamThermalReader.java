package com.mentra.asg_client.io.streaming.services;

import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;

/** Reads the Mentra Live CPU thermal zone without assuming its numeric index. */
final class StreamThermalReader {
    private static volatile String sCpuTemperaturePath;
    private static volatile boolean sDiscoveryAttempted;

    private StreamThermalReader() {}

    static double readCpuTemperatureC() {
        String path = findCpuTemperaturePath();
        if (path == null) {
            return Double.NaN;
        }

        try {
            return normalizeCelsius(readFirstLine(path));
        } catch (IOException | NumberFormatException e) {
            Log.w("StreamThermalReader", "Failed to read CPU temperature from " + path, e);
            return Double.NaN;
        }
    }

    static double normalizeCelsius(String rawValue) {
        double raw = Double.parseDouble(rawValue.trim());
        double celsius = raw >= 1_000d ? raw / 1_000d : raw;
        return celsius > 0d && celsius < 200d ? celsius : Double.NaN;
    }

    private static String findCpuTemperaturePath() {
        if (sDiscoveryAttempted) {
            return sCpuTemperaturePath;
        }
        synchronized (StreamThermalReader.class) {
            if (sDiscoveryAttempted) {
                return sCpuTemperaturePath;
            }

            File root = new File(AsgConstants.THERMAL_SYSFS_ROOT);
            File[] zones = root.listFiles((dir, name) -> name.startsWith("thermal_zone"));
            if (zones != null) {
                for (File zone : zones) {
                    try {
                        String type = readFirstLine(new File(zone, "type").getAbsolutePath());
                        if (AsgConstants.CPU_THERMAL_ZONE_TYPE.equalsIgnoreCase(type.trim())) {
                            File temperature = new File(zone, "temp");
                            if (temperature.isFile()) {
                                sCpuTemperaturePath = temperature.getAbsolutePath();
                                break;
                            }
                        }
                    } catch (IOException ignored) {
                        // Some vendor thermal zones are not readable; continue discovery.
                    }
                }
            }

            if (sCpuTemperaturePath == null) {
                File fallback = new File(AsgConstants.CPU_THERMAL_FALLBACK_PATH);
                if (fallback.isFile()) {
                    sCpuTemperaturePath = fallback.getAbsolutePath();
                }
            }
            sDiscoveryAttempted = true;
            return sCpuTemperaturePath;
        }
    }

    private static String readFirstLine(String path) throws IOException {
        try (BufferedReader reader = new BufferedReader(new FileReader(path))) {
            String value = reader.readLine();
            if (value == null) {
                throw new IOException("empty thermal sysfs file");
            }
            return value;
        }
    }
}
