package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PingCommandHandlerHotspotActivityTest {
  private Context context;
  private INetworkManager networkManager;
  private OtaSessionManager otaSession;
  private PingCommandHandler handler;

  @Before
  public void setUp() throws Exception {
    context = ApplicationProvider.getApplicationContext();
    otaSession = new OtaSessionManager(context);
    otaSession.clear();

    networkManager = mock(INetworkManager.class);
    AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
    when(serviceManager.getContext()).thenReturn(context);
    when(serviceManager.getNetworkManager()).thenReturn(networkManager);

    IResponseBuilder responseBuilder = mock(IResponseBuilder.class);
    when(responseBuilder.buildPingResponse()).thenReturn(new JSONObject().put("type", "pong"));
    ICommunicationManager communicationManager = mock(ICommunicationManager.class);
    when(communicationManager.sendBluetoothResponse(any())).thenReturn(true);

    handler = new PingCommandHandler(communicationManager, responseBuilder, serviceManager);
  }

  @After
  public void tearDown() {
    otaSession.clear();
  }

  @Test
  public void activeOtaPingRefreshesActiveHotspot() {
    assertThat(otaSession.createSession(new String[] {"apk"}, "https://example.test/version.json"))
        .isTrue();
    when(networkManager.isHotspotEnabled()).thenReturn(true);

    assertThat(handler.handleCommand("ping", new JSONObject())).isTrue();

    verify(networkManager).updateHttpActivity();
  }

  @Test
  public void ordinaryPingDoesNotRefreshHotspot() {
    when(networkManager.isHotspotEnabled()).thenReturn(true);

    assertThat(handler.handleCommand("ping", new JSONObject())).isTrue();

    verify(networkManager, never()).updateHttpActivity();
  }

  @Test
  public void activeOtaPingDoesNotRefreshStoppedHotspot() {
    assertThat(otaSession.createSession(new String[] {"apk"}, "https://example.test/version.json"))
        .isTrue();
    when(networkManager.isHotspotEnabled()).thenReturn(false);

    assertThat(handler.handleCommand("ping", new JSONObject())).isTrue();

    verify(networkManager, never()).updateHttpActivity();
  }
}
