package com.mentra.asg_client.service.core.handlers.subscribers;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

/**
 * Reacts to {@link FileTransferAckEvent}s by forwarding the ACK to the active {@link
 * ICompanionTransport}'s error-queue processing. Moved verbatim from {@code
 * K900CommandHandler.handleFileTransferAck}.
 *
 * <p>Note: during active UART file TX, {@code K900BluetoothManager} short-circuits {@code cs_flts}
 * ACKs before they reach CommandProcessor, so this subscriber is mainly a fallback path.
 */
public final class FileTransferAckEventSubscriber implements IPeripheralBus.McuEventListener {

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

        // Forward the ACK to the active transport (no per-ACK logging — hot path).
        ICompanionTransport transport = serviceManager.getBluetoothManager();
        if (transport != null) {
            transport.onFileTransferAck(state, index);
        }
    }
}
