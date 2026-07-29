package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.bes.log.BesLogManager;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.McuEventParser;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Handles K900 protocol commands received from the BES/MCU chip over UART. Acts as a thin
 * dispatcher: inbound commands are parsed into typed {@link McuEvent}s by {@link McuEventParser}
 * and published on the {@link IPeripheralBus} for focused subscribers to react to.
 *
 * <p>This class still owns the BES log session and the outgoing (MTK -> BES) command builders,
 * which are request/response flows rather than inbound events.
 */
public class K900CommandHandler {
    private static final String TAG = "K900CommandHandler";

    private final AsgClientServiceManager serviceManager;
    private final IStateManager stateManager;
    private final ICommunicationManager communicationManager;
    private final IPeripheralBus peripheralBus;

    private BesLogManager mBesLogSession;

    public K900CommandHandler(
            AsgClientServiceManager serviceManager,
            IStateManager stateManager,
            ICommunicationManager communicationManager,
            IPeripheralBus peripheralBus) {
        this.serviceManager = serviceManager;
        this.stateManager = stateManager;
        this.communicationManager = communicationManager;
        this.peripheralBus = peripheralBus;
    }

    /**
     * Process K900 protocol commands by parsing them into typed events and publishing them on the
     * peripheral bus.
     *
     * @param json The K900 command JSON
     */
    public void processK900Command(JSONObject json) {
        try {
            String command = json.optString("C", "");
            JSONObject bData = json.optJSONObject("B");
            Log.d(TAG, "📦 Received K900 command: " + command);

            // sr_log is consumed here directly: packets are reassembled into the BES log session
            // owned by the outgoing mh_logs request flow (requestBesLogs*), which lives in this
            // class. It is not routed through the peripheral bus.
            if ("sr_log".equals(command)) {
                handleBesLogPacket(bData);
                return;
            }

            McuEvent event = McuEventParser.parse(json);
            if (event != null) {
                peripheralBus.publish(event);
            } else {
                Log.d(TAG, "📦 No event produced for K900 command: " + command);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error processing K900 command", e);
        }
    }

    /**
     * Handle a streamed sr_log packet from BES (response to our mh_logs request). Delegates
     * reassembly to the active BesLogManager session.
     */
    private void handleBesLogPacket(JSONObject bData) {
        if (mBesLogSession == null) {
            Log.w(TAG, "📥 sr_log received but no active BES log session — ignoring");
            return;
        }

        if (bData == null) {
            Log.w(TAG, "📥 sr_log received but B field is null — ignoring");
            return;
        }

        int cur = bData.optInt("cur", -1);
        String body = bData.optString("body", null);

        if (cur == -1) {
            Log.w(TAG, "📥 sr_log packet missing cur field — ignoring");
            return;
        }

        JSONObject tracePayload = new JSONObject();
        try {
            tracePayload.put("cur", cur);
            tracePayload.put("chars", body != null ? body.length() : 0);
            tracePayload.put("terminator", cur == 255 && "end".equals(body));
        } catch (JSONException ignored) {
            // Keep trace logging non-fatal.
        }
        BleTraceLogger.logEvent("bes_to_asg", "bes_log_stream", "sr_log", tracePayload);

        mBesLogSession.onLogPacketReceived(cur, body);
    }

    public boolean hasActiveBesLogSession() {
        return mBesLogSession != null && !mBesLogSession.isFinished();
    }

    /**
     * Send mh_logs to BES and collect the streamed sr_log response, then upload the assembled BES
     * trace buffer to the incident backend as "glasses_firmware".
     *
     * @param incidentId incident record to attach logs to
     * @param context application context
     * @param configManager provides coreToken for backend auth
     */
    public void requestBesLogs(
            String incidentId, Context context, IConfigurationManager configManager) {
        requestBesLogs(incidentId, context, configManager, "", null);
    }

    /**
     * Like {@link #requestBesLogs(String, Context, IConfigurationManager)} but uploads to {@code
     * apiBaseUrl} instead of the glasses' built-in server config. Falls back to {@link
     * com.mentra.asg_client.utils.ServerConfigUtil} when {@code apiBaseUrl} is empty.
     *
     * @param apiBaseUrl backend base URL from the phone (e.g. from sendIncidentId JSON); empty or
     *     null to use glasses' own ServerConfigUtil
     */
    public void requestBesLogs(
            String incidentId,
            Context context,
            IConfigurationManager configManager,
            String apiBaseUrl) {
        requestBesLogs(incidentId, context, configManager, apiBaseUrl, null);
    }

    /**
     * BLE-relay variant: assembled BES logs are delivered to {@code relayFirmwareJson} instead of
     * being uploaded over HTTP.
     */
    public void requestBesLogs(
            String incidentId,
            Context context,
            IConfigurationManager configManager,
            java.util.function.Consumer<String> relayFirmwareJson) {
        requestBesLogs(incidentId, context, configManager, "", relayFirmwareJson);
    }

    /**
     * @param apiBaseUrl backend base URL from the phone; empty/null to use glasses' own
     *     ServerConfigUtil (only used when {@code relayFirmwareJson} is null)
     * @param relayFirmwareJson if non-null, assembled BES logs are passed to this consumer as
     *     glasses_firmware JSON instead of HTTP upload
     */
    public void requestBesLogs(
            String incidentId,
            Context context,
            IConfigurationManager configManager,
            String apiBaseUrl,
            java.util.function.Consumer<String> relayFirmwareJson) {
        Log.i(TAG, "📋 Requesting BES logs (mh_logs) for incident: " + incidentId);

        if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
            Log.w(TAG, "⚠️ BluetoothManager unavailable — cannot request BES logs");
            if (relayFirmwareJson != null) {
                relayFirmwareJson.accept(BesLogManager.buildFirmwareUploadJson(""));
            }
            return;
        }

        if (!serviceManager.getBluetoothManager().isConnected()) {
            Log.w(TAG, "⚠️ UART not connected — cannot request BES logs");
            if (relayFirmwareJson != null) {
                relayFirmwareJson.accept(BesLogManager.buildFirmwareUploadJson(""));
            }
            return;
        }

        // Replace any stale session from a previous request
        mBesLogSession =
                (relayFirmwareJson != null)
                        ? new BesLogManager(incidentId, context, configManager, relayFirmwareJson)
                        : new BesLogManager(incidentId, context, configManager, apiBaseUrl);

        try {
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "mh_logs");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
            Log.d(TAG, "📤 Sending mh_logs: " + commandStr);

            boolean sent =
                    serviceManager
                            .getBluetoothManager()
                            .sendMessage(
                                    commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            if (sent) {
                Log.i(TAG, "✅ mh_logs sent — starting BES log collection timeouts");
                mBesLogSession.startTimeouts();
            } else {
                Log.e(TAG, "❌ Failed to send mh_logs");
                mBesLogSession = null;
                if (relayFirmwareJson != null) {
                    relayFirmwareJson.accept(BesLogManager.buildFirmwareUploadJson(""));
                }
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error building mh_logs command", e);
            mBesLogSession = null;
            if (relayFirmwareJson != null) {
                relayFirmwareJson.accept(BesLogManager.buildFirmwareUploadJson(""));
            }
        }
    }

    public boolean requestBesLogsForTrace(
            Context context,
            IConfigurationManager configManager,
            java.util.function.Consumer<String> rawLogCallback) {
        if (hasActiveBesLogSession()) {
            Log.d(TAG, "Skipping BES trace poll because a BES log session is already active");
            return false;
        }

        if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
            Log.w(TAG, "⚠️ BluetoothManager unavailable — cannot request BES trace logs");
            return false;
        }

        if (!serviceManager.getBluetoothManager().isConnected()) {
            Log.w(TAG, "⚠️ UART not connected — cannot request BES trace logs");
            return false;
        }

        mBesLogSession = BesLogManager.forRawLogCallback(context, configManager, rawLogCallback);
        try {
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "mh_logs");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
            Log.d(TAG, "📤 Sending trace mh_logs: " + commandStr);

            boolean sent =
                    serviceManager
                            .getBluetoothManager()
                            .sendMessage(
                                    commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            if (sent) {
                mBesLogSession.startTimeouts();
                return true;
            }

            Log.e(TAG, "❌ Failed to send trace mh_logs");
            mBesLogSession = null;
            return false;
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error building trace mh_logs command", e);
            mBesLogSession = null;
            return false;
        }
    }

