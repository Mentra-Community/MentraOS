package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.service.system.interfaces.ISystemController;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

import java.time.Duration;
import java.util.List;
import java.util.stream.Collectors;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class K900NetworkManagerHotspotLifecycleTest {
    private Context context;
    private WifiManager wifi;
    private NativeHotspot manager;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        wifi.setWifiEnabled(false);
        manager = new NativeHotspot(context);
    }

    @Test
    public void stopsStaleRadioOffApBeforeEnablingRadioAndStartingOnce() {
        manager.apState = 13;
        manager.startHotspot();
        manager.startHotspot();
        advance(400);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false);
        assertThat(wifi.isWifiEnabled()).isFalse();
        assertThat(manager.isHotspotEnabled()).isFalse();

        manager.apState = AsgConstants.WIFI_AP_STATE_DISABLED;
        advance(200);
        assertThat(wifi.isWifiEnabled()).isTrue();
        advance(500);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, true);
        assertThat(manager.isHotspotEnabled()).isFalse();

        manager.gateway = "192.168.43.1";
        advance(200);
        assertThat(manager.isHotspotEnabled()).isTrue();
        assertThat(manager.getHotspotGatewayIp()).isEqualTo(manager.gateway);
        for (Intent command : commands()) {
            assertThat(command.getComponent().getClassName())
                    .isEqualTo(AsgConstants.K900_SYSTEM_UI_RECEIVER);
            assertThat(command.getFlags() & AsgConstants.K900_INCLUDE_BACKGROUND_RECEIVERS)
                    .isNotZero();
        }
    }

    @Test
    public void adoptsReadyApAcrossProcessReplacementWithoutRestartingIt() {
        manager.gateway = "192.168.43.1";
        manager.startHotspot();
        manager.startHotspot();
        assertThat(manager.isHotspotEnabled()).isTrue();
        assertThat(commands()).isEmpty();
    }

    @Test
    public void stopCancelsPendingStartupEvenWhenCachedStateIsFalse() {
        manager.apState = 13;
        manager.startHotspot();
        manager.stopHotspot();
        manager.apState = AsgConstants.WIFI_AP_STATE_DISABLED;
        advance(13_000);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, false);
        assertThat(wifi.isWifiEnabled()).isFalse();
        assertThat(manager.isHotspotEnabled()).isFalse();
    }

    @Test
    public void stopThenStartDoesNotReadoptAnApStillStopping() {
        wifi.setWifiEnabled(true);
        manager.gateway = "192.168.43.1";
        manager.startHotspot();
        manager.stopHotspot();
        manager.apState = 10;
        manager.startHotspot();
        advance(400);
        assertThat(manager.isHotspotEnabled()).isFalse();
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, false);
        manager.gateway = "";
        manager.apState = AsgConstants.WIFI_AP_STATE_DISABLED;
        advance(200);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, false, true);
    }

    @Test
    public void repeatedStartDoesNotExtendDeadlineOrStartBeforeNativeStop() {
        manager.apState = 13;
        manager.startHotspot();
        advance(11_800);
        manager.startHotspot();
        advance(200);
        manager.apState = AsgConstants.WIFI_AP_STATE_DISABLED;
        advance(1000);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, false);
        assertThat(wifi.isWifiEnabled()).isFalse();
    }

    @Test
    public void stopDuringRadioWaitCannotStartFromOldCallback() {
        manager.apState = AsgConstants.WIFI_AP_STATE_DISABLED;
        manager.startHotspot();
        manager.stopHotspot();
        advance(1000);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, false);
        assertThat(manager.isHotspotEnabled()).isFalse();
    }

    @Test
    public void unreadableNativeStateFailsWithoutEnablingOrStarting() {
        manager.failStateRead = true;
        manager.startHotspot();
        advance(13_000);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, false);
        assertThat(wifi.isWifiEnabled()).isFalse();
        assertThat(manager.isHotspotEnabled()).isFalse();
    }

    private void advance(long millis) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis));
    }

    private List<Intent> commands() {
        return shadowOf((android.app.Application) context).getBroadcastIntents().stream()
                .filter(i -> "ap_start".equals(i.getStringExtra("cmd")))
                .collect(Collectors.toList());
    }

    private static class NativeHotspot extends K900NetworkManager {
        int apState = AsgConstants.WIFI_AP_STATE_DISABLED;
        String gateway = "";
        boolean failStateRead;

        NativeHotspot(Context context) {
            super(context, mock(ISystemController.class));
        }

        @Override
        int readVendorHotspotState() throws Exception {
            if (failStateRead) throw new IllegalStateException("native state unavailable");
            return apState;
        }

        @Override
        String findLocalHotspotGatewayIp() {
            return gateway;
        }

        @Override
        String readVendorHotspotSetting(String key) {
            return "credential";
        }
    }
}
