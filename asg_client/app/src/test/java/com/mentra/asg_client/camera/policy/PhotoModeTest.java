package com.mentra.asg_client.camera.policy;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

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
}
