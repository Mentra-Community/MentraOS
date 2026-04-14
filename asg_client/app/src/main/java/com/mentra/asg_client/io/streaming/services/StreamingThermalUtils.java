package com.mentra.asg_client.io.streaming.services;

import android.util.Log;

import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.util.Locale;

/**
 * Shared thermal utility methods for live streaming services.
 */
final class StreamingThermalUtils {

  private static final String TAG = "StreamingThermal";
  private static final String CPU_THERMAL_PATH = "/sys/class/thermal/thermal_zone1/temp";
  private static final double TEMPERATURE_SMOOTHING_ALPHA = 0.35d;

  private StreamingThermalUtils() {
  }

  static int readCpuTemperature() {
    try (BufferedReader reader = new BufferedReader(new FileReader(CPU_THERMAL_PATH))) {
      return Integer.parseInt(reader.readLine().trim());
    } catch (IOException | NumberFormatException e) {
      Log.w(TAG, "Failed to read CPU temperature from sysfs", e);
      return -1;
    }
  }

  static double toCelsius(int milliDegrees) {
    return milliDegrees / 1000.0d;
  }

  static String formatTemperature(int milliDegrees) {
    if (milliDegrees <= 0) {
      return "unavailable";
    }
    return String.format(Locale.US, "%.1fC", toCelsius(milliDegrees));
  }

  static int smoothCpuTemperature(int previousMilliDegrees, int currentMilliDegrees) {
    if (currentMilliDegrees <= 0) {
      return previousMilliDegrees;
    }
    if (previousMilliDegrees <= 0) {
      return currentMilliDegrees;
    }

    return (int) Math.round(
        previousMilliDegrees + (currentMilliDegrees - previousMilliDegrees)
            * TEMPERATURE_SMOOTHING_ALPHA);
  }
}
