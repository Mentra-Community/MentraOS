package com.augmentos.augmentos_core.statushelpers;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;

public class WifiStatusHelper {
    private final WifiManager wifiManager;
    private final ConnectivityManager connectivityManager;

    public WifiStatusHelper(Context context) {
        this.wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        this.connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    public boolean isWifiConnected() {
        NetworkInfo networkInfo = connectivityManager.getNetworkInfo(ConnectivityManager.TYPE_WIFI);
        return networkInfo != null && networkInfo.isConnected();
    }

    public String getSSID() {
        WifiInfo wifiInfo = wifiManager.getConnectionInfo();
        return wifiInfo != null && isWifiConnected() ? wifiInfo.getSSID() : null;
    }

    public int getSignalStrength() {
        WifiInfo wifiInfo = wifiManager.getConnectionInfo();
        return wifiInfo != null && isWifiConnected() ? WifiManager.calculateSignalLevel(wifiInfo.getRssi(), 100) : -1;
    }
}
