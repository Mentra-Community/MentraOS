package com.mentra.asg_client.service.system.core;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import com.mentra.asg_client.service.system.managers.MentraLiveSystemController;
import com.mentra.asg_client.service.system.managers.NoOpSystemController;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class SystemControllerFactoryTest {

    @Test
    public void get_returnsMentraLiveController_forK900Device() {
        ShadowBuild.setModel("MentraLive");
        Context context = ApplicationProvider.getApplicationContext();

        ISystemController controller = SystemControllerFactory.get(context);

        assertThat(controller).isInstanceOf(MentraLiveSystemController.class);
    }

    @Test
    public void get_returnsNoOpController_forGenericAndroid() {
        ShadowBuild.setModel("Pixel 7");
        ShadowBuild.setProduct("pixel_7");
        ShadowBuild.setManufacturer("Google");
        Context context = ApplicationProvider.getApplicationContext();

        ISystemController controller = SystemControllerFactory.get(context);

        assertThat(controller).isInstanceOf(NoOpSystemController.class);
        assertThat(controller.getSystemOtaVersion()).isEmpty();
    }
}
