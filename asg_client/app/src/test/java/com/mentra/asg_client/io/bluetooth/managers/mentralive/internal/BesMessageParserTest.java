package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesMessageParserTest {

    @Test
    public void discardedByteCount_reportsAndConsumesUnframedInput() {
        BesMessageParser parser = new BesMessageParser();
        byte[] garbage = new byte[1024];
        Arrays.fill(garbage, (byte) 0x55);

        assertThat(parser.addData(garbage, garbage.length)).isTrue();
        assertThat(parser.parseMessages()).isNull();
        assertThat(parser.consumeDiscardedByteCount()).isEqualTo(garbage.length);
        assertThat(parser.consumeDiscardedByteCount()).isZero();
    }

    @Test
    public void clear_doesNotReportIntentionalBufferDiscardAsCorruption() {
        BesMessageParser parser = new BesMessageParser();
        byte[] partialFrame = {'#', '#', 0x01};

        assertThat(parser.addData(partialFrame, partialFrame.length)).isTrue();
        assertThat(parser.parseMessages()).isNull();
        parser.clear();

        assertThat(parser.consumeDiscardedByteCount()).isZero();
    }
}
