package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.util.Log;

import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.system.interfaces.IStateManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for battery-related commands.
 * Follows Single Responsibility Principle by handling only battery commands.
 */
public class BatteryCommandHandler implements ICommandHandler {
    private static final String TAG = "BatteryCommandHandler";

    private final IStateManager stateManager;
    private final ICommunicationManager communicationManager;
    private final Context context;

    public BatteryCommandHandler(IStateManager stateManager,
                                 ICommunicationManager communicationManager,
                                 Context context) {
        this.stateManager = stateManager;
        this.communicationManager = communicationManager;
        this.context = context;
    }

    // Keep backward-compatible constructor for existing callers
    public BatteryCommandHandler(IStateManager stateManager) {
        this.stateManager = stateManager;
        this.communicationManager = null;
        this.context = null;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("battery_status", "request_battery_state", "request_battery_status");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "battery_status":
                    return handleBatteryStatus(data);
                case "request_battery_state":
                case "request_battery_status":
                    return handleRequestBatteryStatus();
                default:
                    Log.e(TAG, "Unsupported battery command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling battery command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle battery status command (phone pushing status to us)
     */
    private boolean handleBatteryStatus(JSONObject data) {
        try {
            int level = data.optInt("level", -1);
            boolean charging = data.optBoolean("charging", false);
            long timestamp = data.optLong("timestamp", System.currentTimeMillis());
            stateManager.updateBatteryStatus(level, charging, timestamp);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling battery status command", e);
            return false;
        }
    }

    /**
     * Handle request_battery_status — iOS asking glasses for current battery level.
     * Read from Android BatteryManager and send a JSON response over BLE.
     */
    private boolean handleRequestBatteryStatus() {
        try {
            int level = -1;
            boolean charging = false;

            if (context != null) {
                // Read battery level from Android system
                BatteryManager bm = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
                if (bm != null) {
                    level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                }

                // Read charging status
                IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
                Intent batteryStatus = context.registerReceiver(null, filter);
                if (batteryStatus != null) {
                    int status = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                    charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                            || status == BatteryManager.BATTERY_STATUS_FULL;
                }
            }

            Log.d(TAG, "🔋 Battery request: level=" + level + "% charging=" + charging);

            // Update state manager
            stateManager.updateBatteryStatus(level, charging, System.currentTimeMillis());

            // Send response back to iOS over BLE
            if (communicationManager != null) {
                JSONObject response = new JSONObject();
                response.put("type", "battery_status");
                response.put("level", level);
                response.put("charging", charging);
                response.put("timestamp", System.currentTimeMillis());
                boolean sent = communicationManager.sendBluetoothResponse(response);
                Log.d(TAG, "🔋 Battery response sent: " + sent + " → " + response);
                return sent;
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling request_battery_status", e);
            return false;
        }
    }

    /**
     * Handle battery status from K900 protocol
     */
    public boolean handleK900BatteryStatus(JSONObject bData) {
        try {
            if (bData != null) {
                int newBatteryPercentage = bData.optInt("pt", -1);
                int newBatteryVoltage = bData.optInt("vt", -1);

                if (newBatteryPercentage != -1) {
                    Log.d(TAG, "🔋 Battery percentage: " + newBatteryPercentage + "%");
                }
                if (newBatteryVoltage != -1) {
                    Log.d(TAG, "🔋 Battery voltage: " + newBatteryVoltage + "mV");
                }

                boolean isCharging = newBatteryVoltage > 3900;

                if (newBatteryPercentage != -1 || newBatteryVoltage != -1) {
                    stateManager.updateBatteryStatus(newBatteryPercentage, isCharging,
                            System.currentTimeMillis());
                    return true;
                }
            } else {
                Log.w(TAG, "hm_batv received but no B field data");
            }
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error handling K900 battery status", e);
            return false;
        }
    }
}