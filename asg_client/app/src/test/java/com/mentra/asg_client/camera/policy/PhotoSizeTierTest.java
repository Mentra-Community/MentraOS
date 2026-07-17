package com.mentra.asg_client.camera.policy;

import static org.junit.Assert.assertEquals;

import com.mentra.asg_client.camera.CameraConstants;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class PhotoSizeTierTest {

    @Test
    public void normalizeRejectsInternalTextTierFromPublicSizeField() {
        assertEquals(CameraConstants.SIZE_MEDIUM, PhotoSizeTier.normalize(CameraConstants.SIZE_TEXT));
    }

    @Test
    public void normalizeCaptureSizePreservesResolvedTextTier() {
        assertEquals(
                CameraConstants.SIZE_TEXT,
                PhotoSizeTier.normalizeCaptureSize(CameraConstants.SIZE_TEXT));
    }
}
