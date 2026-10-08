package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.di.hilt.AsgClientEntryPoint;
import dagger.hilt.android.EntryPointAccessors;

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
    if (!ACTION_DEBUG_MTK_OTA.equals(intent.getAction())) return;
    if (intent.hasExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA)) {
      PendingResult pending = goAsync();
      new Thread(() -> {
        try {
          boolean accepted = EntryPointAccessors.fromApplication(context.getApplicationContext(), AsgClientEntryPoint.class)
              .otaHelper().startValidatedDebugMtkFirmware(
                  intent.getStringExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA),
                  intent.getStringExtra(AsgConstants.DEBUG_MTK_OTA_ARTIFACT_ID_EXTRA));
          Log.i(TAG, accepted ? "Pinned MTK restoration admitted" : "Pinned MTK restoration refused");
        } catch (Exception error) {
          Log.e(TAG, "Pinned MTK restoration failed", error);
        } finally {pending.finish();}
      }, "debug-mtk-ota").start();
      return;
    }
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
