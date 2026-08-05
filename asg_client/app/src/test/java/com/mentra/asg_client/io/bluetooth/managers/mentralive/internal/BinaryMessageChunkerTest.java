package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import com.mentra.asg_client.io.bluetooth.utils.BleJsonCompact;
import org.json.JSONObject;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BinaryMessageChunkerTest {

    @Before
    public void setUp() {
        BesWireFormat.setBinaryProtocolActive(true);
    }

    @After
    public void tearDown() {
        BesWireFormat.resetBinaryProtocol();
        BesWireFormat.resetFilePackSize();
    }

    @Test
    public void createBinaryFragments_singleFragmentFitsInOneFrame() throws Exception {
        String json = "{\"type\":\"ping\",\"mId\":42}";
        List<byte[]> frames = MessageChunker.createBinaryFragments(json, 7);

        assertThat(frames).hasSize(1);
        assertThat(frames.get(0).length)
                .isLessThanOrEqualTo(MessageChunker.maxPackedFrameSize());

        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(frames.get(0));
        assertThat(header.valid).isTrue();
        assertThat(header.fragIdx).isZero();
        assertThat(header.fragCount).isEqualTo(1);
        assertThat(header.flags & BesWireFormat.FLAG_FIRST_FRAG).isNotZero();
        assertThat(header.flags & BesWireFormat.FLAG_LAST_FRAG).isNotZero();
        assertThat(new String(header.payload, StandardCharsets.UTF_8))
                .isEqualTo(BleJsonCompact.encode(new JSONObject(json)).toString());
    }

    @Test
    public void createBinaryFragments_splitsLargePayloadAcrossMultipleFrames() throws Exception {
        StringBuilder builder = new StringBuilder("{\"type\":\"stream_status\",\"d\":\"");
        for (int i = 0; i < 600; i++) {
            builder.append('x');
        }
        builder.append("\"}");
        String json = builder.toString();

        List<byte[]> frames = MessageChunker.createBinaryFragments(json, 99);
        assertThat(frames.size()).isGreaterThan(1);

        int totalPayload = 0;
        for (int i = 0; i < frames.size(); i++) {
            assertThat(frames.get(i).length)
                    .isLessThanOrEqualTo(MessageChunker.maxPackedFrameSize());
            BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(frames.get(i));
            assertThat(header.valid).isTrue();
            assertThat(header.msgId).isEqualTo(99);
            assertThat(header.fragIdx).isEqualTo(i);
            assertThat(header.fragCount).isEqualTo(frames.size());
            totalPayload += header.payloadLen;
        }

        byte[] outbound = BesWireFormat.buildOutboundPayloadBytes(json);
        assertThat(totalPayload).isEqualTo(outbound.length);
    }

    @Test
    public void needsChunking_usesBinaryPayloadBudgetWhenBinaryActive() {
        String small = "{\"type\":\"ping\"}";
        String large =
                "{\"type\":\"stream_status\",\"d\":\""
                        + "a".repeat(MessageChunker.maxBinaryFragmentPayload() + 1)
                        + "\"}";

        assertThat(MessageChunker.needsChunking(small)).isFalse();
        assertThat(MessageChunker.needsChunking(large)).isTrue();
    }

    @Test
    public void buildOutboundPayloadBytes_skipsWrapperForNonCameraMessages() throws Exception {
        String json = "{\"type\":\"photo_status\",\"status\":\"captured\"}";
        byte[] payload = BesWireFormat.buildOutboundPayloadBytes(json);
        JSONObject decoded =
                BleJsonCompact.decode(new JSONObject(new String(payload, StandardCharsets.UTF_8)));
        assertThat(decoded.getString("type")).isEqualTo("photo_status");
        assertThat(decoded.getString("status")).isEqualTo("captured");
    }

    @Test
    public void buildOutboundPayloadBytes_keepsWrapperForCameraCommands() throws Exception {
        String json = "{\"type\":\"take_photo\",\"requestId\":\"abc\"}";
        byte[] payload = BesWireFormat.buildOutboundPayloadBytes(json);
        String wire = new String(payload, StandardCharsets.UTF_8);
        assertThat(wire).contains("\"C\"");
        assertThat(wire).contains("take_photo");
    }
}
