package com.mentra.asg_client.service.core.handlers;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

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
 * A synthetic boot-announcement phone_ready (GlassesReadyBootAnnouncer) must run the full
 * glasses_ready flow WITHOUT marking the phone connection active: on a phone-less boot the
 * UART write still succeeds (the BES accepts it), and a spurious isConnected() suppresses
 * local camera-button capture in ButtonEventSubscriber until the heartbeat timeout.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhoneReadyBootAnnounceTest {

    private ICommunicationManager communicationManager;
    private AsgClientServiceManager serviceManager;
    private PhoneReadyCommandHandler handler;

    @Before
    public void setUp() throws Exception {
        communicationManager = mock(ICommunicationManager.class);
        when(communicationManager.sendBluetoothResponse(any())).thenReturn(true);
        IResponseBuilder responseBuilder = mock(IResponseBuilder.class);
        when(responseBuilder.buildGlassesReadyResponse())
                .thenReturn(new JSONObject().put("type", "glasses_ready"));
        serviceManager = mock(AsgClientServiceManager.class);
        handler =
                new PhoneReadyCommandHandler(
                        communicationManager,
                        mock(IStateManager.class),
                        responseBuilder,
                        serviceManager);
    }

    @Test
    public void realPhoneReadyMarksHandshakeComplete() throws Exception {
        handler.handleCommand("phone_ready", new JSONObject().put("timestamp", 1L));

        verify(communicationManager).sendBluetoothResponse(any(JSONObject.class));
        verify(serviceManager).onPhoneReadyHandshakeComplete();
    }

    @Test
    public void syntheticBootAnnounceDoesNotMarkHandshakeComplete() throws Exception {
        JSONObject synthetic = new JSONObject().put("type", "phone_ready").put("boot_announce", true);
        handler.handleCommand("phone_ready", synthetic);

        // The glasses_ready still goes out — only the phone-liveness marking is suppressed.
        verify(communicationManager).sendBluetoothResponse(any(JSONObject.class));
        verify(serviceManager, never()).onPhoneReadyHandshakeComplete();
    }
}
