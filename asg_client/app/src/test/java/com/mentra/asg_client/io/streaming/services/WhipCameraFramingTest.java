package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.util.Size;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Guard the horizontal field of view across both the sensor crop and camera surface selection. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class WhipCameraFramingTest {
    @Test public void bottomCropPreservesBothHorizontalEdgesAndBottomEdge() {
        Rect active = new Rect(0, 0, 4032, 3024);
        assertEquals(new Rect(0, 756, 4032, 3024),
                WhipCameraFormatSelector.getBottomAlignedCrop(active, 960, 540));
        assertEquals(new Rect(0, 756, 4032, 3024),
                WhipCameraFormatSelector.getBottomAlignedCrop(active, 1920, 1080));
        assertEquals(new Rect(0, 0, 4032, 3024), active);
    }

    @Test public void cropUsesCurrentActiveArrayOriginAndRoundsHeightToEven() {
        assertEquals(new Rect(16, 764, 4048, 3032),
                WhipCameraFormatSelector.getBottomAlignedCrop(new Rect(16, 8, 4048, 3032), 960, 540));
        Rect active = new Rect(0, 0, 4016, 3012);
        Rect crop = WhipCameraFormatSelector.getBottomAlignedCrop(active, 960, 540);
        assertEquals(active.left, crop.left);
        assertEquals(active.right, crop.right);
        assertEquals(active.bottom, crop.bottom);
        assertEquals(2258, crop.height());
    }

    @Test public void invalidOrTooTallCropFailsInsteadOfRemovingHorizontalContent() {
        assertThrows(IllegalArgumentException.class,
                () -> WhipCameraFormatSelector.getBottomAlignedCrop(null, 960, 540));
        assertThrows(IllegalArgumentException.class,
                () -> WhipCameraFormatSelector.getBottomAlignedCrop(new Rect(0, 0, 4032, 3024), 1, 1));
    }

    @Test public void bottomCaptureUsesSupported16By9SurfaceBeforeScaling() {
        Size[] available = {new Size(960, 720), new Size(1920, 1080), new Size(1280, 720),
                new Size(1080, 1920), new Size(640, 360), new Size(3840, 2160)};
        var selection = WhipCameraFormatSelector.selectBottomAlignedCaptureSize(available, 960, 540);
        assertEquals(new Size(1280, 720), selection.getRawCaptureSize());
        assertEquals(1, selection.getTransformPenalty());
        assertFalse(selection.requiresUpscale());
        assertEquals(new Size(1920, 1080),
                WhipCameraFormatSelector.selectBottomAlignedCaptureSize(available, 1920, 1080)
                        .getRawCaptureSize());
    }

    @Test public void missingOrWrongAspectSurfacesFailWithoutInventingAnOutputSize() {
        assertThrows(IllegalArgumentException.class,
                () -> WhipCameraFormatSelector.selectBottomAlignedCaptureSize((Size[]) null, 960, 540));
        assertThrows(IllegalArgumentException.class,
                () -> WhipCameraFormatSelector.selectBottomAlignedCaptureSize(
                        new Size[] {new Size(960, 720), new Size(1080, 1920), new Size(640, 360),
                                new Size(3840, 2160)}, 960, 540));
    }

    @Test public void centerSelectionRetainsExisting960By720Preference() {
        CameraCharacteristics chars = mock(CameraCharacteristics.class);
        StreamConfigurationMap map = mock(StreamConfigurationMap.class);
        when(chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)).thenReturn(map);
        when(map.getOutputSizes(SurfaceTexture.class)).thenReturn(
                new Size[] {new Size(1280, 720), new Size(960, 720), new Size(1920, 1080)});
        assertEquals(new Size(960, 720),
                WhipCameraFormatSelector.selectCaptureSize(chars, 960, 540).getRawCaptureSize());
        assertEquals(new Size(1280, 720),
                WhipCameraFormatSelector.selectBottomAlignedCaptureSize(chars, 960, 540)
                        .getRawCaptureSize());
    }
}
