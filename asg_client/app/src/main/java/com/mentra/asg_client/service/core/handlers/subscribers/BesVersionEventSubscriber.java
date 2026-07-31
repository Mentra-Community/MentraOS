package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.BesVersionEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.utils.SysProp;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reacts to {@link BesVersionEvent}s by caching the MCU firmware version, re-sending version info to
 * the phone, and requesting the BT MAC address when none is cached. Moved verbatim from {@code
 * K900CommandHandler.handleSystemVersionReport}.
 *
 * <p>The {@code cs_btaddr} request is replicated locally (rather than calling {@code
 * K900CommandHandler.requestBtMacAddress()}) because subscribers are constructed before the command
 * handler exists.
 */
public final class BesVersionEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "BesVersionEventSubscriber";

    private final AsgClientServiceManager serviceManager;
    private final Handler mainHandler;

    public BesVersionEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
        this.mainHandler = new Handler(Looper.getMainLooper());
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof BesVersionEvent)) {
            return;
        }
        BesVersionEvent versionEvent = (BesVersionEvent) event;
        String version = versionEvent.getFirmwareVersion();
        String bleName = versionEvent.getBleName();
        String btName = versionEvent.getBtName();
        String btAddr = versionEvent.getBtAddress();
        String bleAddr = versionEvent.getBleAddress();

        Log.i(TAG, "📋 System Version Report - Firmware: " + version);
        Log.i(TAG, "📋 BLE Name: " + bleName + ", BT Name: " + btName);
        Log.i(TAG, "📋 BT Address: " + btAddr + ", BLE Address: " + bleAddr);

        boolean metadataUpdated = false;

        // Cache the MCU firmware version so it can be sent to phone when connected
        if (serviceManager != null
                && serviceManager.getAsgSettings() != null
                && !version.equals("unknown")
                && !version.isEmpty()) {
            serviceManager.getAsgSettings().setMcuFirmwareVersion(version);
            metadataUpdated = true;
        }

        Context context = serviceManager != null ? serviceManager.getContext() : null;
        if (context != null && !SysProp.normalizeBesBtMac(btAddr).isEmpty()) {
            SysProp.setBesBtMac(context, btAddr);
            metadataUpdated = true;
        }

        // Re-send version info once all fresh BES metadata has been cached.
        if (metadataUpdated && serviceManager != null) {
            if (serviceManager.getService() != null) {
                Log.i(TAG, "📋 BES metadata cached - re-sending version info to phone");
                serviceManager.getService().sendVersionInfo();
            }
        }

        // Request BT MAC address from BES chip (if not already saved)
        // This is a good time to request since we know UART is working
        if (context != null) {
            String existingMac = SysProp.getBesBtMac(context);
            if (existingMac == null || existingMac.isEmpty()) {
                Log.i(TAG, "📋 No BT MAC address cached - requesting from BES chip");
                // Delay request slightly to allow BES to finish startup
                mainHandler.postDelayed(this::requestBtMacAddress, 500);
            } else {
                Log.d(TAG, "📋 BT MAC address already cached: " + existingMac);
            }
        }
    }

    /**
     * Send request to BES chip to get BT MAC address (cs_btaddr). Mirrors {@code
     * K900CommandHandler.requestBtMacAddress()}.
     */
    private void requestBtMacAddress() {
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
                            .sendMessage(commandStr.getBytes(StandardCharsets.UTF_8));

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
