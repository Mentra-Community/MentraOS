package com.mentra.asg_client.io.network.utils;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetAddress;
import java.util.Collections;
import java.util.List;
import org.junit.Test;
import org.webrtc.NetworkChangeDetector;

public class HotspotAwareNetworkChangeDetectorTest {
    @Test
    public void exposesHotspotAsLocalWifiNetwork() throws Exception {
        HotspotNetworkUtils.HotspotInterface hotspot =
                new HotspotNetworkUtils.HotspotInterface(
                        "ap0", List.of(InetAddress.getByName("192.168.43.1")));

        NetworkChangeDetector.NetworkInformation network =
                HotspotAwareNetworkChangeDetector.createNetworkInformation(hotspot);

        assertThat(network).isNotNull();
        assertThat(network.name).isEqualTo("ap0");
        assertThat(network.type).isEqualTo(NetworkChangeDetector.ConnectionType.CONNECTION_WIFI);
        assertThat(network.handle).isZero();
        assertThat(network.ipAddresses).hasSize(1);
        assertThat(network.ipAddresses[0].address)
                .containsExactly(InetAddress.getByName("192.168.43.1").getAddress());
    }

    @Test
    public void keepsStaNetworkAndAddsHotspotNetwork() throws Exception {
        NetworkChangeDetector.NetworkInformation staNetwork =
                network("wlan0", 42L, "192.168.1.109");
        HotspotNetworkUtils.HotspotInterface hotspot =
                new HotspotNetworkUtils.HotspotInterface(
                        "ap0", List.of(InetAddress.getByName("192.168.43.1")));

        List<NetworkChangeDetector.NetworkInformation> networks =
                HotspotAwareNetworkChangeDetector.mergeNetworks(List.of(staNetwork), hotspot);

        assertThat(networks).extracting(network -> network.name).containsExactly("wlan0", "ap0");
        assertThat(networks.get(0)).isSameAs(staNetwork);
    }

    @Test
    public void doesNotDuplicateHotspotAlreadyReportedByAndroid() throws Exception {
        NetworkChangeDetector.NetworkInformation hotspotNetwork =
                network("ap0", 42L, "192.168.43.1");
        HotspotNetworkUtils.HotspotInterface hotspot =
                new HotspotNetworkUtils.HotspotInterface(
                        "ap0", List.of(InetAddress.getByName("192.168.43.1")));

        List<NetworkChangeDetector.NetworkInformation> networks =
                HotspotAwareNetworkChangeDetector.mergeNetworks(List.of(hotspotNetwork), hotspot);

        assertThat(networks).containsExactly(hotspotNetwork);
    }

    @Test
    public void leavesDetectedNetworksUnchangedWithoutHotspot() throws Exception {
        NetworkChangeDetector.NetworkInformation staNetwork =
                network("wlan0", 42L, "192.168.1.109");

        List<NetworkChangeDetector.NetworkInformation> networks =
                HotspotAwareNetworkChangeDetector.mergeNetworks(List.of(staNetwork), null);

        assertThat(networks).containsExactly(staNetwork);
    }

    @Test
    public void ignoresHotspotWithoutUsableAddresses() {
        HotspotNetworkUtils.HotspotInterface hotspot =
                new HotspotNetworkUtils.HotspotInterface("ap0", Collections.emptyList());

        assertThat(HotspotAwareNetworkChangeDetector.createNetworkInformation(hotspot)).isNull();
    }

    private static NetworkChangeDetector.NetworkInformation network(
            String name, long handle, String address) throws Exception {
        return new NetworkChangeDetector.NetworkInformation(
                name,
                NetworkChangeDetector.ConnectionType.CONNECTION_WIFI,
                NetworkChangeDetector.ConnectionType.CONNECTION_NONE,
                handle,
                new NetworkChangeDetector.IPAddress[] {
                    new NetworkChangeDetector.IPAddress(InetAddress.getByName(address).getAddress())
                });
    }
}
