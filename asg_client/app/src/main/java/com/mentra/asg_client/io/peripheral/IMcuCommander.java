package com.mentra.asg_client.io.peripheral;

import android.content.Context;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * Outbound and inbound MCU command surface. Implemented by the vendor-specific MCU handler (e.g.
 * {@code K900CommandHandler} for Mentra Live). Core classes hold this interface so they stay free
 * of vendor imports.
 */
public interface IMcuCommander {

    /**
     * Process a raw vendor-protocol command payload received from the companion transport. For
     * Mentra Live this is a K900/BES frame already decoded from the UART bridge.
     *
     * @param json The decoded vendor command JSON
     */
    void processVendorProtocolCommand(JSONObject json);

    /** Ask the MCU for its current firmware version. Result arrives as a {@link
     * com.mentra.asg_client.io.peripheral.events.BesVersionEvent} on the peripheral bus. */
    void requestSystemVersion();

    /**
     * Pull the BES trace ring-buffer and optionally upload to the incident backend.
     *
     * @param incidentId incident ID to attach; null/empty to only print to logcat
     * @param context Android context
     * @param configManager configuration manager for server URL resolution
     */
    void requestBesLogs(String incidentId, Context context, IConfigurationManager configManager);

    /**
     * Like {@link #requestBesLogs(String, Context, IConfigurationManager)} but overrides the
     * upload base URL.
     */
    void requestBesLogs(
            String incidentId,
            Context context,
            IConfigurationManager configManager,
            String apiBaseUrl);

    /**
     * BLE-relay variant: assembled BES logs are delivered to {@code relayFirmwareJson} instead of
     * being uploaded over HTTP.
     */
    void requestBesLogs(
            String incidentId,
            Context context,
            IConfigurationManager configManager,
            Consumer<String> relayFirmwareJson);

    /**
     * Single-shot BES trace poll for the debug trace poller.
     *
     * @param context Android context
     * @param configManager configuration manager
     * @param rawLogCallback called with the assembled raw log text when complete
     * @return true if the request was dispatched, false if a log session is already active
     */
    boolean requestBesLogsForTrace(
            Context context,
            IConfigurationManager configManager,
            Consumer<String> rawLogCallback);

    /** Ask the MCU for its BT MAC address. Result arrives as a {@link
     * com.mentra.asg_client.io.peripheral.events.BtMacEvent} on the peripheral bus. */
    void requestBtMacAddress();
}
