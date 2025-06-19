package com.augmentos.augmentos_core.augmentos_backend;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.util.Log;

public class NetworkMonitor {
    private static final String TAG = "NetworkMonitor";
    private final Context context;
    private final ConnectivityManager connectivityManager;
    private final NetworkCallback networkCallback;
    private final NetworkChangeListener listener;
    private boolean isNetworkAvailable = false;

    public interface NetworkChangeListener {
        void onNetworkAvailable();
        void onNetworkUnavailable();
    }

    private class NetworkCallback extends ConnectivityManager.NetworkCallback {
        @Override
        public void onAvailable(Network network) {
            Log.d(TAG, "Network is available");
            isNetworkAvailable = true;
            listener.onNetworkAvailable();
        }

        @Override
        public void onLost(Network network) {
            Log.d(TAG, "Network is unavailable");
            isNetworkAvailable = false;
            listener.onNetworkUnavailable();
        }
    }

    public NetworkMonitor(Context context, NetworkChangeListener listener) {
        this.context = context;
        this.listener = listener;
        this.connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        this.networkCallback = new NetworkCallback();

        // Check initial network state
        isNetworkAvailable = isNetworkCurrentlyAvailable();

        if (isNetworkAvailable) {
            listener.onNetworkAvailable();
        } else {
            listener.onNetworkUnavailable();
        }
    }

    public void register() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } else {
            NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            connectivityManager.registerNetworkCallback(request, networkCallback);
        }
    }

    public void unregister() {
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback);
        } catch (IllegalArgumentException e) {
            // Network callback was not registered or already unregistered
            Log.e(TAG, "Error unregistering network callback", e);
        }
    }

    public boolean isNetworkCurrentlyAvailable() {
        if (connectivityManager == null) return false;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Network network = connectivityManager.getActiveNetwork();
            if (network == null) return false;

            NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
            return capabilities != null &&
                    (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
        } else {
            @SuppressWarnings("deprecation")
            android.net.NetworkInfo activeNetworkInfo = connectivityManager.getActiveNetworkInfo();
            return activeNetworkInfo != null && activeNetworkInfo.isConnected();
        }
    }
}