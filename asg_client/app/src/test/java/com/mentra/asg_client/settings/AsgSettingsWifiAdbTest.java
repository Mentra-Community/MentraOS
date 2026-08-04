package com.mentra.asg_client.settings;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AsgSettingsWifiAdbTest {

    @Test
    public void isWifiAdbEnabled_defaultsToFalse() {
        Application app = ApplicationProvider.getApplicationContext();
        AsgSettings settings = new AsgSettings(app);
        assertFalse(settings.isWifiAdbEnabled());
    }

    @Test
    public void setWifiAdbEnabled_persistsValue() {
        Application app = ApplicationProvider.getApplicationContext();
        AsgSettings settings = new AsgSettings(app);
        settings.setWifiAdbEnabled(true);
        assertTrue(settings.isWifiAdbEnabled());
        settings.setWifiAdbEnabled(false);
        assertFalse(settings.isWifiAdbEnabled());
    }
}
