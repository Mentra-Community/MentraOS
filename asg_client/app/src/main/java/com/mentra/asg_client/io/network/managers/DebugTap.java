// #region agent log
package com.mentra.asg_client.io.network.managers;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.Enumeration;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * TEMPORARY debug tap for session 538848. Delete with the rest of the instrumentation.
 *
 * <p>Posts NDJSON to the developer host over {@code adb reverse tcp:7905 tcp:7905}.
 */
final class DebugTap {
    private static final String ENDPOINT =
            "http://127.0.0.1:7905/ingest/5a9713c9-45ff-4d09-9435-2adc5db5e91d";
    private static final String SESSION = "538848";

    private static final ExecutorService POOL =
            Executors.newSingleThreadExecutor(
                    runnable -> {
                        Thread thread = new Thread(runnable, "softap-debug-tap");
                        thread.setDaemon(true);
                        return thread;
                    });

    private DebugTap() {}

    static void log(String hypothesisId, String location, String message, Map<String, Object> data) {
        final String body;
        try {
            JSONObject payload = new JSONObject();
            payload.put("sessionId", SESSION);
            payload.put("runId", "glasses");
            payload.put("hypothesisId", hypothesisId);
            payload.put("location", location);
            payload.put("message", message);
            payload.put("timestamp", System.currentTimeMillis());
            JSONObject fields = new JSONObject();
            for (Map.Entry<String, Object> entry : data.entrySet()) {
                fields.put(entry.getKey(), entry.getValue() == null ? JSONObject.NULL : entry.getValue());
            }
            payload.put("data", fields);
            body = payload.toString();
        } catch (Exception ignored) {
            return;
        }
        POOL.execute(
                () -> {
                    try {
                        HttpURLConnection connection =
                                (HttpURLConnection) new URL(ENDPOINT).openConnection();
                        connection.setRequestMethod("POST");
                        connection.setDoOutput(true);
                        connection.setConnectTimeout(1500);
                        connection.setReadTimeout(1500);
                        connection.setRequestProperty("Content-Type", "application/json");
                        connection.setRequestProperty("X-Debug-Session-Id", SESSION);
                        try (OutputStream out = connection.getOutputStream()) {
                            out.write(body.getBytes("UTF-8"));
                        }
                        connection.getResponseCode();
                        connection.disconnect();
                    } catch (Exception ignored) {
                        // Best effort: the host tunnel may not be attached.
                    }
                });
    }

    /** Ground truth for whether the AP interface is actually up and addressed. */
    static String interfaceState(String name) {
        try {
            NetworkInterface iface = NetworkInterface.getByName(name);
            if (iface == null) {
                return "absent";
            }
            StringBuilder out = new StringBuilder();
            out.append("up=").append(iface.isUp());
            Enumeration<InetAddress> addresses = iface.getInetAddresses();
            while (addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (address instanceof Inet4Address) {
                    out.append(" ipv4=").append(address.getHostAddress());
                }
            }
            return out.toString();
        } catch (Exception e) {
            return "error:" + e.getMessage();
        }
    }
}
// #endregion
