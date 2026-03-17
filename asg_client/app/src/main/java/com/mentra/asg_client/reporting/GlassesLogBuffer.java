package com.mentra.asg_client.reporting;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads recent logcat output filtered to this app's PID on demand.
 * Used to collect glasses-side diagnostic logs when a bug report incident is created.
 */
public class GlassesLogBuffer {

    private static final String TAG = "GlassesLogBuffer";

    /**
     * Read recent logcat lines for this process and return them as a JSON array of log entries
     * compatible with the backend incident logs format.
     *
     * @param maxLines maximum number of lines to read from logcat
     * @return JSONArray of { timestamp, level, message, source } objects
     */
    public static JSONArray getRecentLogs(int maxLines) {
        JSONArray result = new JSONArray();
        try {
            String pid = String.valueOf(android.os.Process.myPid());
            Process process = Runtime.getRuntime().exec(new String[]{
                    "logcat", "-d", "-t", String.valueOf(maxLines), "--pid=" + pid
            });

            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            String line;
            while ((line = reader.readLine()) != null) {
                JSONObject entry = parseLogcatLine(line);
                if (entry != null) {
                    result.put(entry);
                }
            }
            reader.close();
            process.waitFor();
        } catch (Exception e) {
            Log.e(TAG, "Failed to read logcat", e);
        }
        return result;
    }

    /**
     * Parse a single logcat line into a log entry object.
     *
     * Logcat format: "MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message"
     * Example:       "03-02 14:30:15.123  1234  5678 D AsgClientServiceV2: Some message"
     */
    private static JSONObject parseLogcatLine(String line) {
        if (line == null || line.trim().isEmpty()) {
            return null;
        }
        try {
            // Skip logcat header lines (e.g. "--------- beginning of main")
            if (line.startsWith("---------")) {
                return null;
            }

            // Format: "MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message"
            // Split on whitespace, max 6 tokens: date, time, pid, tid, level, rest
            String[] parts = line.trim().split("\\s+", 6);
            if (parts.length < 6) {
                return null;
            }

            String date = parts[0];   // MM-DD
            String time = parts[1];   // HH:MM:SS.mmm
            String levelChar = parts[4]; // single char: V D I W E F
            String rest = parts[5];   // "TAG: message"

            // Parse tag and message from "TAG: message"
            String tag = "";
            String message = rest;
            int colonIdx = rest.indexOf(": ");
            if (colonIdx >= 0) {
                tag = rest.substring(0, colonIdx).trim();
                message = rest.substring(colonIdx + 2);
            }

            // Build approximate epoch timestamp using current year
            long timestamp = approximateTimestamp(date, time);

            JSONObject entry = new JSONObject();
            entry.put("timestamp", timestamp);
            entry.put("level", mapLevel(levelChar));
            entry.put("message", message);
            entry.put("source", tag);
            return entry;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Build an approximate epoch ms timestamp from logcat date/time (no year in logcat output).
     * Uses current year — good enough for diagnostic purposes.
     */
    private static long approximateTimestamp(String date, String time) {
        try {
            // date = "MM-DD", time = "HH:MM:SS.mmm"
            int year = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR);
            String dateTimeStr = year + "-" + date + " " + time;

            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat(
                    "yyyy-MM-dd HH:mm:ss.SSS", java.util.Locale.US
            );
            sdf.setTimeZone(java.util.TimeZone.getDefault());
            java.util.Date parsed = sdf.parse(dateTimeStr);
            return parsed != null ? parsed.getTime() : System.currentTimeMillis();
        } catch (Exception e) {
            return System.currentTimeMillis();
        }
    }

    /**
     * Map a single logcat level character to a level string.
     * V/D → "debug", I → "info", W → "warn", E/F → "error"
     */
    private static String mapLevel(String levelChar) {
        switch (levelChar) {
            case "I": return "info";
            case "W": return "warn";
            case "E": case "F": return "error";
            default: return "debug"; // V, D, and anything else
        }
    }
}
