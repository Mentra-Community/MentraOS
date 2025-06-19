package com.augmentos.otaupdater.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.augmentos.otaupdater.helper.Constants;
import com.augmentos.otaupdater.helper.OtaHelper;

/**
 * Created by markiyurtdas on 22.05.2025.
 */

public class OtaCommandReceiver extends BroadcastReceiver {
    private static final String TAG = OtaCommandReceiver.TAG;


    @Override
    public void onReceive(Context context, Intent intent) {
        Log.d(TAG, "onreceive intent" + intent.getAction());
        if (Constants.ACTION_INSTALL_OTA.equals(intent.getAction())) {
            new OtaHelper(context).installApk(context);
        }
    }
}

/* send command to OTAUpdater
Intent intent = new Intent("com.augmentos.asg_client.ACTION_INSTALL_OTA");
intent.setPackage("com.augmentos.otaupdater"); // target OTA package name
context.sendBroadcast(intent);

* */