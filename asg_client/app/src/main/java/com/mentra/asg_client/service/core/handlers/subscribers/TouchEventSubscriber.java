package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.TouchEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reacts to {@link TouchEvent}s by forwarding the gesture to the phone over BLE. Moved verbatim from
 * {@code K900CommandHandler.handleTouchEventReport}/{@code sendTouchEventOverBle}.
 */
public final class TouchEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "TouchEventSubscriber";

    private final AsgClientServiceManager serviceManager;

    public TouchEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof TouchEvent)) {
            return;
        }
        int type = ((TouchEvent) event).getGestureType();

        String gestureType = getTouchGestureType(type);
        Log.i(TAG, "📦 Touch event - Type: " + gestureType + " (" + type + ")");

        // Send touch event over BLE
        sendTouchEventOverBle(type);
    }

    /** Send touch event over BLE */
    private void sendTouchEventOverBle(int type) {
        if (serviceManager != null
                && serviceManager.getBluetoothManager() != null
                && serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "touch_event");
                obj.put("gesture_type", type);
                obj.put("gesture_name", getTouchGestureType(type));
                obj.put("timestamp", System.currentTimeMillis());

                String jsonString = obj.toString();
                Log.d(TAG, "📤 Sending touch event: " + jsonString);
                serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating touch event JSON", e);
            }
        }
    }

    /** Get touch gesture type name */
    private String getTouchGestureType(int type) {
        switch (type) {
            case 0:
                return "single_tap";
            case 1:
                return "double_tap";
            case 2:
                return "triple_tap";
            case 3:
                return "long_press";
            case 4:
                return "forward_swipe";
            case 5:
                return "backward_swipe";
            case 6:
                return "up_swipe";
            case 7:
                return "down_swipe";
            default:
                return "unknown";
        }
    }
}
