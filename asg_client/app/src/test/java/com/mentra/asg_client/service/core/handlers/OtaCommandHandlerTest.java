package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
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
                        "ota_start", "ota_update_response", "ota_query_status");
    }

    @Test
    public void handleOtaStart_withoutVersionUrl_isRejected() throws Exception {
        // ota_version_url is mandatory: the glasses have no baked fallback manifest, so a
        // URL-less ota_start (older phone SDKs) must be refused rather than guessed at.
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));

        boolean handled = handler.handleCommand("ota_start", new JSONObject());

        assertThat(handled).isFalse();
        verify(otaHelper, never()).startOtaFromPhone(anyString(), anyString());
    }

    @Test
    public void handleOtaStart_withVersionUrl_passesUrlToHelper() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));
        String versionUrl = "https://example.com/staging_live_version.json";

        boolean handled =
                handler.handleCommand(
                        "ota_start", new JSONObject().put("ota_version_url", versionUrl));

        assertThat(handled).isTrue();
        verify(otaHelper).startOtaFromPhone(versionUrl, "wifi");
    }

    @Test
    public void handleOtaStart_withHttpVersionUrl_passesUrlToHelper() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));
        String versionUrl = "http://localhost:8000/staging_live_version.json";

        boolean handled =
                handler.handleCommand(
                        "ota_start", new JSONObject().put("ota_version_url", versionUrl));

        assertThat(handled).isTrue();
        verify(otaHelper).startOtaFromPhone(versionUrl, "wifi");
    }

    @Test
    public void handleOtaStart_withEmptyVersionUrl_rejectsCommand() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));

        boolean handled =
                handler.handleCommand("ota_start", new JSONObject().put("ota_version_url", " "));

        assertThat(handled).isFalse();
        verify(otaHelper, never()).startOtaFromPhone(anyString(), anyString());
    }

    @Test
    public void handleOtaStart_withNonHttpVersionUrl_rejectsCommand() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));

        boolean handled =
                handler.handleCommand(
                        "ota_start", new JSONObject().put("ota_version_url", "file:///tmp/x"));

        assertThat(handled).isFalse();
        verify(otaHelper, never()).startOtaFromPhone(anyString(), anyString());
    }

    @Test
    public void handleOtaStart_withHotspotTransport_passesExplicitTransport() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));
        String versionUrl = "http://192.168.43.2:8791/manifest.json";

        boolean handled =
                handler.handleCommand(
                        "ota_start",
                        new JSONObject()
                                .put("ota_version_url", versionUrl)
                                .put("ota_transport", "hotspot"));

        assertThat(handled).isTrue();
        verify(otaHelper).startOtaFromPhone(versionUrl, "hotspot");
    }

    @Test
    public void handleOtaStart_withUnknownTransport_isRejected() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));

        boolean handled =
                handler.handleCommand(
                        "ota_start",
                        new JSONObject()
                                .put("ota_version_url", "https://example.com/version.json")
                                .put("ota_transport", "cellular"));

        assertThat(handled).isFalse();
        verify(otaHelper, never()).startOtaFromPhone(anyString(), anyString());
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
