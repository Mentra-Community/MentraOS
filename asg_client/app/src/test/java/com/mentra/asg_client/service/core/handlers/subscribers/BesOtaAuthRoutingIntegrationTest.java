package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.SimplePeripheralBus;
import com.mentra.asg_client.io.peripheral.events.BesOtaAuthEvent;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Integration test for the event-bus-to-interface seam: a REAL {@link SimplePeripheralBus} with
 * REAL subscribers, asserting MCU events land on the core {@link IBesOtaController} and {@link
 * ICompanionTransport} interfaces — the exact boundary the A6 module split cuts.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesOtaAuthRoutingIntegrationTest {

    private AsgClientServiceManager serviceManager;
    private IBesOtaController otaController;
    private ICompanionTransport transport;
    private IPeripheralBus bus;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        otaController = mock(IBesOtaController.class);
        transport = mock(ICompanionTransport.class);
        when(serviceManager.getBesOtaManager()).thenReturn(otaController);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);

        bus = new SimplePeripheralBus();
        bus.subscribe(new BesOtaAuthEventSubscriber(serviceManager));
        bus.subscribe(new FileTransferAckEventSubscriber(serviceManager));
    }

    @Test
    public void authGrantedEvent_reachesControllerInterface() {
        bus.publish(new BesOtaAuthEvent(true));

        verify(otaController).onAuthorizationGranted();
        verify(otaController, never()).onAuthorizationDenied();
    }

    @Test
    public void authDeniedEvent_reachesControllerInterface() {
        bus.publish(new BesOtaAuthEvent(false));

        verify(otaController).onAuthorizationDenied();
        verify(otaController, never()).onAuthorizationGranted();
    }

    @Test
    public void fileTransferAckEvent_reachesTransportInterface() {
        bus.publish(new FileTransferAckEvent(1, 12));

        verify(transport).onFileTransferAck(1, 12);
    }

    @Test
    public void eventsRouteIndependently_ackDoesNotTouchOtaController() {
        bus.publish(new FileTransferAckEvent(0, 3));

        verify(otaController, never()).onAuthorizationGranted();
        verify(otaController, never()).onAuthorizationDenied();
        verify(transport, never()).onMtuNegotiated(anyInt());
    }
}
