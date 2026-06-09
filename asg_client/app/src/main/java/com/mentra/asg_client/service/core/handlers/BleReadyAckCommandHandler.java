package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.io.bluetooth.managers.BlePhotoReadyAck;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import java.util.Set;
import org.json.JSONObject;

/** Handles {@code ble_ready_ack} from the phone after {@code ble_photo_ready}. */
public class BleReadyAckCommandHandler implements ICommandHandler {

    private static final String TAG = "BleReadyAckHandler";

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("ble_ready_ack");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            if (!"ble_ready_ack".equals(commandType)) {
                return false;
            }
            String requestId = data.optString("requestId", "");
            if (requestId.isEmpty()) {
                Log.w(TAG, "ble_ready_ack missing requestId");
                return false;
            }
            BlePhotoReadyAck.signal(requestId);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling ble_ready_ack", e);
            return false;
        }
    }
}
