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
    public void targetSize_sdkSupportsFull() {
        assertThat(PhotoResolutionPolicy.targetSize(true, CameraConstants.SIZE_FULL))
                .isEqualTo(new Size(CameraConstants.SDK_WIDTH_FULL, CameraConstants.SDK_HEIGHT_FULL));
    }

    @Test
    public void targetSize_buttonIgnoresFullAndDefaultsToMedium() {
        assertThat(PhotoResolutionPolicy.targetSize(false, CameraConstants.SIZE_FULL))
                .isEqualTo(new Size(CameraConstants.BUTTON_WIDTH_MEDIUM, CameraConstants.BUTTON_HEIGHT_MEDIUM));
    }

    @Test
    public void targetSize_buttonLarge() {
        assertThat(PhotoResolutionPolicy.targetSize(false, CameraConstants.SIZE_LARGE))
                .isEqualTo(new Size(CameraConstants.BUTTON_WIDTH_LARGE, CameraConstants.BUTTON_HEIGHT_LARGE));
    }
}
