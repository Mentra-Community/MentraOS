package com.mentra.asg_client.service.legacy.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.server.managers.AsgServerManager;
import com.mentra.asg_client.io.server.services.AsgCameraServer;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.core.AsgClientService;
import java.lang.reflect.Field;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AsgClientServiceManagerCameraServerTest {
    private INetworkManager networkManager;
    private AsgClientServiceManager serviceManager;

    @Before
    public void setUp() {
        networkManager = mock(INetworkManager.class);
        serviceManager =
                new AsgClientServiceManager(
                        mock(Context.class),
                        mock(AsgClientService.class),
                        mock(ICommunicationManager.class),
                        mock(FileManager.class),
                        mock(IBesOtaRegistry.class),
                        mock(ICompanionTransport.class),
                        networkManager);
    }

    @Test
    public void enablingServerWhileHotspotInactiveFailsClosed() {
        when(networkManager.isHotspotEnabled()).thenReturn(false);

        serviceManager.setWebServerEnabled(true);

        assertThat(serviceManager.getCameraServer()).isNull();
    }

    @Test
    public void repeatedDisableStopsUnexpectedServer() throws Exception {
        AsgCameraServer cameraServer = mock(AsgCameraServer.class);
        AsgServerManager serverManager = mock(AsgServerManager.class);
        setField("cameraServer", cameraServer);
        setField("serverManager", serverManager);
        setField("isWebServerEnabled", false);

        serviceManager.setWebServerEnabled(false);

        verify(serverManager).stopServer("camera");
        assertThat(serviceManager.getCameraServer()).isNull();
    }

    private void setField(String name, Object value) throws Exception {
        Field field = AsgClientServiceManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(serviceManager, value);
    }
}
