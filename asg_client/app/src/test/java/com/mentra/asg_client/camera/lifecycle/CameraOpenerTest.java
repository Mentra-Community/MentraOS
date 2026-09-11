package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.util.Size;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraOpenerTest {

    @Test
    public void selectPrimaryCameraId_prefersBackFacing() throws CameraAccessException {
        CameraManager manager = mock(CameraManager.class);
        when(manager.getCameraIdList()).thenReturn(new String[] {"0", "1"});

        CameraCharacteristics front = mock(CameraCharacteristics.class);
        when(front.get(CameraCharacteristics.LENS_FACING))
                .thenReturn(CameraCharacteristics.LENS_FACING_FRONT);
        when(manager.getCameraCharacteristics("0")).thenReturn(front);

        CameraCharacteristics back = mock(CameraCharacteristics.class);
        when(back.get(CameraCharacteristics.LENS_FACING))
                .thenReturn(CameraCharacteristics.LENS_FACING_BACK);
        when(manager.getCameraCharacteristics("1")).thenReturn(back);

        assertThat(CameraOpener.selectPrimaryCameraId(manager)).isEqualTo("1");
    }

    @Test
    public void resolveJpegSize_returnsClosestToPolicyTarget() {
        Size[] sizes = new Size[] {
                new Size(640, 480),
                new Size(1920, 1440),
        };
        Size chosen = CameraOpener.resolveJpegSize(sizes, true, "medium");
        assertThat(chosen).isIn(sizes);
    }

    @Test
    public void resolveJpegSize_maxSelectsLargestAvailable() {
        Size max = new Size(4032, 3024);
        Size[] sizes =
                new Size[] {
                    new Size(1920, 1080),
                    max,
                    new Size(3264, 2448),
                    new Size(3840, 2160),
                };

        Size chosen = CameraOpener.resolveJpegSize(sizes, false, "max");
        assertThat(chosen).isSameAs(max);
    }

    @Test
    public void resolveJpegSize_textUsesClosestToAsgSensorConstants() {
        Size exact = new Size(3840, 2160);
        Size[] withExact =
                new Size[] {
                    new Size(1920, 1080),
                    exact,
                    new Size(4032, 3024),
                    new Size(3264, 2448),
                };
        assertThat(CameraOpener.resolveJpegSize(withExact, true, "text")).isSameAs(exact);

        Size closestByL1 = new Size(3264, 2448);
        Size[] withoutExact =
                new Size[] {
                    new Size(1920, 1080),
                    new Size(4032, 3024),
                    closestByL1,
                };
        // Fallback uses CameraSizeSelector L1 distance to 3840×2160 (not aspect-ratio filter).
        assertThat(CameraOpener.resolveJpegSize(withoutExact, true, "text")).isSameAs(closestByL1);
    }

    @Test
    public void resolveVideoSize_usesDefaultWhenSettingsInvalid() {
        Size[] sizes = new Size[] {new Size(1280, 720), new Size(1920, 1080)};
        Size chosen = CameraOpener.resolveVideoSize(sizes, null);
        assertThat(chosen.getWidth()).isGreaterThan(0);
    }
}
