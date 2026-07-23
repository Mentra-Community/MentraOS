package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.BatteryEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reacts to {@link BatteryEvent}s by updating the hardware battery cache, local state, and pushing a
 * battery_status message to the phone over BLE. Moved verbatim from {@code
 * K900CommandHandler.handleBatteryVoltage}/{@code sendBatteryStatusOverBle}.
 */
public final class BatteryEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "BatteryEventSubscriber";

    private final IHardwareManager hardwareManager;
    private final IStateManager stateManager;
    private final AsgClientServiceManager serviceManager;

    public BatteryEventSubscriber(
            IHardwareManager hardwareManager,
            IStateManager stateManager,
            AsgClientServiceManager serviceManager) {
        this.hardwareManager = hardwareManager;
        this.stateManager = stateManager;
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof BatteryEvent)) {
            return;
        }
        BatteryEvent batteryEvent = (BatteryEvent) event;
        int newBatteryPercentage = batteryEvent.getPercentage();
        int newBatteryVoltage = batteryEvent.getVoltageMillivolts();

        Log.d(TAG, "🔋 Processing battery voltage data from K900");
        if (newBatteryPercentage != -1) {
            Log.d(TAG, "🔋 Battery percentage: " + newBatteryPercentage + "%");
        }
        if (newBatteryVoltage != -1) {
            Log.d(TAG, "🔋 Battery voltage: " + newBatteryVoltage + "mV");
        }

        if (hardwareManager != null) {
            hardwareManager.notifyBatteryReading(newBatteryPercentage, newBatteryVoltage);
        }

        // Send battery status over BLE if we have valid data
        if (newBatteryPercentage != -1 || newBatteryVoltage != -1) {
            sendBatteryStatusOverBle(newBatteryPercentage, newBatteryVoltage);
        }
    }

    /** Send battery status over BLE */
    private void sendBatteryStatusOverBle(int batteryPercentage, int batteryVoltage) {
        // hm_batv carries no charge bit, so charging cannot be known here. The voltage
        // heuristic (>3900mV) is wrong for most of a Li-ion cell's range — a discharging
        // full pack reads "charging". Internal state keeps the heuristic (log-only
        // consumers), but the BLE message omits the flag: the phone sources charging
        // exclusively from the PMU charg bit in the sr_hrt heartbeat.
        boolean isCharging = batteryVoltage > 3900;

        // Always update local state, regardless of BLE connection
        if (stateManager != null) {
            stateManager.updateBatteryStatus(
                    batteryPercentage, isCharging, System.currentTimeMillis());
        }

        // Send to phone only if BLE is connected
        if (serviceManager != null
                && serviceManager.getBluetoothManager() != null
                && serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "battery_status");
                obj.put("percent", batteryPercentage);
                String jsonString = obj.toString();
                Log.d(TAG, "Formatted battery status message: " + jsonString);
                serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
                Log.d(TAG, "Sent battery status via BLE");
            } catch (JSONException e) {
                Log.e(TAG, "Error creating battery status JSON", e);
            }
        }
    }
}
