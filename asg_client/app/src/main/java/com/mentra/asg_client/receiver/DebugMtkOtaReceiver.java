package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.ota.services.OtaService;
import androidx.core.content.ContextCompat;
import java.nio.charset.StandardCharsets;

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
      String manifest = intent.getStringExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA);
      String artifactId = intent.getStringExtra(AsgConstants.DEBUG_MTK_OTA_ARTIFACT_ID_EXTRA);
      if (manifest == null || manifest.getBytes(StandardCharsets.UTF_8).length > AsgConstants.DEBUG_MTK_OTA_MANIFEST_MAX_BYTES
          || artifactId == null || !artifactId.matches("firmware-[a-f0-9]{32}")) return;
      ContextCompat.startForegroundService(context, new Intent(context, OtaService.class)
          .setAction(ACTION_DEBUG_MTK_OTA)
          .putExtra(AsgConstants.DEBUG_MTK_OTA_MANIFEST_EXTRA, manifest)
          .putExtra(AsgConstants.DEBUG_MTK_OTA_ARTIFACT_ID_EXTRA, artifactId));
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
