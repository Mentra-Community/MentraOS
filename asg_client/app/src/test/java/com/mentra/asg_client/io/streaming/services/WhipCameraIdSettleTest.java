package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * The vendor FOV/ROI override leaves {@code getCameraIdList()} reporting "0" while
 * {@code getCameraCharacteristics("0")} throws {@code Unknown camera ID 0}. Mentra Call starts WHIP
 * inside that window, so the enumeration has to outlast it rather than fail the call.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class WhipCameraIdSettleTest {

    @Test
    public void selectBackCamera_retriesUntilTheCameraServiceServesCharacteristics()
            throws CameraAccessException {
        CameraManager manager = mock(CameraManager.class);
        when(manager.getCameraIdList()).thenReturn(new String[] {"0"});

        CameraCharacteristics back = mock(CameraCharacteristics.class);
        when(back.get(CameraCharacteristics.LENS_FACING))
                .thenReturn(CameraCharacteristics.LENS_FACING_BACK);
        when(manager.getCameraCharacteristics("0"))
                .thenThrow(new IllegalArgumentException("supportsCameraApi:2340: Unknown camera ID 0"))
                .thenReturn(back);

        assertEquals("0", WhipCameraFormatSelector.selectBackCamera(manager));
        verify(manager, times(2)).getCameraCharacteristics("0");
    }

    @Test
    public void selectBackCamera_rethrowsWhenTheCameraNeverSettles() throws CameraAccessException {
        CameraManager manager = mock(CameraManager.class);
        when(manager.getCameraIdList()).thenReturn(new String[] {"0"});
        when(manager.getCameraCharacteristics("0"))
                .thenThrow(new IllegalArgumentException("supportsCameraApi:2340: Unknown camera ID 0"));

        assertThrows(
                IllegalArgumentException.class,
                () -> WhipCameraFormatSelector.selectBackCamera(manager));
    }

    @Test
    public void selectBackCamera_doesNotRetryAHealthyEnumeration() throws CameraAccessException {
        CameraManager manager = mock(CameraManager.class);
        when(manager.getCameraIdList()).thenReturn(new String[] {"0"});

        CameraCharacteristics back = mock(CameraCharacteristics.class);
        when(back.get(CameraCharacteristics.LENS_FACING))
                .thenReturn(CameraCharacteristics.LENS_FACING_BACK);
        when(manager.getCameraCharacteristics("0")).thenReturn(back);

        assertEquals("0", WhipCameraFormatSelector.selectBackCamera(manager));
        verify(manager, times(1)).getCameraCharacteristics("0");
    }
}
