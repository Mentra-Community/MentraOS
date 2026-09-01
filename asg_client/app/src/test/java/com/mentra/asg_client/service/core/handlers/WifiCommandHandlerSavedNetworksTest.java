package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import java.util.Arrays;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class WifiCommandHandlerSavedNetworksTest {
    private AsgClientServiceManager serviceManager;
    private ICommunicationManager communicationManager;
    private INetworkManager networkManager;
    private WifiCommandHandler handler;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        communicationManager = mock(ICommunicationManager.class);
        networkManager = mock(INetworkManager.class);
        when(serviceManager.getNetworkManager()).thenReturn(networkManager);
        handler =
                new WifiCommandHandler(
                        serviceManager, communicationManager, mock(IStateManager.class));
    }

    @Test
    public void forgetWifi_sendsDispatchAcceptanceWithCorrelationId() throws Exception {
        when(networkManager.forgetWifiNetwork("Field AP")).thenReturn(true);
        JSONObject command =
                new JSONObject()
                        .put("type", "forget_wifi")
                        .put("requestId", "forget-7")
                        .put("ssid", "Field AP");

        assertThat(handler.handleCommand("forget_wifi", command)).isTrue();

        verify(communicationManager)
                .sendWifiForgetResultOverBle("forget-7", "Field AP", true, null);
    }

    @Test
    public void forgetWifi_sendsTerminalFailureWhenManagerRejectsOperation() throws Exception {
        when(networkManager.forgetWifiNetwork("Field AP")).thenReturn(false);
        JSONObject command =
                new JSONObject()
                        .put("type", "forget_wifi")
                        .put("requestId", "forget-8")
                        .put("ssid", "Field AP");

        assertThat(handler.handleCommand("forget_wifi", command)).isFalse();

        verify(communicationManager)
                .sendWifiForgetResultOverBle("forget-8", "Field AP", false, "forget_dispatch_failed");
    }

    @Test
    public void requestSavedWifiNetworks_returnsSortedDistinctNonEmptySsids() throws Exception {
        when(networkManager.getConfiguredWifiNetworks())
                .thenReturn(Arrays.asList("Warehouse", " Field AP ", "", "Warehouse", null));
        JSONObject command =
                new JSONObject()
                        .put("type", "request_saved_wifi_networks")
                        .put("requestId", "saved-3");

        assertThat(handler.handleCommand("request_saved_wifi_networks", command)).isTrue();

        verify(communicationManager)
                .sendSavedWifiNetworksOverBle(
                        "saved-3", Arrays.asList(" Field AP ", "Warehouse"), null);
    }

    @Test
    public void requestSavedWifiNetworks_reportsUnsupportedManager() throws Exception {
        when(networkManager.getConfiguredWifiNetworks())
                .thenThrow(new UnsupportedOperationException("no vendor response"));
        JSONObject command =
                new JSONObject()
                        .put("type", "request_saved_wifi_networks")
                        .put("requestId", "saved-4");

        assertThat(handler.handleCommand("request_saved_wifi_networks", command)).isFalse();

        verify(communicationManager)
                .sendSavedWifiNetworksOverBle(
                        "saved-4", java.util.Collections.emptyList(), "list_saved_networks_unsupported");
    }
}
