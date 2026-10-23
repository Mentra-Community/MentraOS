package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.MtkPingEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.nio.charset.StandardCharsets;

/**
 * Answers the BES liveness probe. BES opens a pairing window only after this reply, because its
 * MTK-ready latch and the MTK GPIOs cannot tell a running Android from a rebooting one.
 */
public final class MtkPingEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "MtkPingEventSubscriber";
    static final String PONG = "{\"C\":\"cs_mtkpong\",\"V\":1,\"B\":\"\"}";

    private final AsgClientServiceManager serviceManager;

    public MtkPingEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof MtkPingEvent)) {
            return;
        }
        ICompanionTransport transport =
                serviceManager != null ? serviceManager.getBluetoothManager() : null;
        if (transport == null) {
            Log.w(TAG, "hm_mtkping received but UART transport unavailable");
            return;
        }
        boolean sent = transport.sendMessage(PONG.getBytes(StandardCharsets.UTF_8));
        Log.i(TAG, "hm_mtkping -> cs_mtkpong sent=" + sent);
    }
}
