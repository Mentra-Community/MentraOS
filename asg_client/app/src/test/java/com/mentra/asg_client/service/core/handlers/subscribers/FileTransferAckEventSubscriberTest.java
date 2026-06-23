package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies {@link FileTransferAckEventSubscriber} forwards MCU ACK frames through the {@link
 * ICompanionTransport} interface. Uses a plain transport mock (NOT a K900 type) — regression guard
 * for the old {@code (K900BluetoothManager)} cast.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FileTransferAckEventSubscriberTest {

    private AsgClientServiceManager serviceManager;
    private ICompanionTransport transport;
    private FileTransferAckEventSubscriber subscriber;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        subscriber = new FileTransferAckEventSubscriber(serviceManager);
    }

    @Test
    public void fileTransferAck_forwardedToTransport() {
        subscriber.onMcuEvent(new FileTransferAckEvent(1, 7));

        verify(transport).onFileTransferAck(1, 7);
    }

    @Test
    public void otherMcuEvent_ignored() {
        subscriber.onMcuEvent(new ShutdownEvent());

        verify(transport, never()).onFileTransferAck(anyInt(), anyInt());
    }

    @Test
    public void transportUnavailable_doesNotThrow() {
        when(serviceManager.getBluetoothManager()).thenReturn(null);

        subscriber.onMcuEvent(new FileTransferAckEvent(0, 3));
        // No exception expected; nothing to forward without a transport.
    }
}
