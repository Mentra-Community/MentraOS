package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.assertEquals;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies that every BLE photo mode selects the low-latency JPEG codec. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BlePhotoEncodingPolicyTest {
    @Test
    public void textModeUsesFastJpegCodec() {
        assertEquals(BleCodec.JPEG_FAST, BlePhotoEncodingPolicy.selectCodec());
    }

    @Test
    public void ordinaryPhotoModeUsesFastJpegCodec() {
        assertEquals(BleCodec.JPEG_FAST, BlePhotoEncodingPolicy.selectCodec());
    }
}
