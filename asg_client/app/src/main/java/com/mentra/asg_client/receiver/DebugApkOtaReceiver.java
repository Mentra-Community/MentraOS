package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.io.ota.helpers.OtaHelper;

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
    if (!ACTION_DEBUG_APK_OTA.equals(intent.getAction())) {
      return;
    }

    Log.w(TAG, "========================================");
    Log.w(TAG, "⚠️ DEBUG APK OTA TRIGGERED VIA ADB ⚠️");
    Log.w(TAG, "========================================");

    String url = intent.getStringExtra("url");
    if (url == null || url.isEmpty()) {
      Log.e(TAG, "❌ Missing 'url' extra. Usage:");
      Log.e(TAG, "  adb shell am broadcast -a com.mentra.DEBUG_APK_OTA "
          + "--es url \"http://localhost:8080/version.json\" "
          + "-n com.mentra.asg_client/.receiver.DebugApkOtaReceiver");
      return;
    }

    Log.i(TAG, "Version JSON URL: " + url);

    OtaHelper helper = OtaHelper.getInstance();
    if (helper == null) {
      Log.e(TAG, "❌ OtaHelper not initialized - is OtaService running?");
      return;
    }

    Log.i(TAG, "🚀 Starting APK OTA check with custom URL...");
    helper.setPhoneInitiatedOta(true);
    helper.startVersionCheckWithUrl(context, url);
    Log.i(TAG, "✅ APK OTA check triggered - monitor logcat for progress");
  }
}
