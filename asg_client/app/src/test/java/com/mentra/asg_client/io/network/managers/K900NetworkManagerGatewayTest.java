package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;

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
}
