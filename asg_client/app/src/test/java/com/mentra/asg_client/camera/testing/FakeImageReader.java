package com.mentra.asg_client.camera.testing;

import android.media.Image;
import android.media.ImageReader;

import org.mockito.Mockito;

/**
 * Test doubles for {@link ImageReader} / {@link Image} (used when not exercising real buffers).
 */
public final class FakeImageReader {

    private FakeImageReader() {}

    public static Image mockImage(long timestampNs) {
        Image image = Mockito.mock(Image.class);
        Mockito.when(image.getTimestamp()).thenReturn(timestampNs);
        return image;
    }
}
