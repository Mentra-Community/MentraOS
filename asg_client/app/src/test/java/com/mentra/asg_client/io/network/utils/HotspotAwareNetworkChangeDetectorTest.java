package com.mentra.asg_client.io.network.utils;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.webrtc.NetworkChangeDetector;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

public class HotspotAwareNetworkChangeDetectorTest {
    @Before
    public void resetHotspotState() {
        HotspotNetworkUtils.resetHotspotStateForTests();
    }

    @After
    public void clearHotspotState() {
        HotspotNetworkUtils.resetHotspotStateForTests();
    }

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

    @Test
    public void emitsHotspotConnectAndDisconnectLifecycle() throws Exception {
        AtomicReference<HotspotNetworkUtils.HotspotInterface> hotspot = new AtomicReference<>();
        RecordingObserver observer = new RecordingObserver();
        FakeNetworkChangeDetector delegate =
                new FakeNetworkChangeDetector(NetworkChangeDetector.ConnectionType.CONNECTION_NONE);
        HotspotAwareNetworkChangeDetector detector =
                new HotspotAwareNetworkChangeDetector(observer, delegate, hotspot::get);
        try {
            hotspot.set(
                    new HotspotNetworkUtils.HotspotInterface(
                            "ap0", List.of(InetAddress.getByName("192.168.43.1"))));

            HotspotNetworkUtils.notifyHotspotStateChanged(true);
            HotspotNetworkUtils.notifyHotspotStateChanged(true);

            assertThat(observer.connectedNetworks).hasSize(1);
            assertThat(observer.connectedNetworks.get(0).name).isEqualTo("ap0");
            assertThat(observer.connectionTypes)
                    .containsExactly(NetworkChangeDetector.ConnectionType.CONNECTION_WIFI);

            HotspotNetworkUtils.notifyHotspotStateChanged(false);

            assertThat(observer.disconnectedHandles).containsExactly(0L);
            assertThat(detector.getCurrentConnectionType())
                    .isEqualTo(NetworkChangeDetector.ConnectionType.CONNECTION_NONE);
            assertThat(observer.connectionTypes)
                    .containsExactly(
                            NetworkChangeDetector.ConnectionType.CONNECTION_WIFI,
                            NetworkChangeDetector.ConnectionType.CONNECTION_NONE);
        } finally {
            detector.destroy();
        }
        assertThat(delegate.destroyed).isTrue();
    }

    @Test
    public void replaysEnableNotificationMissedDuringConstruction() throws Exception {
        HotspotNetworkUtils.HotspotInterface activeHotspot =
                new HotspotNetworkUtils.HotspotInterface(
                        "ap0", List.of(InetAddress.getByName("192.168.43.1")));
        AtomicReference<HotspotNetworkUtils.HotspotInterface> hotspot = new AtomicReference<>();
        RecordingObserver observer = new RecordingObserver();
        FakeNetworkChangeDetector delegate =
                new FakeNetworkChangeDetector(NetworkChangeDetector.ConnectionType.CONNECTION_NONE);

        HotspotAwareNetworkChangeDetector detector =
                new HotspotAwareNetworkChangeDetector(
                        observer,
                        delegate,
                        () -> {
                            if (hotspot.get() == null) {
                                hotspot.set(activeHotspot);
                                HotspotNetworkUtils.notifyHotspotStateChanged(true);
                                return null;
                            }
                            return hotspot.get();
                        });
        try {
            assertThat(observer.connectedNetworks).hasSize(1);
            assertThat(observer.connectedNetworks.get(0).name).isEqualTo("ap0");
            assertThat(detector.getActiveNetworkList())
                    .extracting(network -> network.name)
                    .containsExactly("ap0");
        } finally {
            detector.destroy();
        }
    }

