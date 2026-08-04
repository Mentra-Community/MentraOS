package com.mentra.asg_client.service.utils;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class DeviceProfileTest {

    @Test
    public void detect_returnsMentraLive_forMentraLiveModel() {
        ShadowBuild.setModel("MentraLive");
        Context context = ApplicationProvider.getApplicationContext();

        assertThat(DeviceProfile.detect(context)).isEqualTo(DeviceProfile.MENTRA_LIVE);
        assertThat(DeviceProfile.detect(context).isK900()).isTrue();
    }

    @Test
    public void detect_returnsMentraLive_forK900Model() {
        ShadowBuild.setModel("K900Plus");
        Context context = ApplicationProvider.getApplicationContext();

        assertThat(DeviceProfile.detect(context)).isEqualTo(DeviceProfile.MENTRA_LIVE);
    }

    @Test
    public void detect_returnsMentraLive_forXyGlassesProduct() {
        ShadowBuild.setModel("generic");
        ShadowBuild.setProduct("xyglasses");
        Context context = ApplicationProvider.getApplicationContext();

        assertThat(DeviceProfile.detect(context)).isEqualTo(DeviceProfile.MENTRA_LIVE);
    }

    @Test
    public void detect_returnsMentraLive_forXyAiGlassesFingerprint() {
        ShadowBuild.setModel("device");
        ShadowBuild.setFingerprint("xyaiglasses/release-keys");
        Context context = ApplicationProvider.getApplicationContext();

        assertThat(DeviceProfile.detect(context)).isEqualTo(DeviceProfile.MENTRA_LIVE);
    }

    @Test
    public void detect_returnsGenericAndroid_forPixelLikeDevice() {
        ShadowBuild.setModel("Pixel 7");
        ShadowBuild.setProduct("pixel_7");
        ShadowBuild.setDevice("panther");
        ShadowBuild.setManufacturer("Google");
        Context context = ApplicationProvider.getApplicationContext();

        assertThat(DeviceProfile.detect(context)).isEqualTo(DeviceProfile.GENERIC_ANDROID);
        assertThat(DeviceProfile.detect(context).isK900()).isFalse();
    }
}
