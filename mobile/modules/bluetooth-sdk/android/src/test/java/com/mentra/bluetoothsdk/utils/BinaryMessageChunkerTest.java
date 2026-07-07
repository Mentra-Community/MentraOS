package com.mentra.bluetoothsdk.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BinaryMessageChunkerTest {

    @Test
    public void smallPayloadProducesSingleFragment() {
        byte[] payload = "{\"type\":\"ping\"}".getBytes(StandardCharsets.UTF_8);

        assertFalse(MessageChunker.needsBinaryFragmenting(payload));

        List<MessageChunker.BinaryFragment> fragments =
                MessageChunker.createBinaryFragments(payload, 42, false, false);

        assertEquals(1, fragments.size());
        assertEquals(42, fragments.get(0).msgId);
        assertEquals(0, fragments.get(0).fragIdx);
        assertEquals(1, fragments.get(0).fragCount);
        assertTrue(MessageChunker.allBinaryFragmentsFit(fragments));
    }

    @Test
    public void largePayloadSplitsIntoMultipleFragments() {
        byte[] payload = new byte[1000];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) ('a' + (i % 26));
        }

        assertTrue(MessageChunker.needsBinaryFragmenting(payload));

        List<MessageChunker.BinaryFragment> fragments =
                MessageChunker.createBinaryFragments(payload, 7, true, true);

        assertEquals(3, fragments.size());
        assertEquals(7, fragments.get(0).msgId);
        assertEquals(0, fragments.get(0).fragIdx);
        assertEquals(2, fragments.get(2).fragIdx);
        assertEquals(3, fragments.get(0).fragCount);
        assertTrue((fragments.get(0).flags & BleWireProtocol.BLE_WIRE_FLAG_WAKE) != 0);
        assertTrue((fragments.get(2).flags & BleWireProtocol.BLE_WIRE_FLAG_ACK_REQUESTED) != 0);
        assertTrue(MessageChunker.allBinaryFragmentsFit(fragments));
    }

    @Test
    public void binaryReassemblerRebuildsPayload() {
        byte[] payload = new byte[900];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i & 0xFF);
        }

        List<MessageChunker.BinaryFragment> fragments =
                MessageChunker.createBinaryFragments(payload, 99, false, false);
        MessageChunkReassembler reassembler = new MessageChunkReassembler();

        byte[] rebuilt = null;
        for (MessageChunker.BinaryFragment fragment : fragments) {
            rebuilt = reassembler.addBinaryFragment(
                    fragment.msgId,
                    fragment.fragIdx,
                    fragment.fragCount,
                    fragment.payload);
        }

        assertNotNull(rebuilt);
        assertEquals(payload.length, rebuilt.length);
        for (int i = 0; i < payload.length; i++) {
            assertEquals(payload[i], rebuilt[i]);
        }
    }
}
