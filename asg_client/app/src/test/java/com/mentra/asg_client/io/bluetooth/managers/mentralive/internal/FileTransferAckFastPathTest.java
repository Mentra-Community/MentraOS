package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Regression guards for the Mentra file-ACK fast path. Frames from {@link BesMessageParser} always
 * start with {@code ##} ({@code 0x23}), so the old {@code message[0] == CMD_TYPE_PHOTO} check never
 * matched.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FileTransferAckFastPathTest {

    @Test
    public void tryParseCsFlts_parsesAckPayload() {
        byte[] payload = csFltsPayload(1, 80);

        FileTransferAckDispatch.Ack ack = FileTransferAckDispatch.tryParseCsFlts(payload);

        assertThat(ack).isNotNull();
        assertThat(ack.state).isEqualTo(1);
        assertThat(ack.index).isEqualTo(80);
    }

    @Test
    public void tryParseCsFlts_rejectsNonAckPayload() {
        byte[] payload = "{\"C\":\"hs_syvr\",\"B\":{\"version\":\"1\"}}".getBytes(StandardCharsets.UTF_8);

        assertThat(FileTransferAckDispatch.tryParseCsFlts(payload)).isNull();
    }

    @Test
    public void tryDispatchDuringTransfer_invokesHandlerWhenActive() {
        AtomicInteger state = new AtomicInteger(-1);
        AtomicInteger index = new AtomicInteger(-1);

        boolean consumed =
                FileTransferAckDispatch.tryDispatchDuringTransfer(
                        true,
                        csFltsPayload(1, 7),
                        (s, i) -> {
                            state.set(s);
                            index.set(i);
                        });

        assertThat(consumed).isTrue();
        assertThat(state.get()).isEqualTo(1);
        assertThat(index.get()).isEqualTo(7);
    }

    @Test
    public void tryDispatchDuringTransfer_fallsThroughWhenInactive() {
        AtomicInteger calls = new AtomicInteger();

        boolean consumed =
                FileTransferAckDispatch.tryDispatchDuringTransfer(
                        false, csFltsPayload(1, 7), (s, i) -> calls.incrementAndGet());

        assertThat(consumed).isFalse();
        assertThat(calls.get()).isEqualTo(0);
    }

    @Test
    public void k900FrameStartingWithHashMarkers_stillYieldsParsableCsFltsPayload() {
        // Inbound BES frames are ## + type + len + JSON payload + $$ (not packJsonCommand's
        // double-wrapped C-field form).
        byte[] frame =
                BesWireFormat.packDataCommand(
                        csFltsPayload(1, 16), BesWireFormat.CMD_TYPE_STRING);
        assertThat(frame).isNotNull();
        assertThat(frame[0]).isEqualTo((byte) 0x23);
        assertThat(frame[1]).isEqualTo((byte) 0x23);
        // Old dead path checked for CMD_TYPE_PHOTO (0x31) at byte 0 — that must not be required.
        assertThat(frame[0]).isNotEqualTo(BesWireFormat.CMD_TYPE_PHOTO);

        byte[] payload = BesWireFormat.extractPayloadAuto(frame);
        FileTransferAckDispatch.Ack ack = FileTransferAckDispatch.tryParseCsFlts(payload);

        assertThat(ack).isNotNull();
        assertThat(ack.state).isEqualTo(1);
        assertThat(ack.index).isEqualTo(16);
    }

    private static byte[] csFltsPayload(int state, int index) {
        String json =
                "{\"C\":\"cs_flts\",\"B\":{\"type\":52,\"state\":"
                        + state
                        + ",\"index\":"
                        + index
                        + "}}";
        return json.getBytes(StandardCharsets.UTF_8);
    }
}
