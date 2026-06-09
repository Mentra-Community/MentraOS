package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.SwitchEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reacts to {@link SwitchEvent}s by forwarding the switch status to the phone over BLE. Moved
 * verbatim from {@code K900CommandHandler.handleSwitchStatusReport}/{@code sendSwitchStatusOverBle}.
 */
public final class SwitchEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "SwitchEventSubscriber";

    private final AsgClientServiceManager serviceManager;

    public SwitchEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof SwitchEvent)) {
            return;
        }
        SwitchEvent switchEvent = (SwitchEvent) event;
        int type = switchEvent.getType();
        int switchValue = switchEvent.getSwitchValue();

        Log.i(TAG, "📦 Switch status - Type: " + type + ", Switch: " + switchValue);

        // Send switch status over BLE
        sendSwitchStatusOverBle(type, switchValue);
    }

    /** Send switch status over BLE */
    private void sendSwitchStatusOverBle(int type, int switchValue) {
        if (serviceManager != null
                && serviceManager.getBluetoothManager() != null
                && serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "switch_status");
                obj.put("switch_type", type);
                obj.put("switch_value", switchValue);
                obj.put("timestamp", System.currentTimeMillis());

                String jsonString = obj.toString();
                Log.d(TAG, "📤 Sending switch status: " + jsonString);
                serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating switch status JSON", e);
            }
        }
    }
}
