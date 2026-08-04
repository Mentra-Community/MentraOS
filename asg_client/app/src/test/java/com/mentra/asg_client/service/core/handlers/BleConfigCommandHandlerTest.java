package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies {@link BleConfigCommandHandler} forwards the negotiated MTU to the transport interface
 * (no {@code BesWireFormat} statics, no vendor casts).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BleConfigCommandHandlerTest {

    private AsgClientServiceManager serviceManager;
    private ICompanionTransport transport;
    private BleConfigCommandHandler handler;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        handler = new BleConfigCommandHandler(serviceManager);
    }

    @Test
    public void setBleMtu_forwardsMtuToTransport() throws Exception {
        boolean handled = handler.handleCommand("set_ble_mtu", new JSONObject().put("mtu", 251));

        assertThat(handled).isTrue();
        verify(transport).onMtuNegotiated(251);
    }

    @Test
    public void setBleMtu_zeroMtu_rejectedWithoutTouchingTransport() throws Exception {
        boolean handled = handler.handleCommand("set_ble_mtu", new JSONObject().put("mtu", 0));

        assertThat(handled).isFalse();
        verify(transport, never()).onMtuNegotiated(anyInt());
    }

    @Test
    public void setBleMtu_missingMtu_rejectedWithoutTouchingTransport() {
        boolean handled = handler.handleCommand("set_ble_mtu", new JSONObject());

        assertThat(handled).isFalse();
        verify(transport, never()).onMtuNegotiated(anyInt());
    }

    @Test
    public void setBleMtu_transportUnavailable_failsGracefully() throws Exception {
        when(serviceManager.getBluetoothManager()).thenReturn(null);

        boolean handled = handler.handleCommand("set_ble_mtu", new JSONObject().put("mtu", 251));

        assertThat(handled).isFalse();
    }

    @Test
    public void unsupportedCommandType_rejected() {
        boolean handled = handler.handleCommand("not_a_ble_command", new JSONObject());

        assertThat(handled).isFalse();
        verify(transport, never()).onMtuNegotiated(anyInt());
    }
}
