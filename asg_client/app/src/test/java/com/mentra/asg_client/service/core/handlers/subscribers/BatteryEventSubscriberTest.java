package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.peripheral.events.BatteryEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies {@link BatteryEventSubscriber} updates hardware/state and forwards status over BLE. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BatteryEventSubscriberTest {

    private IHardwareManager hardwareManager;
    private IStateManager stateManager;
    private AsgClientServiceManager serviceManager;
    private ICompanionTransport transport;
    private BatteryEventSubscriber subscriber;

    @Before
    public void setUp() {
        hardwareManager = mock(IHardwareManager.class);
        stateManager = mock(IStateManager.class);
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        when(transport.isConnected()).thenReturn(true);
        subscriber = new BatteryEventSubscriber(hardwareManager, stateManager, serviceManager);
    }

    @Test
    public void batteryEvent_updatesHardwareStateAndSendsBle() {
        subscriber.onMcuEvent(new BatteryEvent(85, 3900));

        verify(hardwareManager).notifyBatteryReading(85, 3900);
        // 3900 is not strictly greater than 3900, so charging is false.
        verify(stateManager).updateBatteryStatus(eq(85), eq(false), anyLong());
        verify(transport).sendMessage(any(byte[].class));
    }

    @Test
    public void batteryEvent_chargingWhenVoltageAboveThreshold() {
        subscriber.onMcuEvent(new BatteryEvent(90, 4100));

        verify(stateManager).updateBatteryStatus(eq(90), eq(true), anyLong());
    }

    @Test
    public void batteryEvent_noValidData_doesNotUpdateStateOrSendBle() {
        subscriber.onMcuEvent(new BatteryEvent(-1, -1));

        verify(hardwareManager).notifyBatteryReading(-1, -1);
        verify(stateManager, never()).updateBatteryStatus(org.mockito.ArgumentMatchers.anyInt(),
                org.mockito.ArgumentMatchers.anyBoolean(), anyLong());
        verify(transport, never()).sendMessage(any(byte[].class));
    }

    @Test
    public void batteryEvent_notConnected_updatesStateButSkipsBle() {
        when(transport.isConnected()).thenReturn(false);

        subscriber.onMcuEvent(new BatteryEvent(50, 3800));

        verify(stateManager).updateBatteryStatus(eq(50), eq(false), anyLong());
        verify(transport, never()).sendMessage(any(byte[].class));
    }
}
