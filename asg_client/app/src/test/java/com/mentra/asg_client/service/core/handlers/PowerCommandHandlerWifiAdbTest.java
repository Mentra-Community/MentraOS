package com.mentra.asg_client.service.core.handlers;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.settings.AsgSettings;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PowerCommandHandlerWifiAdbTest {

    @Test
    public void setWifiAdbState_enabled_persistsAndHandles() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        AsgSettings settings = new AsgSettings(app);
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        when(serviceManager.getAsgSettings()).thenReturn(settings);

        PowerCommandHandler handler = new PowerCommandHandler(app, serviceManager);
        JSONObject data = new JSONObject().put("enabled", true);

        assertTrue(handler.handleCommand(AsgConstants.COMMAND_SET_WIFI_ADB_STATE, data));
        assertTrue(settings.isWifiAdbEnabled());
        verify(serviceManager).getAsgSettings();
    }

    @Test
    public void setWifiAdbState_missingEnabled_defaultsFalse() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        AsgSettings settings = new AsgSettings(app);
        settings.setWifiAdbEnabled(true);
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        when(serviceManager.getAsgSettings()).thenReturn(settings);

        PowerCommandHandler handler = new PowerCommandHandler(app, serviceManager);
        assertTrue(handler.handleCommand(AsgConstants.COMMAND_SET_WIFI_ADB_STATE, new JSONObject()));
        assertFalse(settings.isWifiAdbEnabled());
    }

    @Test
    public void supportsSetWifiAdbStateCommand() {
        Application app = ApplicationProvider.getApplicationContext();
        PowerCommandHandler handler = new PowerCommandHandler(app, null);
        assertTrue(handler.getSupportedCommandTypes().contains(AsgConstants.COMMAND_SET_WIFI_ADB_STATE));
    }
}
