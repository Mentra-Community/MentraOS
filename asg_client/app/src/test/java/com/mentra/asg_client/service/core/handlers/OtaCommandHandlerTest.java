package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaCommandHandlerTest {

    @Test
    public void getSupportedCommandTypes_includesPhoneOtaCommands() {
        OtaCommandHandler handler =
                new OtaCommandHandler(mock(OtaHelper.class), mock(ICommunicationManager.class));

        assertThat(handler.getSupportedCommandTypes())
                .containsExactlyInAnyOrder(
                        "ota_start",
                        "ota_update_response",
                        "ota_query_status",
                        "ota_retry_version_check");
    }

    @Test
    public void handleOtaStart_withInjectedHelper_startsPhoneOta() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));

        boolean handled = handler.handleCommand("ota_start", new JSONObject());

        assertThat(handled).isTrue();
        verify(otaHelper).startOtaFromPhone();
    }

    @Test
    public void handleOtaQueryStatus_sendsSessionStateWhenHelperReady() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        ICommunicationManager communicationManager = mock(ICommunicationManager.class);
        JSONObject state = new JSONObject().put("type", "ota_status");
        when(otaHelper.getOtaSessionState()).thenReturn(state);

        OtaCommandHandler handler = new OtaCommandHandler(otaHelper, communicationManager);

        boolean handled = handler.handleCommand("ota_query_status", new JSONObject());

        assertThat(handled).isTrue();
        verify(communicationManager).sendOtaStatus(state);
    }

    @Test
    public void handleOtaQueryStatus_returnsFalseWhenHelperMissing() throws Exception {
        OtaCommandHandler handler = new OtaCommandHandler(null, mock(ICommunicationManager.class));

        boolean handled = handler.handleCommand("ota_query_status", new JSONObject());

        assertThat(handled).isFalse();
    }
}
