package com.mentra.asg_client.di.hilt;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bes.BesOtaRegistry;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies {@link OtaModule} providers bind the core OTA interfaces to the vendor singletons. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaModuleTest {

    @Test
    public void provideBesOtaRegistry_returnsSameUnderlyingInstance() {
        BesOtaRegistry impl = new BesOtaRegistry();

        IBesOtaRegistry bound = OtaModule.provideBesOtaRegistry(impl);

        assertThat(bound).isSameAs(impl);
    }

    @Test
    public void provideOtaHelper_wiresHelperWithRegistry() {
        Context context = ApplicationProvider.getApplicationContext();
        IBesOtaRegistry registry = OtaModule.provideBesOtaRegistry(new BesOtaRegistry());

        OtaHelper helper = OtaModule.provideOtaHelper(context, registry);

        assertThat(helper).isNotNull();
        helper.cleanup();
    }
}
