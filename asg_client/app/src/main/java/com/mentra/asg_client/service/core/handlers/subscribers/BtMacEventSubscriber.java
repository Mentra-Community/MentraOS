package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.BtMacEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.utils.SysProp;

/**
 * Reacts to {@link BtMacEvent}s by persisting the BES Bluetooth MAC address to system properties.
 * Moved verbatim from {@code K900CommandHandler.handleBtAddrResponse}.
 */
public final class BtMacEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "BtMacEventSubscriber";

    private final AsgClientServiceManager serviceManager;

    public BtMacEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof BtMacEvent)) {
            return;
        }
        String btAddr = ((BtMacEvent) event).getMacAddress();
        String normalizedBtAddr = SysProp.normalizeBesBtMac(btAddr);
        if (normalizedBtAddr.isEmpty()) {
            Log.w(TAG, "⚠️ Ignoring invalid BT MAC address received from BES");
            return;
        }

        Log.i(TAG, "📋 Valid BT MAC address received from BES");

        // Save to system properties (persistent across reboots)
        if (serviceManager != null && serviceManager.getContext() != null) {
            SysProp.setBesBtMac(serviceManager.getContext(), normalizedBtAddr);
            Log.i(TAG, "✅ BT MAC Address saved to system properties");
            if (serviceManager.getService() != null) {
                Log.i(TAG, "📋 BES BT MAC cached - re-sending version info to phone");
                serviceManager.getService().sendVersionInfo();
            }
        } else {
            Log.w(TAG, "⚠️ Service context not available - cannot save BT MAC");
        }
    }
}
