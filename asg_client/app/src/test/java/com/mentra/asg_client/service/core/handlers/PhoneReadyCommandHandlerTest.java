package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhoneReadyCommandHandlerTest {

    @Test
    public void phoneReady_withOldBesStaysOnLegacyWirePath() throws Exception {
        ICommunicationManager communicationManager = mock(ICommunicationManager.class);
        IStateManager stateManager = mock(IStateManager.class);
        IResponseBuilder responseBuilder = mock(IResponseBuilder.class);
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        K900BluetoothManager bluetoothManager = mock(K900BluetoothManager.class);
        JSONObject response = new JSONObject().put("type", "glasses_ready");

        when(responseBuilder.buildGlassesReadyResponse()).thenReturn(response);
        when(communicationManager.sendBluetoothResponse(response)).thenReturn(true);
        when(serviceManager.getBluetoothManager()).thenReturn(bluetoothManager);
        when(bluetoothManager.isBesBinaryRelaySupported()).thenReturn(false);

        PhoneReadyCommandHandler handler =
                new PhoneReadyCommandHandler(
                        communicationManager, stateManager, responseBuilder, serviceManager);

        assertThat(handler.handleCommand("phone_ready", new JSONObject())).isTrue();

        assertThat(response.has("wire_caps")).isFalse();
        verify(bluetoothManager).addPhoneWireCapsIfSupported(response);
        verify(bluetoothManager, never()).sendWireV2Handshake();
    }

    @Test
    public void phoneReady_withNewBesAdvertisesCapsAndSendsWireHandshake() throws Exception {
        ICommunicationManager communicationManager = mock(ICommunicationManager.class);
        IStateManager stateManager = mock(IStateManager.class);
        IResponseBuilder responseBuilder = mock(IResponseBuilder.class);
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        K900BluetoothManager bluetoothManager = mock(K900BluetoothManager.class);
        JSONObject response = new JSONObject().put("type", "glasses_ready");

        when(responseBuilder.buildGlassesReadyResponse()).thenReturn(response);
        when(communicationManager.sendBluetoothResponse(response)).thenReturn(true);
        when(serviceManager.getBluetoothManager()).thenReturn(bluetoothManager);
        when(bluetoothManager.isBesBinaryRelaySupported()).thenReturn(true);
        doAnswer(
                        invocation -> {
                            JSONObject message = invocation.getArgument(0);
                            message.put(
                                    "wire_caps",
                                    new JSONObject()
                                            .put("k900_le", true)
                                            .put("binary", true)
                                            .put("proto", 2));
                            return null;
                        })
                .when(bluetoothManager)
                .addPhoneWireCapsIfSupported(any(JSONObject.class));

        PhoneReadyCommandHandler handler =
                new PhoneReadyCommandHandler(
                        communicationManager, stateManager, responseBuilder, serviceManager);

        assertThat(handler.handleCommand("phone_ready", new JSONObject())).isTrue();

        assertThat(response.getJSONObject("wire_caps").getBoolean("binary")).isTrue();
        verify(bluetoothManager).sendWireV2Handshake();
    }
}
