package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.HotspotTriggerEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

/**
 * Reacts to {@link HotspotTriggerEvent}s by starting the local Wi-Fi hotspot. Moved verbatim from
 * {@code K900CommandHandler.handleHotspotStart}.
 */
public final class HotspotEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "HotspotEventSubscriber";

    private final AsgClientServiceManager serviceManager;

    public HotspotEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof HotspotTriggerEvent)) {
            return;
        }
        Log.d(TAG, "📦 Starting hotspot from K900 command");
        if (serviceManager != null && serviceManager.getNetworkManager() != null) {
            serviceManager.getNetworkManager().startHotspot();
        }
    }
}
