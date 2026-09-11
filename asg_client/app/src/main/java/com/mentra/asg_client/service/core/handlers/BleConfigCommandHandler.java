package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.util.Set;
import org.json.JSONObject;

/**
 * Handler for BLE configuration commands from the phone. Handles MTU configuration so the active
 * transport can adjust its file packet sizes.
 */
public class BleConfigCommandHandler implements ICommandHandler {
    private static final String TAG = "BleConfigCommandHandler";

    private final AsgClientServiceManager serviceManager;

    public BleConfigCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("set_ble_mtu");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        Log.i(TAG, "📦 =========================================");
        Log.i(TAG, "📦 BLE CONFIG COMMAND RECEIVED");
        Log.i(TAG, "📦 =========================================");
        Log.i(TAG, "📦 Command type: " + commandType);
        Log.i(TAG, "📦 Data: " + (data != null ? data.toString() : "null"));

        try {
            if ("set_ble_mtu".equals(commandType)) {
                return handleSetBleMtu(data);
            }
            Log.e(TAG, "Unsupported BLE config command: " + commandType);
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error handling BLE config command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle set BLE MTU command from phone. Forwards the negotiated MTU to the active transport
     * so it can adjust its packet sizes.
     */
    private boolean handleSetBleMtu(JSONObject data) {
        Log.i(
                TAG,
                "📦 handleSetBleMtu() called with data: "
                        + (data != null ? data.toString() : "null"));

        int mtu = data.optInt("mtu", 0);
        Log.i(TAG, "📦 Extracted MTU value: " + mtu);

        if (mtu <= 0) {
            Log.e(TAG, "❌ Invalid MTU value: " + mtu);
            return false;
        }

        ICompanionTransport transport =
                serviceManager != null ? serviceManager.getBluetoothManager() : null;
        if (transport == null) {
            Log.e(TAG, "❌ Transport not available - cannot apply MTU " + mtu);
            return false;
        }

        Log.i(TAG, "📦 ✅ Forwarding negotiated MTU to transport: " + mtu);
        transport.onMtuNegotiated(mtu);

        return true;
    }
}
