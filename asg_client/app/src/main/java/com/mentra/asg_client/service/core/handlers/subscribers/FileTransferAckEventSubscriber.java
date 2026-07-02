package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

/**
 * Reacts to {@link FileTransferAckEvent}s by forwarding the ACK to the active {@link
 * ICompanionTransport}'s error-queue processing. Moved verbatim from {@code
 * K900CommandHandler.handleFileTransferAck}.
 */
public final class FileTransferAckEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "FileTransferAckEventSubscriber";

    private final AsgClientServiceManager serviceManager;

    public FileTransferAckEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof FileTransferAckEvent)) {
            return;
        }
        if (serviceManager == null) {
            return;
        }
        FileTransferAckEvent ackEvent = (FileTransferAckEvent) event;
        int state = ackEvent.getState();
        int index = ackEvent.getIndex();

        Log.d(TAG, "📦 File transfer ACK: state=" + state + ", index=" + index);

        // Forward the ACK to the active transport
        ICompanionTransport transport = serviceManager.getBluetoothManager();
        if (transport != null) {
            transport.onFileTransferAck(state, index);
        }
    }
}
