package com.mentra.asg_client.service.communication.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.MessageChunker;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CommunicationManagerOtaTerminalTest {
    @Before
    public void setUp() {
        BesWireFormat.resetBinaryProtocol();
    }

    @After
    public void tearDown() {
        BesWireFormat.resetBinaryProtocol();
    }

    @Test
    public void completeStatusFitsOneLegacyNotificationAfterReliableMessageId() throws Exception {
        JSONObject verbose = new JSONObject();
        verbose.put("type", "ota_status");
        verbose.put("status", "complete");
        verbose.put("sid", "d017b9b1");
        verbose.put("st", "bes");
        verbose.put("phase", "install");
        verbose.put("op", 100);
        verbose.put("diagnostic", "not allowed on the critical terminal wire");

        assertSingleLegacyFrame(CommunicationManager.compactTerminalOtaStatus(verbose));
    }

    @Test
    public void failedStatusNormalizesVerboseErrorsAndFitsOneLegacyNotification() throws Exception {
        JSONObject verbose = new JSONObject();
        verbose.put("type", "ota_status");
        verbose.put("status", "failed");
        verbose.put("sid", "12345678");
        verbose.put("st", "bes");
        verbose.put("phase", "install");
        verbose.put("op", 99);
        verbose.put("glasses_time_ms", Long.MAX_VALUE);
        verbose.put("error_message", "Ambiguous UART write failure with a very long diagnostic");

        JSONObject compact = CommunicationManager.compactTerminalOtaStatus(verbose);

        assertThat(compact.getString("err")).isEqualTo("install_failed");
        assertThat(compact.has("op")).isFalse();
        assertSingleLegacyFrame(compact);
    }

    @Test
    public void existingCompactErrorCodeSurvivesTerminalCompaction() throws Exception {
        JSONObject status = new JSONObject();
        status.put("type", "ota_status");
        status.put("status", "failed");
        status.put("st", "bes");
        status.put("phase", "install");
        status.put("error_message", "firmware_verify_failed");

        JSONObject compact = CommunicationManager.compactTerminalOtaStatus(status);

        assertThat(compact.getString("err")).isEqualTo("firmware_verify_failed");
        assertSingleLegacyFrame(compact);
    }

    @Test
    public void requestedActivityTravelsSeparatelyWithoutEnlargingReliableTerminal() throws Exception {
        for (boolean includeActivity : new boolean[] {false, true}) {
            ICompanionTransport transport = mock(ICompanionTransport.class);
            when(transport.isConnected()).thenReturn(true);
            when(transport.sendMessage(any(byte[].class), any(), any())).thenReturn(true);
            CommunicationManager manager = new CommunicationManager(transport, mock(INetworkManager.class));
            try {
                JSONObject activity = new JSONObject()
                        .put("request_id", "fresh-request")
                        .put("admission_held", true)
                        .put("session", new JSONObject().put("status", "complete"));
                JSONObject status = new JSONObject().put("type", "ota_status")
                        .put("status", "complete").put("sid", "previous").put("st", "bes");
                if (includeActivity) status.put("activity", activity);
                manager.sendOtaStatus(status);

                ArgumentCaptor<byte[]> terminalBytes = ArgumentCaptor.forClass(byte[].class);
                verify(transport).sendMessage(terminalBytes.capture(), any(), any());
                JSONObject terminal = new JSONObject(new String(terminalBytes.getValue(), StandardCharsets.UTF_8));
                assertThat(terminal.getString("status")).isEqualTo("complete");
                assertThat(terminal.getString("sid")).isEqualTo("previous");
                assertThat(terminal.has("activity")).isFalse();
                assertSingleLegacyFrame(terminal);
                if (includeActivity) {
                    ArgumentCaptor<byte[]> diagnosticBytes = ArgumentCaptor.forClass(byte[].class);
                    verify(transport).sendMessage(diagnosticBytes.capture());
                    JSONObject diagnostic = new JSONObject(new String(diagnosticBytes.getValue(), StandardCharsets.UTF_8));
                    assertThat(diagnostic.getString("type")).isEqualTo("ota_activity");
                    assertThat(diagnostic.getJSONObject("activity").toString()).isEqualTo(activity.toString());
                } else {
                    verify(transport, never()).sendMessage(any(byte[].class));
                }
            } finally {
                manager.getReliableManager().shutdown();
            }
        }
    }

    private static void assertSingleLegacyFrame(JSONObject terminal) throws Exception {
        terminal.put("mId", Long.MAX_VALUE);
        String json = terminal.toString();

        assertThat(json.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(200);
        assertThat(MessageChunker.needsChunking(json)).isFalse();
        assertThat(BesWireFormat.formatMessageForTransmission(json).length)
                .isLessThanOrEqualTo(MessageChunker.maxPackedStringChunkSize());
    }
}
