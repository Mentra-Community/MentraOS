package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.di.hilt.AsgClientEntryPoint;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import dagger.hilt.android.EntryPointAccessors;
import java.io.File;

/**
 * Debug receiver for testing BES firmware updates directly via adb.
 *
 * <p>Usage: 1. Push firmware file: adb push firmware.bin /storage/emulated/0/asg/bes_firmware.bin
 * 2. Trigger update: adb shell am broadcast -a com.mentra.DEBUG_BES_OTA
 *
 * <p>This bypasses all cloud/phone logic and directly triggers BesOtaManager. FOR
 * DEVELOPMENT/TESTING ONLY.
 */
public class DebugBesOtaReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugBesOtaReceiver";
    public static final String ACTION_DEBUG_BES_OTA = "com.mentra.DEBUG_BES_OTA";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DEBUG_BES_OTA.equals(intent.getAction())) {
            return;
        }

        Log.w(TAG, "========================================");
        Log.w(TAG, "⚠️ DEBUG BES OTA TRIGGERED VIA ADB ⚠️");
        Log.w(TAG, "========================================");

        // Check if file exists
        File firmwareFile = new File(OtaConstants.BES_FIRMWARE_PATH);
        if (!firmwareFile.exists()) {
            Log.e(TAG, "❌ Firmware file not found at: " + OtaConstants.BES_FIRMWARE_PATH);
            Log.e(
                    TAG,
                    "Push file first: adb push firmware.bin /storage/emulated/0/asg/bes_firmware.bin");
            return;
        }

        Log.i(TAG, "✅ Firmware file found: " + firmwareFile.length() + " bytes");

        // Get the active BES OTA controller
        IBesOtaController manager =
                EntryPointAccessors.fromApplication(context, AsgClientEntryPoint.class)
                        .besOtaRegistry()
                        .getInstance();
        if (manager == null) {
            Log.e(TAG, "❌ BES OTA controller not initialized - is AsgClientService running?");
            return;
        }

        // Check if already in progress
        if (manager.isBesOtaInProgress()) {
            Log.w(TAG, "⚠️ BES OTA already in progress - skipping");
            return;
        }

        // Start the update
        Log.i(TAG, "🚀 Starting BES firmware update...");
        boolean started = manager.startFirmwareUpdate(OtaConstants.BES_FIRMWARE_PATH);

        if (started) {
            Log.i(TAG, "✅ BES OTA started - monitor logcat for progress");
        } else {
            Log.e(TAG, "❌ BES OTA failed to start");
        }
    }
}
