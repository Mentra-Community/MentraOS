package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.BatteryEvent;
import com.mentra.asg_client.io.peripheral.events.ButtonEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.io.peripheral.events.SpeakPairingCodeEvent;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies {@link K900CommandHandler} parses inbound commands and dispatches them onto the bus. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900CommandHandlerDispatchTest {

    private IPeripheralBus bus;
    private K900CommandHandler handler;

    @Before
    public void setUp() {
        bus = mock(IPeripheralBus.class);
        handler =
                new K900CommandHandler(
                        mock(AsgClientServiceManager.class),
                        mock(IStateManager.class),
                        mock(ICommunicationManager.class),
                        bus);
    }

    private McuEvent dispatchAndCapture(JSONObject json) {
        handler.processK900Command(json);
        ArgumentCaptor<McuEvent> captor = ArgumentCaptor.forClass(McuEvent.class);
        verify(bus).publish(captor.capture());
        return captor.getValue();
    }

    @Test
    public void batteryCommand_publishesBatteryEvent() throws Exception {
        JSONObject json =
                new JSONObject()
                        .put("C", "hm_batv")
                        .put("B", new JSONObject().put("pt", 85).put("vt", 3900));

        McuEvent event = dispatchAndCapture(json);

        assertThat(event).isInstanceOf(BatteryEvent.class);
        assertThat(((BatteryEvent) event).getPercentage()).isEqualTo(85);
        assertThat(((BatteryEvent) event).getVoltageMillivolts()).isEqualTo(3900);
    }

    @Test
    public void cameraShortPress_publishesButtonEvent() throws Exception {
        McuEvent event = dispatchAndCapture(new JSONObject().put("C", "cs_pho"));

        assertThat(event).isInstanceOf(ButtonEvent.class);
        assertThat(((ButtonEvent) event).getType())
                .isEqualTo(ButtonEvent.Type.CAMERA_SHORT_PRESS);
    }

    @Test
    public void shutdownCommand_publishesShutdownEvent() throws Exception {
        McuEvent event = dispatchAndCapture(new JSONObject().put("C", "cs_shut"));

        assertThat(event).isInstanceOf(ShutdownEvent.class);
    }

    @Test
    public void speakPairingCode_publishesSpeakPairingCodeEvent() throws Exception {
        JSONObject json =
                new JSONObject()
                        .put("C", "hm_spkcode")
                        .put("B", new JSONObject().put("code", "A1B2"));

        McuEvent event = dispatchAndCapture(json);

        assertThat(event).isInstanceOf(SpeakPairingCodeEvent.class);
        assertThat(((SpeakPairingCodeEvent) event).getCode()).isEqualTo("A1B2");
    }

    @Test
    public void unknownCommand_doesNotPublish() throws Exception {
        handler.processK900Command(new JSONObject().put("C", "totally_unknown"));

        verify(bus, never()).publish(org.mockito.ArgumentMatchers.any());
    }

    @Test
    public void mirroredCommand_doesNotPublish() throws Exception {
        handler.processK900Command(new JSONObject().put("C", "android_control_led"));

        verify(bus, never()).publish(org.mockito.ArgumentMatchers.any());
    }

    @Test
    public void srLog_isHandledInline_doesNotPublish() throws Exception {
        // sr_log is consumed directly by the handler's BES log session, never via the bus.
        handler.processK900Command(
                new JSONObject().put("C", "sr_log").put("B", new JSONObject().put("cur", 0)));

        verify(bus, never()).publish(org.mockito.ArgumentMatchers.any());
    }
}
