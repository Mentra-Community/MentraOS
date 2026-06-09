package com.mentra.asg_client.io.bluetooth.managers;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import com.mentra.asg_client.BuildConfig;

/**
 * Manifest-registered receiver so {@code adb shell am broadcast} can toggle {@link
 * BleTransferMode} in debug builds. No-op in release.
 */
public class BleTransferModeReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!BuildConfig.DEBUG) {
            return;
        }
        BleTransferMode.handleIntent(intent);
    }
}
