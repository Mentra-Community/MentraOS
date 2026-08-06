package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;

import android.net.wifi.WifiManager;
import com.mentra.asg_client.AsgConstants;
import org.junit.Test;

public class K900NetworkManagerGatewayTest {

    @Test
    public void acceptsRenamedApInterfacesAndTheKnownK900Gateway() {
        assertThat(K900NetworkManager.isLocalHotspotAddress("ap1", "192.168.44.1")).isTrue();
        assertThat(
                        K900NetworkManager.isLocalHotspotAddress(
                                "wlan1", AsgConstants.DEFAULT_HOTSPOT_GATEWAY_IP))
                .isTrue();
    }

    @Test
    public void rejectsTheStationInterfaceAtAnUnrelatedAddress() {
        assertThat(K900NetworkManager.isLocalHotspotAddress("wlan0", "192.168.1.24"))
                .isFalse();
    }

    @Test
    public void retriesIncompatibleModeOnceAfterDisconnectingStationWifi() {
        int incompatibleMode = WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE;

        assertThat(
                        K900NetworkManager.shouldRetryLocalHotspotAfterDisconnect(
                                incompatibleMode, false))
                .isTrue();
        assertThat(
                        K900NetworkManager.shouldRetryLocalHotspotAfterDisconnect(
                                incompatibleMode, true))
                .isFalse();
    }

    @Test
    public void reservesTimeToPublishReadinessBeforeThePhoneDeadline() {
        assertThat(AsgConstants.LOCAL_HOTSPOT_STARTUP_TIMEOUT_MS).isEqualTo(28_000L);
        assertThat(K900NetworkManager.calculateLocalHotspotReadinessDeadline(30_000L, 20_000L))
                .isEqualTo(29_000L);
        assertThat(K900NetworkManager.calculateLocalHotspotReadinessDeadline(40_000L, 3_000L))
                .isEqualTo(15_000L);
    }

    @Test
    public void publishesAReadyGatewayOnlyBeforeThePhoneDeadline() {
        assertThat(K900NetworkManager.canPublishLocalHotspotReady(true, 14_500L, 15_000L))
                .isTrue();
        assertThat(K900NetworkManager.canPublishLocalHotspotReady(true, 15_000L, 15_000L))
                .isFalse();
        assertThat(K900NetworkManager.canPublishLocalHotspotReady(false, 14_500L, 15_000L))
                .isFalse();
    }

    @Test
    public void restoresStationWifiAfterActiveReservationReportsStopped() {
        assertThat(K900NetworkManager.shouldReconnectStationWifiImmediately(true, false, true))
                .isFalse();
        assertThat(K900NetworkManager.shouldReconnectStationWifiImmediately(false, true, true))
                .isFalse();
        assertThat(K900NetworkManager.shouldReconnectStationWifiImmediately(false, false, true))
                .isTrue();
        assertThat(K900NetworkManager.shouldReconnectStationWifiImmediately(false, false, false))
                .isFalse();
    }

    @Test
    public void queuesRestartDuringTheExplicitCloseWindow() {
        assertThat(K900NetworkManager.shouldQueueLocalHotspotRestart(true)).isTrue();
        assertThat(K900NetworkManager.shouldQueueLocalHotspotRestart(false)).isFalse();
    }

    @Test
    public void treatsGatewayReadinessAsAnInProgressHotspotStart() {
        assertThat(K900NetworkManager.isLocalHotspotTransitioning(false, false, true, false))
                .isTrue();
        assertThat(K900NetworkManager.isLocalHotspotTransitioning(false, false, true, true))
                .isFalse();
    }

    @Test
    public void defersStoppedStateWhileAReservationIsClosing() {
        assertThat(K900NetworkManager.shouldDeferLocalHotspotStopped(true, false)).isTrue();
        assertThat(K900NetworkManager.shouldDeferLocalHotspotStopped(false, true)).isTrue();
        assertThat(K900NetworkManager.shouldDeferLocalHotspotStopped(false, false)).isFalse();
    }

    @Test
    public void doesNotRetryUnrelatedHotspotFailures() {
        assertThat(
                        K900NetworkManager.shouldRetryLocalHotspotAfterDisconnect(
                                WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL, false))
                .isFalse();
    }
}
