package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.BtMacEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.utils.SysProp;

/**
 * Reacts to {@link BtMacEvent}s by persisting the BES Bluetooth MAC address to system properties.
 * Moved verbatim from {@code K900CommandHandler.handleBtAddrResponse}.
 */
public final class BtMacEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "BtMacEventSubscriber";

    private final Context context;

    public BtMacEventSubscriber(Context context) {
        this.context = context;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof BtMacEvent)) {
            return;
        }
        String btAddr = ((BtMacEvent) event).getMacAddress();

        Log.i(TAG, "📋 BT MAC Address received from BES: " + btAddr);

        // Save to system properties (persistent across reboots)
        if (context != null) {
            SysProp.setBesBtMac(context, btAddr);
            Log.i(TAG, "✅ BT MAC Address saved to system properties");
        } else {
            Log.w(TAG, "⚠️ Context not available - cannot save BT MAC to system properties");
        }
    }
}
