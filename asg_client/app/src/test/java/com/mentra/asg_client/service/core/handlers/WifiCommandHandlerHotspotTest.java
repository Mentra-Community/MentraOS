package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class WifiCommandHandlerHotspotTest {
    private INetworkManager networkManager;
    private WifiCommandHandler handler;

    @Before
    public void setUp() {
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        networkManager = mock(INetworkManager.class);
        when(serviceManager.getNetworkManager()).thenReturn(networkManager);
        handler =
                new WifiCommandHandler(
                        serviceManager,
                        mock(ICommunicationManager.class),
                        mock(IStateManager.class));
    }

    @Test
    public void stopAlwaysReachesNativeManagerAfterProcessReplacement() throws Exception {
        when(networkManager.isHotspotEnabled()).thenReturn(false);
        assertThat(handler.handleSetHotspotState(new JSONObject().put("enabled", false))).isTrue();
        verify(networkManager).stopHotspot();
    }

    @Test
    public void startDelegatesPhysicalReadinessEvenWhenMemorySaysEnabled() throws Exception {
        when(networkManager.isHotspotEnabled()).thenReturn(true);
        assertThat(handler.handleSetHotspotState(new JSONObject().put("enabled", true))).isTrue();
        verify(networkManager).startHotspot();
    }
}