    /**
     * Request BES firmware version and MAC address from BES chipset. Sends sh_syvr command to BES,
     * which responds with hs_syvr containing: - version: BES firmware version (e.g., "17.26.1.14")
     * - btaddr: Bluetooth MAC address - bleaddr: BLE MAC address
     *
     * <p>This ensures version info is cached before phone connects, making it available for OTA
     * patch matching and version_info messages to the phone.
     */
    public void requestSystemVersion() {
        Log.i(TAG, "🔧 Requesting BES system version (sh_syvr)");

        if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
            Log.w(TAG, "⚠️ ServiceManager or Bluetooth manager unavailable");
            return;
        }

        if (!serviceManager.getBluetoothManager().isConnected()) {
            Log.w(TAG, "⚠️ Bluetooth not connected; cannot request BES system version");
            return;
        }

        try {
            // Build full K900 format: C, V, B (all three required to avoid double-wrapping!)
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "sh_syvr");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
            Log.d(TAG, "📤 Sending sh_syvr request: " + commandStr);

            // Send via BluetoothManager - response handled by BesVersionEventSubscriber
            boolean sent =
                    serviceManager
                            .getBluetoothManager()
                            .sendMessage(
                                    commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            if (sent) {
                Log.i(TAG, "✅ BES system version request (sh_syvr) sent successfully");
            } else {
                Log.e(TAG, "❌ Failed to send BES system version request");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Failed to build sh_syvr request", e);
        }
    }

    /**
     * Send request to BES chip to get BT MAC address (cs_btaddr) Call this on startup/UART
     * connection to retrieve the unique device identifier
     */
    public void requestBtMacAddress() {
        Log.i(TAG, "📋 Requesting BT MAC address from BES chip");

        try {
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "cs_btaddr");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
            Log.d(TAG, "📤 Sending BT MAC request: " + commandStr);

            if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
                Log.w(TAG, "⚠️ ServiceManager or Bluetooth manager unavailable");
                return;
            }

            if (!serviceManager.getBluetoothManager().isConnected()) {
                Log.w(TAG, "⚠️ Bluetooth not connected; cannot request BT MAC address");
                return;
            }

            boolean sent =
                    serviceManager
                            .getBluetoothManager()
                            .sendMessage(
                                    commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            if (sent) {
                Log.i(TAG, "✅ BT MAC address request sent");
            } else {
                Log.e(TAG, "❌ Failed to send BT MAC address request");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating BT MAC address request", e);
        }
    }
}
