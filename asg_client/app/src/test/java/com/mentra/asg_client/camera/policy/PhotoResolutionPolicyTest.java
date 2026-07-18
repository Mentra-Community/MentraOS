package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import android.util.Size;

import com.mentra.asg_client.camera.CameraConstants;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoResolutionPolicyTest {

    @Test
    public void targetSize_sdkDefaultsToMedium() {
        assertThat(PhotoResolutionPolicy.targetSize(true, null))
                .isEqualTo(new Size(CameraConstants.SDK_WIDTH_MEDIUM, CameraConstants.SDK_HEIGHT_MEDIUM));
    }

    @Test
    public void targetSize_sdkHigh() {
        assertThat(PhotoResolutionPolicy.targetSize(true, CameraConstants.SIZE_HIGH))
                .isEqualTo(new Size(CameraConstants.SDK_WIDTH_LARGE, CameraConstants.SDK_HEIGHT_LARGE));
    }

    @Test
    public void targetSize_sdkLegacyFullMapsToMaxViaNormalizer() {
        assertThat(PhotoResolutionPolicy.targetSize(true, "full"))
                .isEqualTo(new Size(CameraConstants.SDK_WIDTH_MEDIUM, CameraConstants.SDK_HEIGHT_MEDIUM));
    }

    @Test
    public void targetSize_buttonHigh() {
        assertThat(PhotoResolutionPolicy.targetSize(false, CameraConstants.SIZE_HIGH))
                .isEqualTo(new Size(CameraConstants.BUTTON_WIDTH_LARGE, CameraConstants.BUTTON_HEIGHT_LARGE));
    }

    @Test
    public void targetSize_textModeUsesAsgSensorConstants() {
        assertThat(PhotoResolutionPolicy.targetSize(true, CameraConstants.SIZE_TEXT))
                .isEqualTo(PhotoResolutionPolicy.textModeSensorTarget());
        assertThat(PhotoResolutionPolicy.targetSize(false, CameraConstants.SIZE_TEXT))
                .isEqualTo(PhotoResolutionPolicy.textModeSensorTarget());
        assertThat(PhotoResolutionPolicy.textModeSensorTarget().getWidth()).isEqualTo(3840);
        assertThat(PhotoResolutionPolicy.textModeSensorTarget().getHeight()).isEqualTo(2160);
    }
}
