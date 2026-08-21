package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class K900NetworkManagerWifiReadinessTest {

    @Test
    public void waitsForWifiUntilTheSharedHotspotDeadline() {
        assertThat(K900NetworkManager.classifyWifiRadioReadiness(false, 500L, 12_000L))
                .isEqualTo(K900NetworkManager.WifiRadioReadiness.WAITING);
        assertThat(K900NetworkManager.classifyWifiRadioReadiness(false, 11_999L, 12_000L))
                .isEqualTo(K900NetworkManager.WifiRadioReadiness.WAITING);
    }

    @Test
    public void proceedsAsSoonAsWifiIsReady() {
        assertThat(K900NetworkManager.classifyWifiRadioReadiness(true, 1_470L, 12_000L))
                .isEqualTo(K900NetworkManager.WifiRadioReadiness.READY);
    }

    @Test
    public void timesOutOnlyAtTheSharedHotspotDeadline() {
        assertThat(K900NetworkManager.classifyWifiRadioReadiness(false, 12_000L, 12_000L))
                .isEqualTo(K900NetworkManager.WifiRadioReadiness.TIMED_OUT);
    }
}
