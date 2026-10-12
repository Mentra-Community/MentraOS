package com.mentra.asg_client.io.network.managers;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.util.Log;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Keeps the glasses off station Wi-Fi while they host a hotspot.
 *
 * <p>The K900 radio carries the hotspot and the station link on one channel. When Android
 * auto-joins a saved network mid-call (commonly the phone's own Mobile Hotspot), the access point
 * is retuned to follow it and the phone is dropped from the call hotspot. Saved networks are
 * disabled for the life of the hotspot and restored afterwards. The paused ids are persisted so a
 * crash or reinstall while paused cannot strand the glasses off their Wi-Fi.
 */
final class StationAutojoinPause {
    private static final String TAG = "StationAutojoinPause";
    private static final String PREFS = "station_autojoin_pause";
    private static final String KEY_PAUSED_IDS = "paused_network_ids";

    interface Wifi {
        List<Integer> enabledNetworkIds();

        boolean disable(int networkId);

        boolean enable(int networkId);

        void disconnect();

        void reconnect();
    }

    interface Store {
        Set<Integer> load();

        void save(Set<Integer> networkIds);
    }

    private final Wifi mWifi;
    private final Store mStore;

    StationAutojoinPause(Wifi wifi, Store store) {
        mWifi = wifi;
        mStore = store;
    }

    static StationAutojoinPause create(Context context, WifiManager wifiManager) {
        return new StationAutojoinPause(
                new SystemWifi(wifiManager), new PrefsStore(context.getApplicationContext()));
    }

    /** Disable every enabled saved network. A second call while paused does nothing. */
    synchronized void pause() {
        if (!mStore.load().isEmpty()) return;
        Set<Integer> paused = new HashSet<>();
        for (int networkId : mWifi.enabledNetworkIds()) {
            if (mWifi.disable(networkId)) paused.add(networkId);
        }
        if (paused.isEmpty()) return;
        mStore.save(paused);
        mWifi.disconnect();
        Log.i(TAG, "Paused station auto-join for " + paused.size() + " saved network(s)");
    }

    /** Re-enable the networks a previous pause disabled, including one from an earlier process. */
    synchronized void resume() {
        Set<Integer> paused = mStore.load();
        if (paused.isEmpty()) return;
        for (int networkId : paused) mWifi.enable(networkId);
        mStore.save(new HashSet<>());
        mWifi.reconnect();
        Log.i(TAG, "Restored station auto-join for " + paused.size() + " saved network(s)");
    }

    private static final class SystemWifi implements Wifi {
        private final WifiManager mWifiManager;

        SystemWifi(WifiManager wifiManager) {
            mWifiManager = wifiManager;
        }

        @Override
        @SuppressWarnings("deprecation")
        public List<Integer> enabledNetworkIds() {
            List<Integer> ids = new ArrayList<>();
            if (mWifiManager == null) return ids;
            try {
                List<WifiConfiguration> configs = mWifiManager.getConfiguredNetworks();
                if (configs == null) return ids;
                for (WifiConfiguration config : configs) {
                    if (config.status != WifiConfiguration.Status.DISABLED) ids.add(config.networkId);
                }
            } catch (SecurityException e) {
                Log.w(TAG, "Cannot read saved networks", e);
            }
            return ids;
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean disable(int networkId) {
            return mWifiManager != null && mWifiManager.disableNetwork(networkId);
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean enable(int networkId) {
            return mWifiManager != null && mWifiManager.enableNetwork(networkId, false);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void disconnect() {
            if (mWifiManager != null) mWifiManager.disconnect();
        }

        @Override
        @SuppressWarnings("deprecation")
        public void reconnect() {
            if (mWifiManager != null) mWifiManager.reconnect();
        }
    }

    private static final class PrefsStore implements Store {
        private final SharedPreferences mPrefs;

        PrefsStore(Context context) {
            mPrefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        }

        @Override
        public Set<Integer> load() {
            Set<Integer> ids = new HashSet<>();
            for (String value : mPrefs.getStringSet(KEY_PAUSED_IDS, new HashSet<>())) {
                try {
                    ids.add(Integer.parseInt(value));
                } catch (NumberFormatException ignored) {
                    // A corrupt entry cannot name a network to restore.
                }
            }
            return ids;
        }

        @Override
        public void save(Set<Integer> networkIds) {
            Set<String> values = new HashSet<>();
            for (int id : networkIds) values.add(Integer.toString(id));
            mPrefs.edit().putStringSet(KEY_PAUSED_IDS, values).commit();
        }
    }
}
