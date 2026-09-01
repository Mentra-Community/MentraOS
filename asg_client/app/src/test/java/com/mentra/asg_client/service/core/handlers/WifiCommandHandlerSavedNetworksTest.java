package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.interfaces.SavedWifiNetworksOutcome;
import com.mentra.asg_client.io.network.interfaces.SavedWifiNetworksResult;
import com.mentra.asg_client.io.network.interfaces.WifiForgetOutcome;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.utils.ProcessSessionId;
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
        when(networkManager.forgetWifiNetwork("Field AP")).thenReturn(WifiForgetOutcome.DISPATCHED);
        JSONObject command =
                new JSONObject()
                        .put("type", "forget_wifi")
                        .put("requestId", "forget-7")
                        .put("ssid", "Field AP");

        assertThat(handler.handleCommand("forget_wifi", command)).isTrue();

        verify(communicationManager)
                .sendWifiForgetResultOverBle(
                        "forget-7", "Field AP", WifiForgetOutcome.DISPATCHED, null);
    }

    @Test
    public void forgetWifi_sendsTerminalFailureWhenManagerRejectsOperation() throws Exception {
        when(networkManager.forgetWifiNetwork("Field AP")).thenReturn(WifiForgetOutcome.FAILED);
        JSONObject command =
                new JSONObject()
                        .put("type", "forget_wifi")
                        .put("requestId", "forget-8")
                        .put("ssid", "Field AP");

        assertThat(handler.handleCommand("forget_wifi", command)).isFalse();

        verify(communicationManager)
                .sendWifiForgetResultOverBle(
                        "forget-8", "Field AP", WifiForgetOutcome.FAILED, "forget_failed");
    }

    @Test
    public void forgetWifi_returnsCorrelatedUnsupportedForModernUnsupportedBackend()
            throws Exception {
        when(networkManager.forgetWifiNetwork("Field AP"))
                .thenReturn(WifiForgetOutcome.UNSUPPORTED);
        JSONObject command =
                new JSONObject()
                        .put("type", "forget_wifi")
                        .put("requestId", "forget-unsupported")
                        .put("sid", ProcessSessionId.SID)
                        .put("ssid", "Field AP");

        assertThat(handler.handleCommand("forget_wifi", command)).isFalse();

        verify(communicationManager)
                .sendWifiForgetResultOverBle(
                        "forget-unsupported",
                        "Field AP",
                        WifiForgetOutcome.UNSUPPORTED,
                        null);
    }

    @Test
    public void forgetWifi_rejectsStaleSessionBeforeBackendMutation() throws Exception {
        JSONObject command =
                new JSONObject()
                        .put("type", "forget_wifi")
                        .put("requestId", "forget-stale")
                        .put("sid", ProcessSessionId.SID + "-stale")
                        .put("ssid", " Field AP ");

        assertThat(handler.handleCommand("forget_wifi", command)).isFalse();

        verify(networkManager, never()).forgetWifiNetwork(" Field AP ");
        verify(communicationManager)
                .sendWifiForgetResultOverBle(
                        "forget-stale", " Field AP ", WifiForgetOutcome.FAILED, "stale_session");
    }

    @Test
    public void forgetWifi_acceptsExactSessionWithoutNormalizingSsid() throws Exception {
        when(networkManager.forgetWifiNetwork(" Field AP "))
                .thenReturn(WifiForgetOutcome.CONFIRMED);
        JSONObject command =
                new JSONObject()
                        .put("type", "forget_wifi")
                        .put("requestId", "forget-exact")
                        .put("sid", ProcessSessionId.SID)
                        .put("ssid", " Field AP ");

        assertThat(handler.handleCommand("forget_wifi", command)).isTrue();

        verify(networkManager).forgetWifiNetwork(" Field AP ");
        verify(communicationManager)
                .sendWifiForgetResultOverBle(
                        "forget-exact", " Field AP ", WifiForgetOutcome.CONFIRMED, null);
    }

    @Test
    public void requestSavedWifiNetworks_returnsSortedDistinctNonEmptySsids() throws Exception {
        when(networkManager.getSavedWifiNetworksVersion()).thenReturn(1);
        when(networkManager.getSavedWifiNetworksResult())
                .thenReturn(
                        SavedWifiNetworksResult.confirmed(
                                Arrays.asList("Warehouse", " Field AP ", "", "Warehouse", null)));
        JSONObject command =
                new JSONObject()
                        .put("type", "request_saved_wifi_networks")
                        .put("requestId", "saved-3");

        assertThat(handler.handleCommand("request_saved_wifi_networks", command)).isTrue();

        verify(communicationManager)
                .sendSavedWifiNetworksOverBle(
                        "saved-3",
                        Arrays.asList(" Field AP ", "Warehouse"),
                        SavedWifiNetworksOutcome.CONFIRMED,
                        null);
    }

    @Test
    public void requestSavedWifiNetworks_reportsUnsupportedManager() throws Exception {
        when(networkManager.getSavedWifiNetworksVersion()).thenReturn(0);
        JSONObject command =
                new JSONObject()
                        .put("type", "request_saved_wifi_networks")
                        .put("requestId", "saved-4");

        assertThat(handler.handleCommand("request_saved_wifi_networks", command)).isFalse();

        verify(communicationManager)
                .sendSavedWifiNetworksOverBle(
                        "saved-4",
                        java.util.Collections.emptyList(),
                        SavedWifiNetworksOutcome.UNSUPPORTED,
                        "list_saved_networks_unsupported");
    }

    @Test
    public void requestSavedWifiNetworks_preservesBackendFailureInsteadOfConfirmingEmpty()
            throws Exception {
        when(networkManager.getSavedWifiNetworksVersion()).thenReturn(1);
        when(networkManager.getSavedWifiNetworksResult())
                .thenReturn(SavedWifiNetworksResult.failed("list_saved_networks_failed"));
        JSONObject command =
                new JSONObject()
                        .put("type", "request_saved_wifi_networks")
                        .put("requestId", "saved-failed");

        assertThat(handler.handleCommand("request_saved_wifi_networks", command)).isFalse();

        verify(communicationManager)
                .sendSavedWifiNetworksOverBle(
                        "saved-failed",
                        java.util.Collections.emptyList(),
                        SavedWifiNetworksOutcome.FAILED,
                        "list_saved_networks_failed");
    }

    @Test
    public void requestSavedWifiNetworks_rejectsStaleSessionBeforeBackendRead() throws Exception {
        JSONObject command =
                new JSONObject()
                        .put("type", "request_saved_wifi_networks")
                        .put("requestId", "saved-stale")
                        .put("sid", ProcessSessionId.SID + "-stale");

        assertThat(handler.handleCommand("request_saved_wifi_networks", command)).isFalse();

        verify(networkManager, never()).getSavedWifiNetworksResult();
        verify(communicationManager)
                .sendSavedWifiNetworksOverBle(
                        "saved-stale",
                        java.util.Collections.emptyList(),
                        SavedWifiNetworksOutcome.FAILED,
                        "stale_session");
    }
}
