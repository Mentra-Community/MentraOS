package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.wifi.WifiManager;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.network.interfaces.HotspotState;
import com.mentra.asg_client.io.network.interfaces.NetworkStateListener;
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

    @Test
    public void reconciliationKeepsPreviouslyPausedStationNetworksDisabled() {
        android.content.pm.PackageInfo info;
        try {
            info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        } catch (android.content.pm.PackageManager.NameNotFoundException e) {
            throw new AssertionError(e);
        }
        info.applicationInfo.flags |= ApplicationInfo.FLAG_SYSTEM;
        shadowOf(context.getPackageManager()).installPackage(info);
        context.getSharedPreferences("station_autojoin_pause", Context.MODE_PRIVATE)
                .edit()
                .putStringSet("paused_network_ids", java.util.Collections.singleton("7"))
                .commit();
        manager = new NativeHotspot(context);
        manager.gateway = "192.168.43.1";
        manager.startHotspot();

        manager.gateway = "";
        manager.apState = 13;
        manager.startHotspot();
        advance(400);
        assertThat(
                        context.getSharedPreferences("station_autojoin_pause", Context.MODE_PRIVATE)
                                .getStringSet(
                                        "paused_network_ids", java.util.Collections.emptySet()))
                .containsExactly("7");

        manager.stopHotspot();
        assertThat(
                        context.getSharedPreferences("station_autojoin_pause", Context.MODE_PRIVATE)
                                .getStringSet(
                                        "paused_network_ids", java.util.Collections.emptySet()))
                .isEmpty();
    }

    @Test
    public void stopDoesNotHoldLifecycleLockWhileWaitingForServiceListener() throws Exception {
        Object serviceMonitor = new Object();
        NetworkStateListener listener = mock(NetworkStateListener.class);
        doAnswer(
                        invocation -> {
                            synchronized (serviceMonitor) {
                                return null;
                            }
                        })
                .when(listener)
                .onHotspotStateChanged(argThat(state -> !state.enabled()));
        manager.addWifiListener(listener);
        manager.gateway = "192.168.43.1";
        manager.startHotspot();
        advance(0);

        Thread stop = new Thread(manager::stopHotspot);
        boolean finished;
        synchronized (serviceMonitor) {
            stop.start();
            stop.join(2000);
            finished = !stop.isAlive();
            // Service cleanup can acquire the lifecycle lock while holding this monitor.
            if (finished) manager.stopHotspot();
        }
        stop.join(2000);
        assertThat(finished).isTrue();
        advance(0);
        verify(listener).onHotspotStateChanged(argThat(state -> !state.enabled()));
    }

    @Test
    public void newerStopCancelsQueuedReadyNotificationWithoutRestoringCachedState() {
        NetworkStateListener listener = mock(NetworkStateListener.class);
        manager.addWifiListener(listener);
        manager.gateway = "192.168.43.1";
        manager.startHotspot();
        manager.stopHotspot();
        advance(0);
        verify(listener, never()).onHotspotStateChanged(argThat(state -> state.enabled()));
        verify(listener).onHotspotStateChanged(argThat(state -> !state.enabled()));
        assertThat(manager.isHotspotEnabled()).isFalse();
    }

    @Test
    public void stopDuringReadyDeliveryCannotClearTheCommittedEventCredentials() {
        NetworkStateListener listener = mock(NetworkStateListener.class);
        java.util.List<HotspotState> delivered = new java.util.ArrayList<>();
        doAnswer(
                        invocation -> {
                            HotspotState state = invocation.getArgument(0);
                            if (state.enabled()) {
                                Thread stop = new Thread(manager::stopHotspot);
                                stop.start();
                                stop.join(2000);
                                assertThat(stop.isAlive()).isFalse();
                                assertThat(manager.isHotspotEnabled()).isFalse();
                                assertThat(manager.getHotspotSsid()).isEmpty();
                            }
                            // The service consumes the event after stop; it must not reread cleared
                            // getters.
                            delivered.add(state);
                            return null;
                        })
                .when(listener)
                .onHotspotStateChanged(org.mockito.ArgumentMatchers.any());
        manager.addWifiListener(listener);
        manager.gateway = "192.168.43.1";
        manager.startHotspot();
        advance(0);
        assertThat(delivered)
                .containsExactly(
                        new HotspotState(true, "credential", "credential", "192.168.43.1"),
                        new HotspotState(false, "", "", AsgConstants.DEFAULT_HOTSPOT_GATEWAY_IP));
    }

    @Test
    public void nativeCleanupWaitRejectsUnreadableStateWithoutAnotherStart() throws Exception {
        manager.failStateRead = true;
        java.util.concurrent.atomic.AtomicReference<Throwable> failure =
                new java.util.concurrent.atomic.AtomicReference<>();
        Thread worker =
                new Thread(
                        () -> {
                            try {
                                manager.stopHotspotAndAwaitDisabled();
                            } catch (Exception e) {
                                failure.set(e);
                            }
                        });
        worker.start();
        worker.join(2000);
        assertThat(worker.isAlive()).isFalse();
        assertThat(failure.get()).isInstanceOf(IllegalStateException.class);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false);
    }

    @Test
    public void nativeCleanupRunsOnWorkerAndReturnsOnlyAfterDisabledState() throws Exception {
        manager.apState = AsgConstants.WIFI_AP_STATE_DISABLED;
        java.util.concurrent.atomic.AtomicReference<Throwable> failure =
                new java.util.concurrent.atomic.AtomicReference<>();
        Thread worker =
                new Thread(
                        () -> {
                            try {
                                manager.stopHotspotAndAwaitDisabled();
                            } catch (Exception e) {
                                failure.set(e);
                            }
                        });
        worker.start();
        worker.join(2000);
        assertThat(worker.isAlive()).isFalse();
        assertThat(failure.get()).isNull();
        manager.startHotspot();
        advance(1000);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false);
        // A definitive pre-handoff abandonment restores ordinary start admission.
        manager.abandonHotspotReplacement();
        manager.startHotspot();
        advance(500);
        assertThat(commands())
                .extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, false, true);
        manager.gateway = "192.168.43.1";
        advance(200);
        assertThat(manager.isHotspotEnabled()).isTrue();
    }

    @Test
    public void restoredReplacementAdmissionBlocksStartsWithoutRepeatingNativeStop() {
        manager.retainHotspotReplacement();
        manager.startHotspot();
        advance(1000);
        assertThat(commands()).isEmpty();
        manager.abandonHotspotReplacement();
        manager.startHotspot();
        advance(500);
        assertThat(commands()).extracting(i -> i.getBooleanExtra("enable", false))
                .containsExactly(false, true);
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
