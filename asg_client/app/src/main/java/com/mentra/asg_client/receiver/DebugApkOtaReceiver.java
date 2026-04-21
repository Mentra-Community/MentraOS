package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Debug receiver for testing APK OTA updates via adb.
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_APK_OTA \
 *       --es url "http://localhost:8080/version.json" \
 *       -n com.mentra.asg_client/.receiver.DebugApkOtaReceiver
 *
 * The version JSON URL should point to a server hosting both the JSON and APK.
 * Use test-apk-ota.sh to automate this with ADB reverse port forwarding.
 *
 * FOR DEVELOPMENT/TESTING ONLY.
 */
public class DebugApkOtaReceiver extends BroadcastReceiver {
  private static final String TAG = "DebugApkOtaReceiver";
  public static final String ACTION_DEBUG_APK_OTA = "com.mentra.DEBUG_APK_OTA";

  @Override
  public void onReceive(Context context, Intent intent) {
    DebugOtaReceiverSupport.triggerOtaFromUrl(
        context,
        intent,
        ACTION_DEBUG_APK_OTA,
        TAG,
        "APK OTA",
        ".receiver.DebugApkOtaReceiver"
    );
  }
}
