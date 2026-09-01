package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.content.Context;
import android.net.wifi.WifiManager;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.network.interfaces.SavedWifiNetworksOutcome;
import com.mentra.asg_client.io.network.interfaces.SavedWifiNetworksResult;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;
import java.util.Collections;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class SystemNetworkManagerSavedNetworksTest {
    @Test
    public void reportsConfirmedEmptyWhenEnumerationSucceedsWithNoSavedNetworks() {
        WifiManager wifiManager = mock(WifiManager.class);
        when(wifiManager.getConfiguredNetworks()).thenReturn(Collections.emptyList());
        SystemNetworkManager manager = newManager(wifiManager);

        SavedWifiNetworksResult result = manager.getSavedWifiNetworksResult();

        assertThat(result.getOutcome()).isEqualTo(SavedWifiNetworksOutcome.CONFIRMED);
        assertThat(result.getNetworks()).isEmpty();
        assertThat(result.getError()).isNull();
    }

    @Test
    public void reportsFailureWhenPlatformEnumerationThrows() {
        WifiManager wifiManager = mock(WifiManager.class);
        when(wifiManager.getConfiguredNetworks()).thenThrow(new SecurityException("denied"));
        SystemNetworkManager manager = newManager(wifiManager);

        SavedWifiNetworksResult result = manager.getSavedWifiNetworksResult();

        assertThat(result.getOutcome()).isEqualTo(SavedWifiNetworksOutcome.FAILED);
        assertThat(result.getNetworks()).isEmpty();
        assertThat(result.getError()).isEqualTo("list_saved_networks_failed");
    }

    private static SystemNetworkManager newManager(WifiManager wifiManager) {
        Context context = ApplicationProvider.getApplicationContext();
        return new SystemNetworkManager(
                context, mock(DebugNotificationManager.class), wifiManager);
    }
}
