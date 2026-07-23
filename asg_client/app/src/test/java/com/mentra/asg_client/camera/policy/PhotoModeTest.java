package com.mentra.asg_client.camera.policy;

import static org.junit.Assert.assertEquals;

import com.mentra.asg_client.camera.CameraConstants;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class PhotoModeTest {

    @Test
    public void normalizeDefaultsMissingModeToPhoto() {
        assertEquals(PhotoMode.PHOTO, PhotoMode.normalize(null));
        assertEquals(PhotoMode.PHOTO, PhotoMode.normalize(""));
    }

    @Test
    public void normalizePreservesSupportedModes() {
        assertEquals(PhotoMode.PHOTO, PhotoMode.normalize("photo"));
        assertEquals(PhotoMode.TEXT, PhotoMode.normalize("text"));
    }

    @Test
    public void captureSizeMapsTextToInternalTextTier() {
        assertEquals(CameraConstants.SIZE_TEXT, PhotoMode.captureSize("text", "low"));
        assertEquals(CameraConstants.SIZE_TEXT, PhotoMode.captureSize("text", "medium"));
    }

    @Test
    public void captureSizePreservesPhotoTier() {
        assertEquals("low", PhotoMode.captureSize("photo", "low"));
        assertEquals("high", PhotoMode.captureSize("photo", "high"));
    }

    @Test
    public void captureSizeRejectsInternalTextTierForPhotoMode() {
        assertEquals(
                CameraConstants.SIZE_MEDIUM,
                PhotoMode.captureSize(PhotoMode.PHOTO, CameraConstants.SIZE_TEXT));
    }
}
