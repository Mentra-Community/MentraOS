package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.SwipeVolumeEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reacts to {@link SwipeVolumeEvent}s by forwarding the swipe-volume status to the phone over BLE.
 * Moved verbatim from {@code K900CommandHandler.handleSwipeVolumeStatusReport}/{@code
 * sendSwipeVolumeStatusOverBle}.
 */
public final class SwipeVolumeEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "SwipeVolumeEventSubscriber";

    private final AsgClientServiceManager serviceManager;

    public SwipeVolumeEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof SwipeVolumeEvent)) {
            return;
        }
        boolean isEnabled = ((SwipeVolumeEvent) event).isEnabled();

        Log.i(TAG, "📦 Swipe volume status - Enabled: " + isEnabled);

        // Send swipe volume status over BLE
        sendSwipeVolumeStatusOverBle(isEnabled);
    }

    /** Send swipe volume status over BLE */
    private void sendSwipeVolumeStatusOverBle(boolean isEnabled) {
        if (serviceManager != null
                && serviceManager.getBluetoothManager() != null
                && serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "swipe_volume_status");
                obj.put("enabled", isEnabled);
                obj.put("timestamp", System.currentTimeMillis());

                String jsonString = obj.toString();
                Log.d(TAG, "📤 Sending swipe volume status: " + jsonString);
                serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating swipe volume status JSON", e);
            }
        }
    }
}
