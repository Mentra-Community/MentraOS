package com.mentra.asg_client.camera.request;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * {@link CaptureRequest.Builder} is final on Android; preview tuning is covered indirectly via
 * {@link com.mentra.asg_client.camera.lifecycle.CameraNeoService} integration. This test anchors the
 * configurator type for refactors.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PreviewRequestConfiguratorTest {

    @Test
    public void configure_methodIsDeclared() throws NoSuchMethodException {
        assertThat(PreviewRequestConfigurator.class.getDeclaredMethod(
                "configure",
                android.hardware.camera2.CaptureRequest.Builder.class,
                boolean.class,
                int.class,
                boolean.class,
                android.util.Range.class,
                boolean.class,
                int.class,
                android.util.Size.class,
                int.class,
                int.class,
                com.mentra.asg_client.camera.CameraSettings.class)).isNotNull();
    }
}
