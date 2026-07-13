package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.mentra.asg_client.AsgConstants;
import org.junit.Test;

public class BlePhotoEncodingPolicyTest {
    @Test
    public void textModeUsesJpegWhenActualPayloadIsUnderThreshold() {
        byte[] jpeg = new byte[AsgConstants.TEXT_MODE_AVIF_SIZE_THRESHOLD_BYTES - 1];

        assertTrue(BlePhotoEncodingPolicy.shouldUseJpeg(true, jpeg));
    }

    @Test
    public void textModeUsesAvifWhenActualJpegPayloadReachesThreshold() {
        byte[] jpeg = new byte[AsgConstants.TEXT_MODE_AVIF_SIZE_THRESHOLD_BYTES];

        assertFalse(BlePhotoEncodingPolicy.shouldUseJpeg(true, jpeg));
    }

    @Test
    public void ordinaryPhotoModeAlwaysUsesAvif() {
        assertFalse(BlePhotoEncodingPolicy.shouldUseJpeg(true, null));
        assertFalse(BlePhotoEncodingPolicy.shouldUseJpeg(false, new byte[1]));
    }
}
