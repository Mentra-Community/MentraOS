package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraRecoveryHelperTest {

    @Test
    public void pickAlternateCameraId_returnsFirstDifferentId() {
        assertThat(CameraRecoveryHelper.pickAlternateCameraId("0", new String[] {"0", "2", "1"}))
                .isEqualTo("2");
    }

    @Test
    public void pickAlternateCameraId_singleCamera_returnsNull() {
        assertThat(CameraRecoveryHelper.pickAlternateCameraId("0", new String[] {"0"})).isNull();
    }

    @Test
    public void pickAlternateCameraId_nullCurrent_returnsNull() {
        assertThat(CameraRecoveryHelper.pickAlternateCameraId(null, new String[] {"0", "1"})).isNull();
    }
}
