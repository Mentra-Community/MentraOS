package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.inOrder;

import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

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
        verify(otaHelper, never()).startOtaFromPhone(anyString());
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
        verify(otaHelper).startOtaFromPhone(versionUrl);
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
        verify(otaHelper).startOtaFromPhone(versionUrl);
    }

    @Test
    public void handleOtaStart_withEmptyVersionUrl_rejectsCommand() throws Exception {
        OtaHelper otaHelper = mock(OtaHelper.class);
        OtaCommandHandler handler =
                new OtaCommandHandler(otaHelper, mock(ICommunicationManager.class));

        boolean handled =
                handler.handleCommand("ota_start", new JSONObject().put("ota_version_url", " "));

        assertThat(handled).isFalse();
        verify(otaHelper, never()).startOtaFromPhone(anyString());
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
        verify(otaHelper, never()).startOtaFromPhone(anyString());
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
        verify(otaHelper, never()).getOtaActivitySnapshot(anyString());
        assertThat(state.has("activity")).isFalse();
    }

    @Test
    public void activityOptInKeepsTerminalFieldsAndLogsCorrelatedSnapshotBeforeStatusProjection()
            throws Exception {
        OtaHelper helper = mock(OtaHelper.class);
        ICommunicationManager communication = mock(ICommunicationManager.class);
        JSONObject terminal = new JSONObject().put("type", "ota_status")
                .put("status", "complete").put("sid", "owned-bes").put("st", "bes");
        JSONObject activity = new JSONObject().put("request_id", "return-123")
                .put("admission_held", true);
        when(helper.getOtaSessionState()).thenReturn(terminal);
        when(helper.getOtaActivitySnapshot("return-123")).thenReturn(activity);
        OtaCommandHandler handler = new OtaCommandHandler(helper, communication);

        assertThat(handler.handleCommand("ota_query_status", new JSONObject()
                .put("include_activity", true).put("request_id", "return-123"))).isTrue();

        var order = inOrder(helper, communication);
        order.verify(helper).getOtaActivitySnapshot("return-123");
        order.verify(helper).getOtaSessionState();
        order.verify(communication).sendOtaStatus(terminal);
        assertThat(terminal.getString("status")).isEqualTo("complete");
        assertThat(terminal.getString("sid")).isEqualTo("owned-bes");
        assertThat(terminal.getString("st")).isEqualTo("bes");
        assertThat(terminal.getJSONObject("activity")).isSameAs(activity);
        assertThat(ShadowLog.getLogsForTag("OtaCommandHandler"))
                .anySatisfy(log -> assertThat(log.msg)
                        .isEqualTo("OTA activity snapshot: " + activity));
        verify(helper, never()).startOtaFromPhone(anyString());
    }

    @Test
    public void malformedOrNonOptedInActivityRequestsKeepNormalResponse() throws Exception {
        for (JSONObject request : new JSONObject[] {
                new JSONObject().put("request_id", "return-123"),
                new JSONObject().put("include_activity", "true").put("request_id", "return-123"),
                new JSONObject().put("include_activity", true),
                new JSONObject().put("include_activity", true).put("request_id", 123),
                new JSONObject().put("include_activity", true).put("request_id", "bad\nlabel"),
                new JSONObject().put("include_activity", true).put("request_id", "x".repeat(121))}) {
            OtaHelper helper = mock(OtaHelper.class);
            ICommunicationManager communication = mock(ICommunicationManager.class);
            JSONObject state = new JSONObject().put("status", "idle");
            when(helper.getOtaSessionState()).thenReturn(state);
            assertThat(new OtaCommandHandler(helper, communication)
                    .handleCommand("ota_query_status", request)).isTrue();
            verify(helper, never()).getOtaActivitySnapshot(anyString());
            verify(communication).sendOtaStatus(state);
            assertThat(state.has("activity")).isFalse();
        }
    }

    @Test
    public void handleOtaQueryStatus_returnsFalseWhenHelperMissing() throws Exception {
        OtaCommandHandler handler = new OtaCommandHandler(null, mock(ICommunicationManager.class));

        boolean handled = handler.handleCommand("ota_query_status", new JSONObject());

        assertThat(handled).isFalse();
    }
}
