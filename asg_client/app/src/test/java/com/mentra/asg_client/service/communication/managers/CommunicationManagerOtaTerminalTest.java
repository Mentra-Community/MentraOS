package com.mentra.asg_client.service.communication.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.MessageChunker;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;
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
    public void guardStatusWaitsForDelayedSuccessfulTransportCallback() throws Exception {
        ICompanionTransport transport = connectedTransport();
        doAnswer(
                        invocation -> {
                            IBluetoothManager.SendMessageCallback callback =
                                    invocation.getArgument(1);
                            new Thread(
                                            () -> {
                                                LockSupport.parkNanos(
                                                        TimeUnit.MILLISECONDS.toNanos(50));
                                                callback.onSendComplete(true);
                                            })
                                    .start();
                            return true;
                        })
                .when(transport)
                .sendMessage(
                        any(byte[].class), any(IBluetoothManager.SendMessageCallback.class));
        CommunicationManager manager =
                new CommunicationManager(transport, mock(INetworkManager.class));

        assertThat(manager.sendOtaStatusAndWaitForTransport(installStatus())).isTrue();
    }

    @Test
    public void guardStatusFailsWhenTransportRejectsQueue() throws Exception {
        ICompanionTransport transport = connectedTransport();
        when(transport.sendMessage(
                        any(byte[].class), any(IBluetoothManager.SendMessageCallback.class)))
                .thenReturn(false);
        CommunicationManager manager =
                new CommunicationManager(transport, mock(INetworkManager.class));

        assertThat(manager.sendOtaStatusAndWaitForTransport(installStatus())).isFalse();
    }

    @Test
    public void guardStatusFailsWhenQueuedTransportWriteFails() throws Exception {
        ICompanionTransport transport = connectedTransport();
        doAnswer(
                        invocation -> {
                            IBluetoothManager.SendMessageCallback callback =
                                    invocation.getArgument(1);
                            callback.onSendComplete(false);
                            return true;
                        })
                .when(transport)
                .sendMessage(
                        any(byte[].class), any(IBluetoothManager.SendMessageCallback.class));
        CommunicationManager manager =
                new CommunicationManager(transport, mock(INetworkManager.class));

        assertThat(manager.sendOtaStatusAndWaitForTransport(installStatus())).isFalse();
    }

    private static ICompanionTransport connectedTransport() {
        ICompanionTransport transport = mock(ICompanionTransport.class);
        when(transport.isConnected()).thenReturn(true);
        return transport;
    }

    private static JSONObject installStatus() throws Exception {
        JSONObject status = new JSONObject();
        status.put("type", "ota_status");
        status.put("status", "in_progress");
        status.put("step_type", "bes");
        status.put("phase", "install");
        return status;
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
