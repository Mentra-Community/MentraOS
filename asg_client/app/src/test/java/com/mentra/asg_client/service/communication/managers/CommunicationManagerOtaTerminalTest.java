package com.mentra.asg_client.service.communication.managers;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.MessageChunker;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
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

    private static void assertSingleLegacyFrame(JSONObject terminal) throws Exception {
        terminal.put("mId", Long.MAX_VALUE);
        String json = terminal.toString();

        assertThat(json.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(200);
        assertThat(MessageChunker.needsChunking(json)).isFalse();
        assertThat(BesWireFormat.formatMessageForTransmission(json).length)
                .isLessThanOrEqualTo(MessageChunker.maxPackedStringChunkSize());
    }
}
