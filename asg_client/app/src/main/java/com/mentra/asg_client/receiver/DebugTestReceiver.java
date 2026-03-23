package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.service.core.processors.CommandProcessor;

import java.nio.charset.StandardCharsets;

/**
 * Debug receiver for triggering ASG commands via ADB without a phone connection.
 * Injects JSON commands directly into CommandProcessor, simulating BLE data from phone.
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_TEST \
 *     -n com.mentra.asg_client/.receiver.DebugTestReceiver \
 *     --es json '{"type":"take_photo","requestId":"test_001"}'
 *
 * FOR DEVELOPMENT/TESTING ONLY.
 */
public class DebugTestReceiver extends BroadcastReceiver {
  private static final String TAG = "DebugTestReceiver";
  public static final String ACTION_DEBUG_TEST = "com.mentra.DEBUG_TEST";

  @Override
  public void onReceive(Context context, Intent intent) {
    if (!ACTION_DEBUG_TEST.equals(intent.getAction())) {
      return;
    }

    String json = intent.getStringExtra("json");
    if (json == null || json.isEmpty()) {
      Log.e(TAG, "No 'json' extra provided. Usage: --es json '{\"type\":\"take_photo\"}'");
      return;
    }

    Log.i(TAG, "Injecting command: " + json);

    CommandProcessor processor = CommandProcessor.getInstance();
    if (processor == null) {
      Log.e(TAG, "CommandProcessor not initialized - is AsgClientService running?");
      return;
    }

    try {
      processor.processCommand(json.getBytes(StandardCharsets.UTF_8));
      Log.i(TAG, "Command injected successfully");
    } catch (Exception e) {
      Log.e(TAG, "Failed to inject command", e);
    }
  }
}
