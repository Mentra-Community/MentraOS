package com.mentra.asg_client.io.network.managers;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class StationAutojoinPauseTest {

    private static final class FakeWifi implements StationAutojoinPause.Wifi {
        final Set<Integer> enabled = new HashSet<>();
        final List<String> calls = new ArrayList<>();
        final Set<Integer> refuseDisable = new HashSet<>();

        @Override
        public List<Integer> enabledNetworkIds() {
            return new ArrayList<>(enabled);
        }

        @Override
        public boolean disable(int networkId) {
            if (refuseDisable.contains(networkId)) return false;
            enabled.remove(networkId);
            calls.add("disable " + networkId);
            return true;
        }

        @Override
        public boolean enable(int networkId) {
            enabled.add(networkId);
            calls.add("enable " + networkId);
            return true;
        }

        @Override
        public void disconnect() {
            calls.add("disconnect");
        }

        @Override
        public void reconnect() {
            calls.add("reconnect");
        }
    }

    private static final class MemoryStore implements StationAutojoinPause.Store {
        Set<Integer> ids = new HashSet<>();

        @Override
        public Set<Integer> load() {
            return new HashSet<>(ids);
        }

        @Override
        public void save(Set<Integer> networkIds) {
            ids = new HashSet<>(networkIds);
        }
    }

    @Test
    public void disablesSavedNetworksForTheHotspotAndRestoresThemAfter() {
        FakeWifi wifi = new FakeWifi();
        wifi.enabled.addAll(Arrays.asList(0, 3));
        MemoryStore store = new MemoryStore();
        StationAutojoinPause pause = new StationAutojoinPause(wifi, store);

        pause.pause();
        assertThat(wifi.enabled).isEmpty();
        assertThat(wifi.calls).contains("disconnect");
        assertThat(store.ids).containsExactlyInAnyOrder(0, 3);

        pause.resume();
        assertThat(wifi.enabled).containsExactlyInAnyOrder(0, 3);
        assertThat(wifi.calls).endsWith("reconnect");
        assertThat(store.ids).isEmpty();
    }

    @Test
    public void aRepeatedPauseKeepsTheOriginalListToRestore() {
        FakeWifi wifi = new FakeWifi();
        wifi.enabled.add(0);
        MemoryStore store = new MemoryStore();
        StationAutojoinPause pause = new StationAutojoinPause(wifi, store);

        pause.pause();
        wifi.enabled.add(7);
        pause.pause();

        assertThat(store.ids).containsExactly(0);
    }

    @Test
    public void restoresAPauseLeftByAnEarlierProcess() {
        FakeWifi wifi = new FakeWifi();
        MemoryStore store = new MemoryStore();
        store.ids.add(5);

        new StationAutojoinPause(wifi, store).resume();

        assertThat(wifi.enabled).containsExactly(5);
        assertThat(store.ids).isEmpty();
    }

    @Test
    public void doesNothingWithoutSavedNetworksOrWhenNothingCouldBeDisabled() {
        FakeWifi wifi = new FakeWifi();
        wifi.enabled.add(2);
        wifi.refuseDisable.add(2);
        MemoryStore store = new MemoryStore();
        StationAutojoinPause pause = new StationAutojoinPause(wifi, store);

        pause.pause();
        pause.resume();

        assertThat(wifi.calls).isEmpty();
        assertThat(store.ids).isEmpty();
    }
}
