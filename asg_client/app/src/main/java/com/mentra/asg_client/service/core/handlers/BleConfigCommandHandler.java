package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.utils.smartglasses.K900ProtocolUtils;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for BLE configuration commands from the phone.
 * Handles MTU configuration to adjust file packet sizes.
 */
public class BleConfigCommandHandler implements ICommandHandler {
    private static final String TAG = "BleConfigCommandHandler";

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
     * Handle set BLE MTU command from phone.
     * Adjusts file packet size to fit within the negotiated MTU.
     */
    private boolean handleSetBleMtu(JSONObject data) {
        Log.i(TAG, "📦 handleSetBleMtu() called with data: " + (data != null ? data.toString() : "null"));

        int mtu = data.optInt("mtu", 0);
        Log.i(TAG, "📦 Extracted MTU value: " + mtu);

        if (mtu <= 0) {
            Log.e(TAG, "❌ Invalid MTU value: " + mtu);
            return false;
        }

        Log.i(TAG, "📦 ✅ Setting pack size from MTU: " + mtu);
        int oldPackSize = K900ProtocolUtils.getFilePackSize();
        K900ProtocolUtils.setFilePackSizeFromMtu(mtu);
        int newPackSize = K900ProtocolUtils.getFilePackSize();

        // Log the effective pack size for debugging
        int totalPacketSize = newPackSize + 32; // 32 bytes protocol overhead
        Log.i(TAG, "📦 =========================================");
        Log.i(TAG, "📦 FILE PACK SIZE CHANGED");
        Log.i(TAG, "📦 Old pack size: " + oldPackSize);
        Log.i(TAG, "📦 New pack size: " + newPackSize);
        Log.i(TAG, "📦 Total packet size: " + totalPacketSize);
        Log.i(TAG, "📦 MTU effective: " + (mtu - 3));
        Log.i(TAG, "📦 =========================================");

        return true;
    }
}
