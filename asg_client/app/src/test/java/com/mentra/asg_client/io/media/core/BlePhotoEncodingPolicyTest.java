package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.assertEquals;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Robolectric because the policy's unknown-codec fallback logs via {@code android.util.Log}. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BlePhotoEncodingPolicyTest {
    @Test
    public void textModeUsesConfiguredFastJpegCodec() {
        assertEquals(BleCodec.JPEG_FAST, BlePhotoEncodingPolicy.selectCodec(true));
    }

    @Test
    public void ordinaryPhotoModeAlwaysUsesAvif() {
        assertEquals(BleCodec.AVIF, BlePhotoEncodingPolicy.selectCodec(false));
    }

    @Test
    public void parseCodecAcceptsBothCodecNames() {
        assertEquals(BleCodec.JPEG_FAST, BlePhotoEncodingPolicy.parseCodec("JPEG_FAST"));
        assertEquals(BleCodec.AVIF, BlePhotoEncodingPolicy.parseCodec("AVIF"));
    }

    @Test
    public void parseCodecFallsBackToAvifOnUnknownName() {
        assertEquals(BleCodec.AVIF, BlePhotoEncodingPolicy.parseCodec("JPEG_XL"));
        assertEquals(BleCodec.AVIF, BlePhotoEncodingPolicy.parseCodec(null));
    }
}
