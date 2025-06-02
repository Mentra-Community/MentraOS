package com.augmentos.otaupdater.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.util.Log;

import com.augmentos.otaupdater.helper.OtaHelper;
import com.augmentos.otaupdater.helper.Constants;

public class WifiConnectedReceiver extends BroadcastReceiver {
    private static final String TAG = "WifiConnectedReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        Log.d(TAG, "onReceive: " + intent.getAction());
        if (ConnectivityManager.CONNECTIVITY_ACTION.equals(intent.getAction())) {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                NetworkInfo networkInfo = cm.getActiveNetworkInfo();
                if (networkInfo != null && networkInfo.isConnected() && networkInfo.getType() == ConnectivityManager.TYPE_WIFI) {
                    Log.d(TAG, "WiFi connected. Triggering immediate OTA check.");
                    new OtaHelper().startVersionCheck(context);
                }
            }
        }
    }
} 