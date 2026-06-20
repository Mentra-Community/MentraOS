package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Arrays;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesMessageParserTest {

    @Test
    public void parseMessages_extractsConcatenatedK900Frames() {
        BesMessageParser parser = new BesMessageParser();
        byte[] first = packPhoneJson("{\"type\":\"request_wifi_scan\",\"mId\":3}", true);
        byte[] second = packPhoneJson("{\"type\":\"ping\",\"mId\":4}", true);
        byte[] combined = concat(first, second);

        assertThat(parser.addData(combined, combined.length)).isTrue();

        List<byte[]> messages = parser.parseMessages();

        assertThat(messages).hasSize(2);
        assertThat(messages.get(0)).isEqualTo(first);
        assertThat(messages.get(1)).isEqualTo(second);
        assertThat(parser.getBufferSize()).isEqualTo(0);
    }

    @Test
    public void parseMessages_usesDeclaredLengthWhenPayloadContainsEndMarkerBytes() {
        BesMessageParser parser = new BesMessageParser();
        byte[] frame = packPhoneJson("{\"type\":\"note\",\"text\":\"keep $$ inside\"}", true);

        assertThat(parser.addData(frame, frame.length)).isTrue();

        List<byte[]> messages = parser.parseMessages();

        assertThat(messages).hasSize(1);
        assertThat(messages.get(0)).isEqualTo(frame);
        assertThat(parser.getBufferSize()).isEqualTo(0);
    }

    @Test
    public void parseMessages_dropsTruncatedFrameAndResyncsAtNextFrame() {
        BesMessageParser parser = new BesMessageParser();
        byte[] truncatedScan =
                stripTrailingBytes(
                        packPhoneJson("{\"type\":\"request_wifi_scan\",\"mId\":3}", true), 4);
        byte[] nextFrame = packPhoneJson("{\"type\":\"ping\",\"mId\":4}", true);
        byte[] combined = concat(truncatedScan, nextFrame);

        assertThat(parser.addData(combined, combined.length)).isTrue();

        List<byte[]> messages = parser.parseMessages();

        assertThat(messages).hasSize(1);
        assertThat(messages.get(0)).isEqualTo(nextFrame);
        assertThat(parser.getBufferSize()).isEqualTo(0);
    }

    @Test
    public void parseMessages_waitsForSplitFrameCompletion() {
        BesMessageParser parser = new BesMessageParser();
        byte[] frame = packPhoneJson("{\"type\":\"request_wifi_scan\",\"mId\":3}", true);
        byte[] firstHalf = Arrays.copyOfRange(frame, 0, frame.length / 2);
        byte[] secondHalf = Arrays.copyOfRange(frame, frame.length / 2, frame.length);

        assertThat(parser.addData(firstHalf, firstHalf.length)).isTrue();
        assertThat(parser.parseMessages()).isNull();
        assertThat(parser.getBufferSize()).isEqualTo(firstHalf.length);

        assertThat(parser.addData(secondHalf, secondHalf.length)).isTrue();

        List<byte[]> messages = parser.parseMessages();

        assertThat(messages).hasSize(1);
        assertThat(messages.get(0)).isEqualTo(frame);
        assertThat(parser.getBufferSize()).isEqualTo(0);
    }

    private static byte[] packPhoneJson(String json, boolean wakeup) {
        byte[] packed = BesWireFormat.packJsonToK900(json, wakeup);
        assertThat(packed).isNotNull();
        return packed;
    }

    private static byte[] stripTrailingBytes(byte[] bytes, int count) {
        return Arrays.copyOf(bytes, bytes.length - count);
    }

    private static byte[] concat(byte[] first, byte[] second) {
        byte[] combined = new byte[first.length + second.length];
        System.arraycopy(first, 0, combined, 0, first.length);
        System.arraycopy(second, 0, combined, first.length, second.length);
        return combined;
    }
}
