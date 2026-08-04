package com.mentra.asg_client.io.network.core;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.network.interfaces.INetworkController;
import com.mentra.asg_client.io.network.managers.FallbackNetworkManager;
import com.mentra.asg_client.io.network.managers.K900NetworkManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class NetworkManagerFactoryTest {

    @Test
    public void getNetworkManager_returnsK900Manager_forMentraLive() {
        ShadowBuild.setModel("MentraLive");
        Context context = ApplicationProvider.getApplicationContext();

        INetworkController manager = NetworkManagerFactory.getNetworkManager(context);

        assertThat(manager).isInstanceOf(K900NetworkManager.class);
    }

    @Test
    public void getNetworkManager_returnsFallback_forGenericNonSystemInstall() {
        ShadowBuild.setModel("Pixel 7");
        ShadowBuild.setProduct("pixel_7");
        ShadowBuild.setManufacturer("Google");
        Context context = ApplicationProvider.getApplicationContext();

        INetworkController manager = NetworkManagerFactory.getNetworkManager(context);

        assertThat(manager).isInstanceOf(FallbackNetworkManager.class);
    }
}
