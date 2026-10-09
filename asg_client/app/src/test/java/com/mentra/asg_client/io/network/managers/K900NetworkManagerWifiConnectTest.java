package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.service.system.interfaces.ISystemController;
import com.mentra.asg_client.service.system.managers.MentraLiveSystemController;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.time.Duration;
import java.util.Collections;

@RunWith(RobolectricTestRunner.class)
@Config(
        application = Application.class,
        sdk = {30, 33})
public class K900NetworkManagerWifiConnectTest {
    private final String mSsid = "Test network";
    private final String mPassword = "test-password";
    private final WifiManager mWifiManager = mock(WifiManager.class);
    private final ISystemController mSystemController = mock(ISystemController.class);
    private Context mContext;
    private ApplicationInfo mApplicationInfo;

    @Before
    public void setUp() throws Exception {
        Context application = ApplicationProvider.getApplicationContext();
        PackageManager packageManager = mock(PackageManager.class);
        mApplicationInfo = new ApplicationInfo();
        mApplicationInfo.flags = ApplicationInfo.FLAG_SYSTEM;
        when(packageManager.getApplicationInfo(application.getPackageName(), 0))
                .thenReturn(mApplicationInfo);
        mContext =
                new ContextWrapper(application) {
                    @Override
                    public Object getSystemService(String name) {
                        return Context.WIFI_SERVICE.equals(name)
                                ? mWifiManager
                                : super.getSystemService(name);
                    }

                    @Override
                    public PackageManager getPackageManager() {
                        return packageManager;
                    }
                };
        when(mWifiManager.addNetwork(any(WifiConfiguration.class))).thenReturn(7);
        when(mWifiManager.enableNetwork(7, true)).thenReturn(true);
        when(mWifiManager.reconnect()).thenReturn(true);
    }

