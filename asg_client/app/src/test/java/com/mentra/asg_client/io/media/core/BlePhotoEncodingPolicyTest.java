package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.assertEquals;

import com.mentra.asg_client.AsgConstants;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies that BLE photo policy follows the central codec configuration, and that text mode and
 * ordinary photo mode resolve to the exact same codec — there is no per-mode split.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BlePhotoEncodingPolicyTest {
    @Test
    public void textModeUsesConfiguredCodec() {
        assertEquals(configuredCodec(), BlePhotoEncodingPolicy.selectCodec());
    }

    @Test
    public void ordinaryPhotoModeUsesConfiguredCodec() {
        assertEquals(configuredCodec(), BlePhotoEncodingPolicy.selectCodec());
    }

    @Test
    public void textModeAndOrdinaryModeAgree() {
        // selectCodec() takes no mode argument: both call sites in MediaCaptureService resolve
        // to this same value, by design.
        assertEquals(BlePhotoEncodingPolicy.selectCodec(), BlePhotoEncodingPolicy.selectCodec());
    }

    private static BleCodec configuredCodec() {
        return BleCodec.valueOf(AsgConstants.BLE_PHOTO_CODEC);
    }
}
