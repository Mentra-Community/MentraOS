package com.mentra.asg_client.service.core.processors;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class ChunkReassemblerTest {

    @Test
    public void addBinaryFragment_duplicateFirstFragmentDoesNotResetProgress() {
        ChunkReassembler reassembler = new ChunkReassembler();
        byte firstFlag = 0x01;
        byte lastFlag = 0x02;
        byte[] first = "hel".getBytes(StandardCharsets.UTF_8);
        byte[] second = "lo".getBytes(StandardCharsets.UTF_8);

        assertThat(reassembler.addBinaryFragment(firstFlag, 7, 0, 2, first)).isNull();
        assertThat(reassembler.addBinaryFragment(firstFlag, 7, 0, 2, first)).isNull();

        byte[] reassembled = reassembler.addBinaryFragment(lastFlag, 7, 1, 2, second);

        assertThat(new String(reassembled, StandardCharsets.UTF_8)).isEqualTo("hello");
    }
}