    @Test
    public void preservesStaConnectionTypeDuringHotspotLifecycle() throws Exception {
        AtomicReference<HotspotNetworkUtils.HotspotInterface> hotspot =
                new AtomicReference<>(
                        new HotspotNetworkUtils.HotspotInterface(
                                "ap0", List.of(InetAddress.getByName("192.168.43.1"))));
        RecordingObserver observer = new RecordingObserver();
        FakeNetworkChangeDetector delegate =
                new FakeNetworkChangeDetector(NetworkChangeDetector.ConnectionType.CONNECTION_WIFI);
        HotspotAwareNetworkChangeDetector detector =
                new HotspotAwareNetworkChangeDetector(observer, delegate, hotspot::get);
        try {
            detector.onHotspotStateChanged(true);
            detector.onHotspotStateChanged(false);

            assertThat(observer.connectedNetworks).hasSize(1);
            assertThat(observer.disconnectedHandles).containsExactly(0L);
            assertThat(observer.connectionTypes).isEmpty();
        } finally {
            detector.destroy();
        }
    }

    @Test
    public void transientMissingInterfaceDoesNotDropPendingDisconnect() throws Exception {
        HotspotNetworkUtils.HotspotInterface activeHotspot =
                new HotspotNetworkUtils.HotspotInterface(
                        "ap0", List.of(InetAddress.getByName("192.168.43.1")));
        AtomicReference<HotspotNetworkUtils.HotspotInterface> hotspot =
                new AtomicReference<>(activeHotspot);
        RecordingObserver observer = new RecordingObserver();
        FakeNetworkChangeDetector delegate =
                new FakeNetworkChangeDetector(NetworkChangeDetector.ConnectionType.CONNECTION_NONE);
        HotspotAwareNetworkChangeDetector detector =
                new HotspotAwareNetworkChangeDetector(observer, delegate, hotspot::get);
        try {
            assertThat(detector.getActiveNetworkList())
                    .extracting(network -> network.name)
                    .containsExactly("ap0");

            hotspot.set(null);
            assertThat(detector.getActiveNetworkList()).isEmpty();

            hotspot.set(activeHotspot);
            assertThat(detector.getActiveNetworkList())
                    .extracting(network -> network.name)
                    .containsExactly("ap0");

            hotspot.set(null);
            assertThat(detector.getActiveNetworkList()).isEmpty();
            HotspotNetworkUtils.notifyHotspotStateChanged(false);

            assertThat(observer.disconnectedHandles).containsExactly(0L);
            assertThat(detector.getCurrentConnectionType())
                    .isEqualTo(NetworkChangeDetector.ConnectionType.CONNECTION_NONE);
        } finally {
            detector.destroy();
        }
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

    private static final class RecordingObserver extends NetworkChangeDetector.Observer {
        final List<NetworkChangeDetector.ConnectionType> connectionTypes = new ArrayList<>();
        final List<NetworkChangeDetector.NetworkInformation> connectedNetworks = new ArrayList<>();
        final List<Long> disconnectedHandles = new ArrayList<>();

        @Override
        public void onConnectionTypeChanged(
                NetworkChangeDetector.ConnectionType newConnectionType) {
            connectionTypes.add(newConnectionType);
        }

        @Override
        public void onNetworkConnect(NetworkChangeDetector.NetworkInformation networkInfo) {
            connectedNetworks.add(networkInfo);
        }

        @Override
        public void onNetworkDisconnect(long networkHandle) {
            disconnectedHandles.add(networkHandle);
        }

        @Override
        public void onNetworkPreference(
                List<NetworkChangeDetector.ConnectionType> types, int preference) {}
    }

    private static final class FakeNetworkChangeDetector implements NetworkChangeDetector {
        private final ConnectionType connectionType;
        boolean destroyed;

        FakeNetworkChangeDetector(ConnectionType connectionType) {
            this.connectionType = connectionType;
        }

        @Override
        public ConnectionType getCurrentConnectionType() {
            return connectionType;
        }

        @Override
        public boolean supportNetworkCallback() {
            return true;
        }

        @Override
        public List<NetworkInformation> getActiveNetworkList() {
            return Collections.emptyList();
        }

        @Override
        public void destroy() {
            destroyed = true;
        }
    }
}
