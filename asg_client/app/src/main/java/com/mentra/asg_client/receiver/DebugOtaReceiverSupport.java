package com.mentra.asg_client.receiver;

import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.di.hilt.AsgClientEntryPoint;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import dagger.hilt.android.EntryPointAccessors;

final class DebugOtaReceiverSupport {
    private DebugOtaReceiverSupport() {}

    static void triggerOtaFromUrl(
            Context context,
            Intent intent,
            String expectedAction,
            String tag,
            String flowLabel,
            String receiverComponent) {
        if (!expectedAction.equals(intent.getAction())) {
            return;
        }

        Log.w(tag, "========================================");
        Log.w(tag, "⚠️ DEBUG " + flowLabel + " TRIGGERED VIA ADB ⚠️");
        Log.w(tag, "========================================");

        String url = intent.getStringExtra("url");
        if (url == null || url.isEmpty()) {
            Log.e(tag, "❌ Missing 'url' extra. Usage:");
            Log.e(
                    tag,
                    "  adb shell am broadcast -a "
                            + expectedAction
                            + " --es url \"http://localhost:8080/version.json\" "
                            + "-n "
                            + context.getPackageName()
                            + "/"
                            + receiverComponent);
            return;
        }

        Log.i(tag, "Version JSON URL: " + url);

        OtaHelper helper =
                EntryPointAccessors.fromApplication(context, AsgClientEntryPoint.class).otaHelper();
        if (helper == null) {
            Log.e(tag, "❌ OtaHelper not initialized - is OtaService running?");
            return;
        }

        Log.i(tag, "🚀 Starting " + flowLabel + " with custom OTA URL...");
        if (helper.startVersionCheckWithUrl(context, url)) {
            Log.i(tag, "✅ " + flowLabel + " trigger dispatched - monitor logcat for progress");
        } else {
            Log.e(tag, "❌ " + flowLabel + " trigger refused because OTA admission is busy");
        }
    }
}
