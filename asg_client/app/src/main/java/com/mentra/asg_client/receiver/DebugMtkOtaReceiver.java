package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Debug receiver for testing MTK OTA updates via adb.
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_MTK_OTA \
 *       --es url "http://localhost:8080/version.json" \
 *       -n com.mentra.asg_client/.receiver.DebugMtkOtaReceiver
 *
 * The version JSON URL should point to a server hosting the generated version.json
 * and MTK patch zip. Use test-mtk-ota.sh to automate this with ADB reverse
 * port forwarding.
 *
 * FOR DEVELOPMENT/TESTING ONLY.
 */
public class DebugMtkOtaReceiver extends BroadcastReceiver {
  private static final String TAG = "DebugMtkOtaReceiver";
  public static final String ACTION_DEBUG_MTK_OTA = "com.mentra.DEBUG_MTK_OTA";

  @Override
  public void onReceive(Context context, Intent intent) {
    DebugOtaReceiverSupport.triggerOtaFromUrl(
        context,
        intent,
        ACTION_DEBUG_MTK_OTA,
        TAG,
        "MTK OTA",
        ".receiver.DebugMtkOtaReceiver"
    );
  }
}
