package com.mentra.asg_client.service.communication.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.interfaces.WifiForgetOutcome;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CommunicationManagerWifiForgetResultTest {
    @Test
    public void snapshotFailureCannotSuppressOrRewriteSingleTerminalOutcome() throws Exception {
        ICompanionTransport transport = mock(ICompanionTransport.class);
        INetworkManager networkManager = mock(INetworkManager.class);
        when(networkManager.isConnectedToWifi()).thenThrow(new IllegalStateException("snapshot"));
        when(transport.sendMessage(any(byte[].class), any(), any())).thenReturn(true);
        CommunicationManager manager = new CommunicationManager(transport, networkManager);

        manager.sendWifiForgetResultOverBle(
                "forget-1", " Field AP ", WifiForgetOutcome.DISPATCHED, null);

        ArgumentCaptor<byte[]> payload = ArgumentCaptor.forClass(byte[].class);
        verify(transport, times(1)).sendMessage(payload.capture(), any(), any());
        JSONObject json =
                new JSONObject(new String(payload.getValue(), StandardCharsets.UTF_8));
        assertThat(json.getString("requestId")).isEqualTo("forget-1");
        assertThat(json.getString("ssid")).isEqualTo(" Field AP ");
        assertThat(json.getString("outcome")).isEqualTo("dispatched");
    }
}