    @Test
    public void rejectedNewNetworkFallsBackWithOriginalCredentials() {
        when(mWifiManager.addNetwork(any(WifiConfiguration.class))).thenReturn(-1);

        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, mPassword);

        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, mPassword);
        verify(mWifiManager, never()).disconnect();
        verify(mWifiManager, never()).enableNetwork(anyInt(), anyBoolean());
        verify(mWifiManager, never()).reconnect();
    }

    @Test
    public void acceptedNativeConnectionPreservesPskAndDoesNotDispatchVendorRefresh() {
        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, mPassword);

        WifiConfiguration configuration = captureConfiguration();
        assertThat(configuration.SSID).isEqualTo("\"" + mSsid + "\"");
        assertThat(configuration.preSharedKey).isEqualTo("\"" + mPassword + "\"");
        assertThat(configuration.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.WPA_PSK))
                .isTrue();
        verify(mWifiManager).enableNetwork(7, true);
        verify(mWifiManager).reconnect();
        verify(mSystemController, never()).connectToWifiWithCredentialRefresh(any(), any());
    }

    @Test
    public void acceptedNativeConnectionPreservesWpa3Security() {
        ScanResult network = new ScanResult();
        network.SSID = mSsid;
        network.capabilities = "[RSN-SAE-CCMP][ESS]";
        network.level = -49;
        when(mWifiManager.getScanResults()).thenReturn(Collections.singletonList(network));

        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, mPassword);

        assertThat(captureConfiguration().allowedKeyManagement.get(WifiConfiguration.KeyMgmt.SAE))
                .isTrue();
        verify(mSystemController, never()).connectToWifiWithCredentialRefresh(any(), any());
    }

    @Test
    public void rejectedOpenNetworkPreservesEmptyPassword() {
        when(mWifiManager.addNetwork(any(WifiConfiguration.class))).thenReturn(-1);

        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, "");

        assertThat(captureConfiguration().allowedKeyManagement.get(WifiConfiguration.KeyMgmt.NONE))
                .isTrue();
        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, "");
    }

    @Test
    public void rejectedEnableFallsBackWithoutReconnectingNativeNetwork() {
        when(mWifiManager.enableNetwork(7, true)).thenReturn(false);

        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, mPassword);

        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, mPassword);
        verify(mWifiManager, never()).reconnect();
    }

    @Test
    public void rejectedReconnectFallsBack() {
        when(mWifiManager.reconnect()).thenReturn(false);

        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, mPassword);

        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, mPassword);
    }

    @Test
    public void nativePermissionFailureFallsBack() {
        when(mWifiManager.getConfiguredNetworks())
                .thenThrow(new SecurityException("not permitted"));

        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, mPassword);

        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, mPassword);
    }

    @Test
    public void missingWifiManagerFallsBack() {
        Context withoutWifi =
                new ContextWrapper(mContext) {
                    @Override
                    public Object getSystemService(String name) {
                        return Context.WIFI_SERVICE.equals(name)
                                ? null
                                : super.getSystemService(name);
                    }
                };

        new K900NetworkManager(withoutWifi, mSystemController).connectToWifi(mSsid, mPassword);

        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, mPassword);
        verifyNoInteractions(mWifiManager);
    }

    @Test
    public void nonSystemAppStillUsesOnlyVendorPath() {
        mApplicationInfo.flags &=
                ~(ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP);

        new K900NetworkManager(mContext, mSystemController).connectToWifi(mSsid, mPassword);

        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, mPassword);
        verifyNoInteractions(mWifiManager);
    }

    @Test
    public void laterAttemptCanUseNativePathAfterAnEarlierRejection() {
        when(mWifiManager.addNetwork(any(WifiConfiguration.class))).thenReturn(-1, 7);
        K900NetworkManager manager = new K900NetworkManager(mContext, mSystemController);

        manager.connectToWifi(mSsid, mPassword);
        manager.connectToWifi("Another network", "another-password");

        verify(mSystemController).connectToWifiWithCredentialRefresh(mSsid, mPassword);
        verify(mSystemController, never())
                .connectToWifiWithCredentialRefresh("Another network", "another-password");
        verify(mWifiManager).enableNetwork(7, true);
        verify(mWifiManager).reconnect();
    }

    @Test
    public void disconnectDoesNotPreventSubsequentNativeConnection() {
        K900NetworkManager manager = new K900NetworkManager(mContext, mSystemController);

        manager.disconnectFromWifi();
        manager.connectToWifi(mSsid, mPassword);

        verify(mWifiManager, times(2)).disconnect();
        verify(mWifiManager).enableNetwork(7, true);
        verify(mWifiManager).reconnect();
        verify(mSystemController, times(2)).cancelPendingWifiConnection();
        verify(mSystemController, never()).connectToWifiWithCredentialRefresh(any(), any());
    }

    @Test
    public void nativeRetryCancelsDelayedVendorRefreshFromEarlierAttempt() {
        Application application = ApplicationProvider.getApplicationContext();
        K900NetworkManager manager =
                new K900NetworkManager(mContext, new MentraLiveSystemController(application));
        when(mWifiManager.addNetwork(any(WifiConfiguration.class))).thenReturn(-1, 7);

        manager.connectToWifi("Old AP", "old-password");
        manager.connectToWifi("New AP", "new-password");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));

        assertThat(shadowOf(application).getBroadcastIntents())
                .filteredOn(
                        intent ->
                                "connectwifi".equals(intent.getStringExtra("cmd"))
                                        || "disconnectwifi".equals(intent.getStringExtra("cmd")))
                .extracting(intent -> intent.getStringExtra("ssid"))
                .containsExactly("Old AP");
        verify(mWifiManager).enableNetwork(7, true);
    }

    @Test
    public void nativeDisconnectCancelsDelayedVendorReconnect() {
        Application application = ApplicationProvider.getApplicationContext();
        K900NetworkManager manager =
                new K900NetworkManager(mContext, new MentraLiveSystemController(application));
        when(mWifiManager.addNetwork(any(WifiConfiguration.class))).thenReturn(-1);

        manager.connectToWifi(mSsid, mPassword);
        manager.disconnectFromWifi();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));

        assertThat(shadowOf(application).getBroadcastIntents())
                .filteredOn(
                        intent ->
                                "connectwifi".equals(intent.getStringExtra("cmd"))
                                        || "disconnectwifi".equals(intent.getStringExtra("cmd")))
                .extracting(intent -> intent.getStringExtra("cmd"))
                .containsExactly("connectwifi");
        verify(mWifiManager).disconnect();
    }

    private WifiConfiguration captureConfiguration() {
        ArgumentCaptor<WifiConfiguration> configuration =
                ArgumentCaptor.forClass(WifiConfiguration.class);
        verify(mWifiManager).addNetwork(configuration.capture());
        return configuration.getValue();
    }
}
