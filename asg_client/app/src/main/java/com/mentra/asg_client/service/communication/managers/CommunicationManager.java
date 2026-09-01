package com.mentra.asg_client.service.communication.managers;

import android.util.Log;

import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.models.NetworkInfo;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.reliability.ReliableMessageManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

/**
 * Manages all communication operations (Bluetooth, WiFi status, etc.). Follows Single
 * Responsibility Principle by handling only communication concerns.
 *
 * <p>Also implements OtaHelper.PhoneConnectionProvider for phone-controlled OTA updates.
 */
public class CommunicationManager
        implements ICommunicationManager, OtaHelper.PhoneConnectionProvider {

    private static final String TAG = "CommunicationManager";

    private final ICompanionTransport transport;
    private final INetworkManager networkManager;
    private ReliableMessageManager reliableManager;

    public CommunicationManager(ICompanionTransport transport, INetworkManager networkManager) {
        this.transport = transport;
        this.networkManager = networkManager;

        this.reliableManager =
                new ReliableMessageManager(
                        (data, callback, gate) -> {
                            if (this.transport != null) {
                                return this.transport.sendMessage(
                                        data,
                                        callback != null ? callback::onComplete : null,
                                        adaptSendGate(gate));
                            }
                            return false;
                        });

        // Enable by default - worst case with old phones is just some extra retries
        this.reliableManager.setEnabled(true, 1);
    }

    private static IBluetoothManager.SendMessageGate adaptSendGate(
            ReliableMessageManager.SendGate gate) {
        if (gate == null) {
            return null;
        }
        return new IBluetoothManager.SendMessageGate() {
            @Override
            public boolean shouldSend() {
                return gate.shouldSend();
            }

            @Override
            public Object lock() {
                return gate.lock();
            }
        };
    }

    /**
     * Get the reliable message manager (for CommandProcessor ACK handling).
     *
     * @return The ReliableMessageManager instance
     */
    public ReliableMessageManager getReliableManager() {
        return reliableManager;
    }

    @Override
    public void sendWifiStatusOverBle(boolean isConnected) {
        sendWifiStatusOverBle(isConnected, null);
    }

    @Override
    public void sendWifiStatusOverBle(boolean isConnected, String error) {
        Log.d(TAG, "🔄 =========================================");
        Log.d(TAG, "🔄 SEND WIFI STATUS OVER BLE");
        Log.d(TAG, "🔄 =========================================");
        Log.d(
                TAG,
                "🔄 WiFi connected: " + isConnected + (error != null ? ", error: " + error : ""));

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "🔄 ✅ Transport available and connected");

            try {
                JSONObject wifiStatus = new JSONObject();
                // Use proper type for reliable sending
                wifiStatus.put("type", "wifi_status");
                wifiStatus.put("connected", isConnected);
                if (error != null && !error.isEmpty()) {
                    wifiStatus.put("error", error);
                }
                if (isConnected && networkManager != null) {
                    String ssid = networkManager.getCurrentWifiSsid();
                    String localIp = networkManager.getLocalIpAddress();

                    Log.d(TAG, "🔄 📡 WiFi SSID: " + (ssid != null ? ssid : "unknown"));
                    Log.d(TAG, "🔄 🌐 Local IP: " + (localIp != null ? localIp : "unknown"));

                    wifiStatus.put("ssid", ssid != null ? ssid : "unknown");
                    wifiStatus.put("local_ip", localIp != null ? localIp : "");
                } else {
                    Log.d(TAG, "🔄 ❌ WiFi not connected or network manager unavailable");
                    wifiStatus.put("ssid", "");
                    wifiStatus.put("local_ip", "");
                }

                boolean sent = reliableManager.sendMessage(wifiStatus);
                Log.d(TAG, "🔄 📤 Sent WiFi status: (sent: " + sent + ")");
            } catch (JSONException e) {
                Log.e(TAG, "🔄 💥 Error creating WiFi status JSON", e);
            }
        } else {
            Log.w(TAG, "🔄 ❌ Cannot send WiFi status - transport not available or not connected");
            if (transport == null) Log.w(TAG, "🔄 ❌ Transport is null");
            else Log.w(TAG, "🔄 ❌ Transport not connected");
        }
    }

    @Override
    public void sendWifiForgetResultOverBle(
            String requestId, String ssid, boolean dispatched, String error) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "wifi_forget_result");
            if (requestId != null && !requestId.isEmpty()) {
                response.put("requestId", requestId);
            }
            response.put("ssid", ssid);
            response.put("dispatched", dispatched);
            if (error != null && !error.isEmpty()) {
                response.put("error", error);
            }
            if (networkManager != null) {
                boolean connected = networkManager.isConnectedToWifi();
                response.put("connected", connected);
                response.put("current_ssid", connected ? networkManager.getCurrentWifiSsid() : "");
                response.put("local_ip", connected ? networkManager.getLocalIpAddress() : "");
            }
            reliableManager.sendMessage(response);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating WiFi forget result", e);
        }
    }

    @Override
    public void sendSavedWifiNetworksOverBle(
            String requestId, List<String> networks, String error) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "saved_wifi_networks");
            response.put("requestId", requestId);
            response.put("networks", new org.json.JSONArray(networks));
            if (error != null && !error.isEmpty()) {
                response.put("error", error);
            }
            reliableManager.sendMessage(response);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating saved WiFi networks response", e);
        }
    }

    @Override
    public void sendBatteryStatusOverBle() {
        Log.d(TAG, "🔋 =========================================");
        Log.d(TAG, "🔋 SEND BATTERY STATUS OVER BLE");
        Log.d(TAG, "🔋 =========================================");

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "🔋 ✅ Transport available and connected");

            try {
                JSONObject response = new JSONObject();
                response.put("type", "battery_status");
                response.put("timestamp", System.currentTimeMillis());
                // Note: Battery level and charging status would be injected via constructor or
                // setter
                response.put("level", -1); // Placeholder
                response.put("charging", false); // Placeholder

                // Battery status doesn't need reliability (periodic updates)
                boolean sent = reliableManager.sendMessage(response);
                Log.d(TAG, "🔋 📤 Sent battery status (sent: " + sent + ")");

            } catch (JSONException e) {
                Log.e(TAG, "🔋 💥 Error creating battery status response", e);
            }
        } else {
            Log.w(TAG, "🔋 ❌ Cannot send battery status - not connected to BLE device");
            if (transport == null) Log.w(TAG, "🔋 ❌ Transport is null");
            else Log.w(TAG, "🔋 ❌ Transport not connected");
        }
    }

    /** Build a wifi_scan_result envelope echoing the originating scan's correlation id. */
    private JSONObject newWifiScanResultMessage(String scanId) throws JSONException {
        JSONObject response = new JSONObject();
        response.put("type", "wifi_scan_result");
        response.put("timestamp", System.currentTimeMillis());
        if (scanId != null && !scanId.isEmpty()) {
            response.put("scanId", scanId);
        }
        return response;
    }

    @Override
    public void sendWifiScanResultsOverBle(List<String> networks, String scanId) {
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 SEND WIFI SCAN RESULTS OVER BLE");
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 Networks found: " + (networks != null ? networks.size() : 0));

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "📡 ✅ Transport available and connected");

            try {
                // Send networks in chunks of 4 to avoid BLE message size issues
                int CHUNK_SIZE = 4;
                List<String> scanNetworks = networks != null ? networks : Collections.emptyList();

                // Split and send in chunks
                for (int i = 0; i < scanNetworks.size(); i += CHUNK_SIZE) {
                    int endIdx = Math.min(i + CHUNK_SIZE, scanNetworks.size());
                    List<String> chunk = scanNetworks.subList(i, endIdx);
                    boolean scanComplete = endIdx >= scanNetworks.size();

                    JSONObject response = newWifiScanResultMessage(scanId);

                    org.json.JSONArray networksArray = new org.json.JSONArray();
                    for (String network : chunk) {
                        networksArray.put(network);
                        Log.d(TAG, "📡 📶 Found network: " + network);
                    }
                    response.put("networks", networksArray);
                    response.put("scan_complete", scanComplete);

                    String jsonString = response.toString();
                    Log.d(TAG, "📡 📤 Sending WiFi scan results chunk: " + jsonString);
                    Log.d(
                            TAG,
                            "📡 📊 Message size: "
                                    + jsonString.getBytes(StandardCharsets.UTF_8).length
                                    + " bytes");

                    boolean sent =
                            transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                    Log.d(
                            TAG,
                            "📡 "
                                    + (sent
                                            ? "✅ WiFi scan chunk sent successfully"
                                            : "❌ Failed to send WiFi scan chunk"));

                    // Small delay between chunks
                    if (i + CHUNK_SIZE < scanNetworks.size()) {
                        try {
                            Thread.sleep(100);
                        } catch (InterruptedException e) {
                            Log.e(TAG, "Interrupted while sending chunks", e);
                        }
                    }
                }
                if (scanNetworks.isEmpty()) {
                    JSONObject response = newWifiScanResultMessage(scanId);
                    response.put("networks", new org.json.JSONArray());
                    response.put("scan_complete", true);

                    String jsonString = response.toString();
                    Log.d(TAG, "📡 📤 Sending empty WiFi scan result: " + jsonString);
                    boolean sent =
                            transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                    Log.d(
                            TAG,
                            "📡 "
                                    + (sent
                                            ? "✅ Empty WiFi scan result sent successfully"
                                            : "❌ Failed to send empty WiFi scan result"));
                }

            } catch (JSONException e) {
                Log.e(TAG, "📡 💥 Error creating WiFi scan results response", e);
            }
        } else {
            Log.w(TAG, "📡 ❌ Cannot send WiFi scan results - not connected to BLE device");
            if (transport == null) Log.w(TAG, "📡 ❌ Transport is null");
            else Log.w(TAG, "📡 ❌ Transport not connected");
        }
    }

    @Override
    public void sendWifiScanResultsOverBleEnhanced(
            List<NetworkInfo> networks, boolean scanComplete, String scanId) {
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 SEND ENHANCED WIFI SCAN RESULTS OVER BLE");
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 Enhanced networks found: " + (networks != null ? networks.size() : 0));

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "📡 ✅ Transport available and connected");

            try {
                List<NetworkInfo> scanNetworks =
                        networks != null ? networks : Collections.emptyList();

                // Send one network at a time to keep message size minimal
                for (NetworkInfo network : scanNetworks) {
                    JSONObject response = newWifiScanResultMessage(scanId);
                    response.put("scan_complete", false);

                    // Legacy format for backwards compatibility
                    org.json.JSONArray legacyArray = new org.json.JSONArray();
                    legacyArray.put(network.getSsid());
                    response.put("networks", legacyArray);

                    // Enhanced format with security and signal info
                    org.json.JSONArray enhancedArray = new org.json.JSONArray();
                    enhancedArray.put(network.toJson());
                    response.put("networks_neo", enhancedArray);

                    String jsonString = response.toString();
                    Log.d(TAG, "📡 📤 Sending enhanced WiFi scan result: " + jsonString);
                    Log.d(
                            TAG,
                            "📡 📊 Message size: "
                                    + jsonString.getBytes(StandardCharsets.UTF_8).length
                                    + " bytes");
                    Log.d(
                            TAG,
                            "📡 🔒 Network: "
                                    + network.getSsid()
                                    + " (secured="
                                    + network.requiresPassword()
                                    + ", signal="
                                    + network.getSignalStrength()
                                    + "dBm)");

                    boolean sent =
                            transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                    Log.d(
                            TAG,
                            "📡 "
                                    + (sent
                                            ? "✅ Enhanced WiFi scan result sent successfully"
                                            : "❌ Failed to send enhanced WiFi scan result"));

                    // Small delay between individual network messages
                    if (scanNetworks.size() > 1) {
                        try {
                            Thread.sleep(50);
                        } catch (InterruptedException e) {
                            Log.e(TAG, "Interrupted while sending individual networks", e);
                        }
                    }
                }
                if (scanComplete) {
                    JSONObject response = newWifiScanResultMessage(scanId);
                    response.put("scan_complete", scanComplete);
                    response.put("networks", new org.json.JSONArray());
                    response.put("networks_neo", new org.json.JSONArray());

                    String jsonString = response.toString();
                    Log.d(TAG, "📡 📤 Sending empty enhanced WiFi scan result: " + jsonString);
                    boolean sent =
                            transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                    Log.d(
                            TAG,
                            "📡 "
                                    + (sent
                                            ? "✅ Empty enhanced WiFi scan result sent successfully"
                                            : "❌ Failed to send empty enhanced WiFi scan result"));
                }

            } catch (JSONException e) {
                Log.e(TAG, "📡 💥 Error creating enhanced WiFi scan results response", e);
            }
        } else {
            Log.w(TAG, "📡 ❌ Cannot send enhanced WiFi scan results - not connected to BLE device");
            if (transport == null) Log.w(TAG, "📡 ❌ Transport is null");
            else Log.w(TAG, "📡 ❌ Transport not connected");
        }
    }

    @Override
    public void sendAckResponse(long messageId) {
        Log.d(TAG, "✅ =========================================");
        Log.d(TAG, "✅ SEND ACK RESPONSE");
        Log.d(TAG, "✅ =========================================");
        Log.d(TAG, "✅ Message ID: " + messageId);

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "✅ ✅ Transport available and connected");

            try {
                JSONObject ackResponse = new JSONObject();
                ackResponse.put("type", "msg_ack");
                ackResponse.put("mId", messageId);
                ackResponse.put("timestamp", System.currentTimeMillis());

                String jsonString = ackResponse.toString();
                Log.d(TAG, "✅ 📤 Sending ACK response: " + jsonString);

                boolean sent = transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                Log.d(
                        TAG,
                        "✅ "
                                + (sent
                                        ? "✅ ACK response sent successfully"
                                        : "❌ Failed to send ACK response"));

            } catch (JSONException e) {
                Log.e(TAG, "✅ 💥 Error creating ACK response JSON", e);
            }
        } else {
            Log.w(TAG, "✅ ❌ Cannot send ACK response - not connected to BLE device");
            if (transport == null) Log.w(TAG, "✅ ❌ Transport is null");
            else Log.w(TAG, "✅ ❌ Transport not connected");
        }
    }

    @Override
    public void sendTokenStatusResponse(boolean success) {
        Log.d(TAG, "🔑 =========================================");
        Log.d(TAG, "🔑 SEND TOKEN STATUS RESPONSE");
        Log.d(TAG, "🔑 =========================================");
        Log.d(TAG, "🔑 Token status: " + (success ? "SUCCESS" : "FAILED"));

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "🔑 ✅ Transport available and connected");

            try {
                JSONObject response = new JSONObject();
                response.put("type", "token_status");
                response.put("success", success);
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "🔑 📤 Sending token status response: " + jsonString);

                boolean sent = transport.sendMessage(jsonString.getBytes());
                Log.d(
                        TAG,
                        "🔑 "
                                + (sent
                                        ? "✅ Token status response sent successfully"
                                        : "❌ Failed to send token status response"));

            } catch (JSONException e) {
                Log.e(TAG, "🔑 💥 Error creating token status response", e);
            }
        } else {
            Log.w(TAG, "🔑 ❌ Cannot send token status response - not connected to BLE device");
            if (transport == null) Log.w(TAG, "🔑 ❌ Transport is null");
            else Log.w(TAG, "🔑 ❌ Transport not connected");
        }
    }

    @Override
    public void sendMediaSuccessResponse(String requestId, String mediaUrl, int mediaType) {
        Log.d(TAG, "📸 =========================================");
        Log.d(TAG, "📸 SEND MEDIA SUCCESS RESPONSE");
        Log.d(TAG, "📸 =========================================");
        Log.d(TAG, "📸 Request ID: " + requestId);
        Log.d(TAG, "📸 Media URL: " + mediaUrl);
        Log.d(TAG, "📸 Media Type: " + mediaType);

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "📸 ✅ Transport available and connected");

            try {
                JSONObject response = new JSONObject();
                response.put("type", "media_success");
                response.put("requestId", requestId);
                response.put("mediaUrl", mediaUrl);
                response.put("mediaType", mediaType);
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "📸 📤 Sending media success response: " + jsonString);

                boolean sent = transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                Log.d(
                        TAG,
                        "📸 "
                                + (sent
                                        ? "✅ Media success response sent successfully"
                                        : "❌ Failed to send media success response"));

            } catch (JSONException e) {
                Log.e(TAG, "📸 💥 Error creating media success response", e);
            }
        } else {
            Log.w(TAG, "📸 ❌ Cannot send media success response - not connected to BLE device");
            if (transport == null) Log.w(TAG, "📸 ❌ Transport is null");
            else Log.w(TAG, "📸 ❌ Transport not connected");
        }
    }

    @Override
    public void sendMediaErrorResponse(String requestId, String errorMessage, int mediaType) {
        Log.d(TAG, "❌ =========================================");
        Log.d(TAG, "❌ SEND MEDIA ERROR RESPONSE");
        Log.d(TAG, "❌ =========================================");
        Log.d(TAG, "❌ Request ID: " + requestId);
        Log.d(TAG, "❌ Error Message: " + errorMessage);
        Log.d(TAG, "❌ Media Type: " + mediaType);

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "❌ ✅ Transport available and connected");

            try {
                JSONObject response = new JSONObject();
                response.put("type", "media_error");
                response.put("requestId", requestId);
                response.put("errorMessage", errorMessage);
                response.put("mediaType", mediaType);
                response.put("timestamp", System.currentTimeMillis());

                String jsonString = response.toString();
                Log.d(TAG, "❌ 📤 Sending media error response: " + jsonString);

                boolean sent = transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                Log.d(
                        TAG,
                        "❌ "
                                + (sent
                                        ? "✅ Media error response sent successfully"
                                        : "❌ Failed to send media error response"));

            } catch (JSONException e) {
                Log.e(TAG, "❌ 💥 Error creating media error response", e);
            }
        } else {
            Log.w(TAG, "❌ ❌ Cannot send media error response - not connected to BLE device");
            if (transport == null) Log.w(TAG, "❌ ❌ Transport is null");
            else Log.w(TAG, "❌ ❌ Transport not connected");
        }
    }

    @Override
    public void sendKeepAliveAck(String streamId, String ackId) {
        Log.d(TAG, "💓 =========================================");
        Log.d(TAG, "💓 SEND KEEP ALIVE ACK");
        Log.d(TAG, "💓 =========================================");
        Log.d(TAG, "💓 Stream ID: " + streamId);
        Log.d(TAG, "💓 ACK ID: " + ackId);

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "💓 ✅ Transport available and connected");

            try {
                JSONObject keepAliveResponse = new JSONObject();
                keepAliveResponse.put("type", "keep_alive_ack");
                keepAliveResponse.put("streamId", streamId);
                keepAliveResponse.put("ackId", ackId);
                keepAliveResponse.put("timestamp", System.currentTimeMillis());

                String jsonString = keepAliveResponse.toString();
                Log.d(TAG, "💓 📤 Sending keep-alive ACK: " + jsonString);

                boolean sent = transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                Log.d(
                        TAG,
                        "💓 "
                                + (sent
                                        ? "✅ Keep-alive ACK sent successfully"
                                        : "❌ Failed to send keep-alive ACK"));

            } catch (JSONException e) {
                Log.e(TAG, "💓 💥 Error creating keep-alive ACK response", e);
            }
        } else {
            Log.w(TAG, "💓 ❌ Cannot send keep-alive ACK - not connected to BLE device");
            if (transport == null) Log.w(TAG, "💓 ❌ Transport is null");
            else Log.w(TAG, "💓 ❌ Transport not connected");
        }
    }

    @Override
    public boolean sendBluetoothData(byte[] data) {
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 SEND BLUETOOTH DATA");
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 Data length: " + (data != null ? data.length : 0) + " bytes");

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "📡 ✅ Transport available and connected");

            boolean sent = transport.sendMessage(data);
            Log.d(
                    TAG,
                    "📡 "
                            + (sent
                                    ? "✅ Bluetooth data sent successfully"
                                    : "❌ Failed to send Bluetooth data"));
            return sent;
        } else {
            Log.w(TAG, "📡 ❌ Cannot send Bluetooth data - not connected to BLE device");
            if (transport == null) Log.w(TAG, "📡 ❌ Transport is null");
            else Log.w(TAG, "📡 ❌ Transport not connected");
            return false;
        }
    }

    @Override
    public boolean sendBluetoothResponse(JSONObject response) {
        Log.d(TAG, "📤 =========================================");
        Log.d(TAG, "📤 SEND BLUETOOTH RESPONSE");
        Log.d(TAG, "📤 =========================================");
        Log.d(TAG, "📤 Response: " + (response != null ? response.toString() : "null"));

        if (transport != null && transport.isConnected()) {
            Log.d(TAG, "📤 ✅ Transport available and connected");

            try {
                String jsonString = response.toString();
                Log.d(TAG, "📤 📤 Sending JSON response: " + jsonString);

                boolean sent = transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                Log.d(
                        TAG,
                        "📤 "
                                + (sent
                                        ? "✅ Bluetooth response sent successfully"
                                        : "❌ Failed to send Bluetooth response"));
                return sent;
            } catch (Exception e) {
                Log.e(TAG, "📤 💥 Error sending Bluetooth response", e);
                return false;
            }
        } else {
            Log.w(TAG, "📤 ❌ Cannot send Bluetooth response - not connected to BLE device");
            if (transport == null) Log.w(TAG, "📤 ❌ Transport is null");
            else Log.w(TAG, "📤 ❌ Transport not connected");
            return false;
        }
    }

    // ========== PhoneConnectionProvider Implementation ==========

    /**
     * Check if phone is currently connected via BLE. Part of OtaHelper.PhoneConnectionProvider
     * interface.
     *
     * <p>When the BES has reported phone BLE presence (firmware >= 17.26.7.23: sr_phble edges,
     * phone_ble in sr_syvr), that report is authoritative. When presence is UNKNOWN — the entire
     * deployed fleet today — this keeps the historical transport-based answer: OTA (and the wifi
     * scan/set flows that ride the same provider) must keep working against old BES firmware.
     */
    @Override
    public boolean isPhoneConnected() {
        if (transport instanceof K900BluetoothManager) {
            LinkStateMachine.PhonePresence presence =
                    ((K900BluetoothManager) transport).getLinkStateMachine().getPhonePresence();
            if (presence != LinkStateMachine.PhonePresence.UNKNOWN) {
                return presence == LinkStateMachine.PhonePresence.PRESENT;
            }
        }
        return transport != null && transport.isConnected();
    }

    /** Send a non-session OTA control message (e.g. {@code ota_start_ack}) over BLE. */
    @Override
    public void sendOtaMessage(JSONObject message) {
        if (!isPhoneConnected()) return;
        try {
            String jsonString = message.toString();
            transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
            Log.d(TAG, "📱 OTA message sent: " + message.optString("type", "?"));
        } catch (Exception e) {
            Log.e(TAG, "📱 Error sending OTA message", e);
        }
    }

    /**
     * Send unified {@code ota_status} to the phone. Glasses send a flat JSON object (no {@code
     * data} wrapper). Terminal {@code complete} / {@code failed} use reliable delivery.
     */
    @Override
    public void sendOtaStatus(JSONObject status) {
        if (!isPhoneConnected()) return;

        String statusValue = status.optString("status", "");
        boolean isTerminal = "complete".equals(statusValue) || "failed".equals(statusValue);

        try {
            if (isTerminal) {
                // Keep the state-rich snapshot in diagnostics, but put only the fields the phone
                // needs to end the flow on the critical wire. This must remain one legacy v1
                // notification even after ReliableMessageManager appends its mId.
                BleTraceLogger.logEvent(
                        "glasses_to_phone", "ota_diagnostic", "terminal_status", status);
                JSONObject compactStatus = compactTerminalOtaStatus(status);
                boolean sent = reliableManager.sendMessage(compactStatus);
                Log.i(TAG, "📱 OTA Status (reliable): " + statusValue + " sent=" + sent);
            } else {
                String jsonString = status.toString();
                transport.sendMessage(jsonString.getBytes(StandardCharsets.UTF_8));
                Log.d(TAG, "📱 OTA Status: " + statusValue);
            }
        } catch (Exception e) {
            Log.e(TAG, "📱 Error sending OTA status", e);
        }
    }

    static JSONObject compactTerminalOtaStatus(JSONObject status) throws JSONException {
        JSONObject compact = new JSONObject();
        compact.put("type", "ota_status");
        compact.put("status", status.optString("status", "failed"));

        String sessionId = status.optString("sid", status.optString("session_id", ""));
        if (!sessionId.isEmpty()) {
            compact.put("sid", sessionId);
        }

        String stepType = status.optString("st", status.optString("step_type", ""));
        if (!stepType.isEmpty()) {
            compact.put("st", stepType);
        }
        String phase = status.optString("phase", "");
        if (!phase.isEmpty()) {
            compact.put("phase", phase);
        }

        if ("complete".equals(compact.optString("status"))) {
            int overall = status.optInt("op", status.optInt("overall_percent", 100));
            compact.put("op", overall);
        }

        if ("failed".equals(compact.optString("status"))) {
            String error = status.optString("err", status.optString("error_message", ""));
            compact.put("err", compactErrorCode(error, phase));
        }
        return compact;
    }

    private static String compactErrorCode(String error, String phase) {
        if (error.matches("[a-z0-9_]{1,48}")) {
            return error;
        }
        return "download".equals(phase) ? "download_failed" : "install_failed";
    }
}
