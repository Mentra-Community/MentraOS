package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies {@link PhoneReadyCommandHandler} resets the transport through the {@link
 * ICompanionTransport} interface (instead of {@code BesWireFormat} statics) and completes the
 * glasses_ready handshake.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhoneReadyCommandHandlerTest {

    private ICommunicationManager communicationManager;
    private IStateManager stateManager;
    private IResponseBuilder responseBuilder;
    private AsgClientServiceManager serviceManager;
    private ICompanionTransport transport;
    private PhoneReadyCommandHandler handler;

    @Before
    public void setUp() throws Exception {
        communicationManager = mock(ICommunicationManager.class);
        stateManager = mock(IStateManager.class);
        responseBuilder = mock(IResponseBuilder.class);
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);

        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        when(responseBuilder.buildGlassesReadyResponse())
                .thenReturn(new JSONObject().put("type", "glasses_ready"));
        when(communicationManager.sendBluetoothResponse(any(JSONObject.class))).thenReturn(true);

        handler =
                new PhoneReadyCommandHandler(
                        communicationManager, stateManager, responseBuilder, serviceManager);
    }

    @Test
    public void phoneReady_resetsTransportAndSendsGlassesReady() {
        boolean handled = handler.handleCommand("phone_ready", new JSONObject());

        assertThat(handled).isTrue();
        verify(transport).onTransportReset();
        verify(communicationManager).sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void phoneReady_transportUnavailable_stillSendsGlassesReady() {
        when(serviceManager.getBluetoothManager()).thenReturn(null);

        boolean handled = handler.handleCommand("phone_ready", new JSONObject());

        assertThat(handled).isTrue();
        verify(communicationManager).sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void unsupportedCommandType_rejected() {
        boolean handled = handler.handleCommand("not_phone_ready", new JSONObject());

        assertThat(handled).isFalse();
    }
}
