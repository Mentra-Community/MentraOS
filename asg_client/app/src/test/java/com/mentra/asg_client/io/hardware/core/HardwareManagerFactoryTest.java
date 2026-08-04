package com.mentra.asg_client.io.hardware.core;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.hardware.interfaces.Capability;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.managers.K900HardwareManager;
import com.mentra.asg_client.io.hardware.managers.StandardHardwareManager;
import java.lang.reflect.Method;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;

/**
 * Tests factory device selection without calling {@link IHardwareManager#initialize()}, which loads
 * K900 native {@code xydev} libraries unavailable on the JVM test host.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class HardwareManagerFactoryTest {

    @After
    public void tearDown() {
        if (!HardwareManagerFactory.hasInstance()) {
            return;
        }
        // Only reset when the singleton is StandardHardwareManager (no native LED libs).
        try {
            Method create =
                    HardwareManagerFactory.class.getDeclaredMethod(
                            "createHardwareManager", Context.class);
            create.setAccessible(true);
            Context context = ApplicationProvider.getApplicationContext();
            IHardwareManager probe = (IHardwareManager) create.invoke(null, context);
            if (probe instanceof StandardHardwareManager) {
                HardwareManagerFactory.reset();
            }
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void createHardwareManager_returnsK900_forMentraLive() throws Exception {
        ShadowBuild.setModel("MentraLive");
        IHardwareManager manager = invokeCreateHardwareManager();

        assertThat(manager).isInstanceOf(K900HardwareManager.class);
        assertThat(manager.getCapabilities())
                .contains(Capability.RECORDING_LED, Capability.RGB_LED, Capability.MCU_BATTERY);
    }

    @Test
    public void createHardwareManager_returnsStandard_forGenericAndroid() throws Exception {
        ShadowBuild.setModel("Pixel 7");
        ShadowBuild.setProduct("pixel_7");
        ShadowBuild.setManufacturer("Google");
        IHardwareManager manager = invokeCreateHardwareManager();

        assertThat(manager).isInstanceOf(StandardHardwareManager.class);
        assertThat(manager.getCapabilities()).contains(Capability.MCU_BATTERY);
    }

    @Test
    public void getInstance_returnsStandardManager_onGenericDevice() {
        ShadowBuild.setModel("Pixel 7");
        ShadowBuild.setProduct("pixel_7");
        ShadowBuild.setManufacturer("Google");
        Context context = ApplicationProvider.getApplicationContext();

        IHardwareManager manager = HardwareManagerFactory.getInstance(context);

        assertThat(manager).isInstanceOf(StandardHardwareManager.class);
    }

    private static IHardwareManager invokeCreateHardwareManager() throws Exception {
        Method create =
                HardwareManagerFactory.class.getDeclaredMethod(
                        "createHardwareManager", Context.class);
        create.setAccessible(true);
        Context context = ApplicationProvider.getApplicationContext();
        return (IHardwareManager) create.invoke(null, context);
    }
}
